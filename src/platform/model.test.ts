import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createServices } from './services';
import type { OperationJournal } from './journal';
import type { ModelTransport } from './model';
import { hashSettings } from '../contracts/hash';
import { createApp } from '../server/app';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup() {
  const s = await platformFixture(); journals.push(s.journal);
  s.node.sources.push({ id: 'source1', kind: 'user_observation', title: 'Synthetic observation', excerpt: 'Fixture evidence', accessedAt: '2026-09-01T00:00:00Z', support: 'supports', supportedClaim: 'Fixture claim', limitation: 'Synthetic only' });
  const complete = vi.fn<ModelTransport['complete']>(async () => ({ ok: true, data: { value: { claims: [] }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }));
  const model: ModelTransport = { mode: 'fixture', complete };
  const services = createServices({ ...s.options, model });
  const input = { purpose: 'answer' as const, text: '{"question":"fixture"}', sourceIds: ['source1'] };
  async function setAI(enabled: boolean, key: 'aiAnswer' | 'aiExtraction' | 'aiReview' = 'aiAnswer') {
    const state = await services.settingsState!(s.ctx); if (!state.ok) throw new Error('Expected settings');
    const settings = { ...state.data.settings, [key]: enabled };
    const approved = await services.approveGovernance!(s.ctx, { purpose: 'settings', settings, baseRevision: s.base, expectedSettingsHash: await hashSettings(s.ctx.workspaceId, s.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true });
    if (!approved.ok) throw new Error('Expected settings approval');
    expect((await services.saveSettings(s.ctx, settings, approved.data)).ok).toBe(true);
  }
  const approve = () => services.approveModel!(s.ctx, { input, objectIds: ['k1'], baseRevision: s.base, confirmed: true });
  return { ...s, services, complete, input, setAI, approve };
}
describe('W09 bounded model calls and server-enforced settings', () => {
  it('rejects approval while AI is off and a previously approved send after settings turn off', async () => {
    const s = await setup(); expect((await s.approve()).ok).toBe(false);
    await s.setAI(true); const approved = await s.approve(); if (!approved.ok) throw new Error('Expected model approval');
    await s.setAI(false);
    expect((await s.services.complete(s.ctx, { ...s.input, approval: approved.data })).ok).toBe(false);
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('allows one approved call, records the actual model ID and never duplicates a charged operation', async () => {
    const s = await setup(); await s.setAI(true); const approved = await s.approve(); if (!approved.ok) throw new Error('Expected approval');
    expect(await s.services.complete(s.ctx, { ...s.input, approval: approved.data })).toMatchObject({ ok: true, data: { modelId: 'fixture-model', value: { claims: [] } } });
    expect((await s.services.complete(s.ctx, { ...s.input, approval: approved.data })).ok).toBe(false);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect(s.complete.mock.calls[0]![1]).toMatchObject({ maxOutputTokens: 2048 });
  });
  it('discards in-flight output when AI turns off, and does not leak transport exceptions', async () => {
    for (const fail of [false, true]) {
      const s = await setup(); await s.setAI(true); const approved = await s.approve(); if (!approved.ok) throw new Error('Expected approval');
      s.complete.mockImplementation(async () => { if (fail) throw new Error('fixture-secret private payload'); await s.setAI(false); return { ok: true, data: { value: { private: 'must not return' }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }; });
      const result = await s.services.complete(s.ctx, { ...s.input, approval: approved.data });
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private');
    }
  });
  it('rejects revoked approval, changed input or newly blocked knowledge before a model call', async () => {
    for (const scenario of ['revoked', 'changed', 'deleted']) {
      const s = await setup(); await s.setAI(true); const approved = await s.approve(); if (!approved.ok) throw new Error('Expected approval');
      if (scenario === 'revoked') s.authority.revoke(s.ctx, approved.data.id);
      if (scenario === 'deleted') s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-delete');
      expect((await s.services.complete(s.ctx, { ...s.input, ...(scenario === 'changed' ? { text: 'changed' } : {}), approval: approved.data })).ok).toBe(false);
      expect(s.complete).not.toHaveBeenCalled();
    }
  });
  it('registers model approval through authenticated HTTP only after an explicit preview confirmation', async () => {
    const s = await setup(); await s.setAI(true);
    const app = createApp(s.services);
    const request = { input: s.input, objectIds: ['k1'], baseRevision: s.base, confirmed: true };
    const post = (body: unknown, headers = s.headers) => app.request('/api/workspace/approvals/model', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ ...request, confirmed: false })).status).toBe(422);
    expect((await post({ ...request, actorId: 'forged' })).status).toBe(422);
    expect((await post(request, { ...s.headers, Authorization: '' })).status).toBe(401);
    const response = await post(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { purpose: 'model_input', actorId: s.ctx.actorId, contentHash: expect.any(String) }, meta: { mode: 'fixture' } });
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('enforces the same workspace concurrency budget across service instances and retains only metadata', async () => {
    const s = await setup(); await s.setAI(true);
    const peer = createServices({ ...s.options, model: { mode: 'fixture', complete: s.complete } });
    const approvals = await Promise.all([s.approve(), s.approve(), s.approve()]);
    const registered = approvals.map((result) => { if (!result.ok) throw new Error('Expected approval'); return result.data; });
    const releases: (() => void)[] = [];
    s.complete.mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, data: { value: { claims: [] }, modelId: 'actual-fixture-model', generatedAt: new Date().toISOString() } };
    });
    const one = s.services.complete(s.ctx, { ...s.input, approval: registered[0]! });
    const two = peer.complete(s.ctx, { ...s.input, approval: registered[1]! });
    try {
      await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2));
      expect(await peer.complete(s.ctx, { ...s.input, approval: registered[2]! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
      expect(s.complete).toHaveBeenCalledTimes(2);
    } finally { releases.forEach((resolve) => resolve()); }
    expect((await one).ok).toBe(true); expect((await two).ok).toBe(true);
    const operations = s.journal.records(s.ctx.workspaceId, '@workspace', 'model_operation');
    expect(operations).toHaveLength(2);
    expect(operations[0]!.value).toMatchObject({ modelId: 'actual-fixture-model', state: 'done' });
    expect(JSON.stringify(operations)).not.toContain(s.input.text);
    expect(JSON.stringify(operations)).not.toContain('claims');
  });
  it('limits all model purposes to twenty sends per workspace UTC day, including unknown outcomes', async () => {
    const s = await setup(); await s.setAI(true);
    s.complete.mockRejectedValue(new Error('not persisted private source'));
    for (let index = 0; index < 20; index++) {
      const approval = await s.approve(); if (!approval.ok) throw new Error('Expected approval');
      expect(await s.services.complete(s.ctx, { ...s.input, approval: approval.data })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', retryable: false } });
    }
    const approval = await s.approve(); if (!approval.ok) throw new Error('Expected approval');
    expect(await s.services.complete(s.ctx, { ...s.input, approval: approval.data })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
    expect(s.complete).toHaveBeenCalledTimes(20);
  });
  it('checks the saved extraction conversation and segment versions before and after transmission', async () => {
    const s = await setup(); await s.setAI(true, 'aiExtraction');
    const issue = { number: '7', title: 'Synthetic source', body: 'approved fixture segment', created_at: '2026-09-05T00:00:00Z', invisible: true };
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : original(...args));
    const saved = await s.services.readIssue(s.ctx, 7); if (!saved.ok) throw new Error('Expected saved issue');
    const input = { purpose: 'extract' as const, text: 'selected synthetic text', sourceIds: [saved.data.segments[1]!.id] };
    const request = { input, objectIds: input.sourceIds, conversationId: saved.data.id, baseRevision: saved.data.contentHash, confirmed: true as const };
    expect((await s.services.approveModel!(s.ctx, { ...request, objectIds: ['unknown'] })).ok).toBe(false);
    const approved = await s.services.approveModel!(s.ctx, request); if (!approved.ok) throw new Error('Expected extraction approval');
    s.complete.mockImplementation(async () => { issue.body = 'changed during transmission'; return { ok: true, data: { value: { candidates: [] }, modelId: 'fixture-model', generatedAt: new Date().toISOString() } }; });
    expect(await s.services.complete(s.ctx, { ...input, approval: approved.data })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'preserved' } });
    expect((await s.services.approveModel!(s.ctx, request)).ok).toBe(false);
    expect(s.complete).toHaveBeenCalledTimes(1);
  });
});
