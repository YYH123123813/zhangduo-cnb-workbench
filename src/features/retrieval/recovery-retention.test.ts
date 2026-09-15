import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import type { NavigationProps } from '../../contracts/navigation';
import type { RecoveryAnchor, RecoveryAnchorInput } from '../../contracts/recovery-anchor';
import { contentHash, hashModelInput } from '../../contracts/hash';
import { createAnswerFlow, answerLeaveState, type AnswerCall } from './answer-client';
import { latestRead } from './client-state';
import { request } from './test-support';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerPanel } from './answer-view';

const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, data, meta: { requestId: 'retention-test', mode: 'fixture', contractVersion: '1.26.0' } });
async function saved(input: RecoveryAnchorInput): Promise<RecoveryAnchor> {
  return { id: await contentHash([input.feature, input.operation]), feature: input.feature, operation: input.operation, binding: input.binding,
    actorId: 'u1', workspaceId: 'w1', createdAt: new Date().toISOString(), expiresAt: input.expiresAt, readOnly: true };
}
async function setup() {
  const input = { purpose: 'answer' as const, text: 'PRIVATE original model input', sourceIds: ['s-n1'] };
  const preview = { input, contentHash: await hashModelInput(input), objectIds: ['n1'], baseRevision: 'fixture-r1' };
  const approval = { id: 'actual-approval-id', actorId: 'u1', workspaceId: 'w1', purpose: 'model_input', objectIds: preview.objectIds,
    contentHash: preview.contentHash, baseRevision: preview.baseRevision, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 172800000).toISOString() };
  const events: string[] = [];
  const retain = vi.fn<NonNullable<NavigationProps['retainOperationRecovery']>>(async (value) => { events.push('retain'); return { ok: true, data: await saved(value) }; });
  const call = vi.fn<AnswerCall>(async (path) => { events.push(path); return ok(path.endsWith('/preview') ? preview : approval); });
  const flow = createAnswerFlow({ request, actorId: 'u1', reader: latestRead(), call, retainOperationRecovery: retain,
    onState: vi.fn(), onResult: vi.fn(), onFailure: vi.fn() });
  await flow.preview();
  return { flow, call, retain, preview, approval, events };
}
afterEach(() => vi.useRealTimers());

describe('1.26 answer recovery retention consent, no actual network', () => {
  it('keeps recovery retention independent from model consent and off by default', async () => {
    const f = await setup(); await f.flow.approve(false, true); expect(f.retain).not.toHaveBeenCalled();
    await f.flow.approve(true); expect(f.retain).not.toHaveBeenCalled(); expect(f.flow.state.phase).toBe('approved');
  });
  it('renders an independently labelled unchecked retention checkbox even when model consent is checked', async () => {
    const f = await setup();
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state: f.flow.state, confirmed: true, onConfirm: vi.fn(),
      onPreview: vi.fn(), onApprove: vi.fn(), onSend: vi.fn(), onCancel: vi.fn(), onRetainConfirm: vi.fn() }));
    const inputs = html.match(/<input\b[^>]+>/g) ?? [];
    expect(inputs).toHaveLength(2); expect(inputs[0]).toContain('checked'); expect(inputs[1]).not.toContain('checked');
    expect(html).toContain('单独同意保留原操作身份 24 小时');
  });
  it('retains and checks the original registration identity before the approval POST', async () => {
    const f = await setup(); await f.flow.approve(true, true);
    expect(f.events).toEqual(['/api/retrieval/answer/preview', 'retain', '/api/workspace/approvals/model']);
    const retained = f.retain.mock.calls[0]![0];
    const posted = JSON.parse(f.call.mock.calls[1]![1]!.body as string);
    expect(retained).toEqual({ feature: 'retrieval', operation: { kind: 'model', operationId: posted.operationId, modelPurpose: 'answer' },
      binding: { contentHash: f.preview.contentHash, baseRevision: f.preview.baseRevision }, expiresAt: expect.any(String), confirmed: true });
    expect(retained.operation.operationId).not.toBe(f.approval.id);
    expect(Date.parse(retained.expiresAt) - Date.now()).toBeLessThanOrEqual(86400000);
    expect(JSON.stringify(retained)).not.toContain('PRIVATE'); expect(f.flow.state.retention?.status).toBe('saved');
  });
  it.each(['id', 'actor', 'workspace', 'operation', 'purpose', 'hash', 'base', 'expiry', 'ttl', 'null', 'body'])(
    'does not approve after an unverified retained %s', async (wrong) => {
      const f = await setup();
      f.retain.mockImplementation(async (input) => {
        const a: Record<string, unknown> = { ...await saved(input) };
        if (wrong === 'id') a.id = 'f'.repeat(64);
        if (wrong === 'actor') a.actorId = 'other';
        if (wrong === 'workspace') a.workspaceId = 'other';
        if (wrong === 'operation') a.operation = { ...input.operation, operationId: 'other-operation' };
        if (wrong === 'purpose') a.operation = { ...input.operation, modelPurpose: 'review' };
        if (wrong === 'hash') a.binding = { ...input.binding, contentHash: 'b'.repeat(64) };
        if (wrong === 'base') a.binding = { ...input.binding, baseRevision: 'fixture-other' };
        if (wrong === 'expiry') a.expiresAt = new Date(Date.now() - 1).toISOString();
        if (wrong === 'ttl') a.createdAt = new Date(Date.now() - 86400000).toISOString();
        if (wrong === 'body') a.text = 'PRIVATE';
        return { ok: true, data: (wrong === 'null' ? null : a) as unknown as RecoveryAnchor };
      });
      await f.flow.approve(true, true); await f.flow.send(); await f.flow.approve(true, true);
      expect(f.call).toHaveBeenCalledTimes(1); expect(f.retain).toHaveBeenCalledTimes(1);
      expect(f.flow.state.retention?.status).toBe('unknown'); expect(answerLeaveState(f.flow.state)).toBe('blocked');
    });
  it('does not repeat a lost retention response or infer that an ordinary error means not saved', async () => {
    const f = await setup(); f.retain.mockRejectedValue(new Error('response lost'));
    await f.flow.approve(true, true); await f.flow.approve(true, true); await f.flow.send();
    expect(f.retain).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledTimes(1); expect(answerLeaveState(f.flow.state)).toBe('blocked');
  });
  it('cancels during retention without approving, revoking or closing the late saved identity', async () => {
    const f = await setup(); let resolve!: (value: Awaited<ReturnType<NonNullable<NavigationProps['retainOperationRecovery']>>>) => void;
    f.retain.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const approving = f.flow.approve(true, true); await vi.waitFor(() => expect(f.retain).toHaveBeenCalledTimes(1));
    await f.flow.cancel(); resolve({ ok: true, data: await saved(f.retain.mock.calls[0]![0]) }); await approving;
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.flow.state.approval).toBeNull();
  });
  it('unmounts during registration without auto-revoking or closing a late approval', async () => {
    const f = await setup(); let resolve!: (value: ApiResponse<unknown>) => void;
    f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const approving = f.flow.approve(true); f.flow.detach(); resolve(ok(f.approval)); await approving;
    expect(f.call).toHaveBeenCalledTimes(2); expect(f.flow.state.approval).toBeNull();
  });
  it('does not send after the separately retained identity expires', async () => {
    vi.useFakeTimers(); const f = await setup(); await f.flow.approve(true, true);
    vi.setSystemTime(Date.now() + 86400001); await f.flow.send();
    expect(f.call).toHaveBeenCalledTimes(2); expect(answerLeaveState(f.flow.state)).toBe('blocked');
  });
});
