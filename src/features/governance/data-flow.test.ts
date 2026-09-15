import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import type { OperationJournal } from '../../platform/journal';
import type { ApiResponse } from '../../contracts/api';
import { DataFlow, type DataAction, type SettingsData } from './data-flow';
import type { RequestApi } from './approval-flow';
import { SCOPES } from '../../contracts/scopes';
import { contentHash } from '../../contracts/hash';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup() {
  const s = await platformFixture(); journals.push(s.journal);
  s.initial.nodes.push({ ...s.node, id: 'k2' });
  const app = createApp(s.services);
  const request = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json());
  async function preview(kind: DataAction['kind'], objectIds = ['k1'], api: RequestApi = request) {
    let input: object;
    if (kind === 'settings') {
      const current = await api('/api/governance/settings'); if (!current.ok) throw new Error('Settings unavailable');
      const data = current.data as SettingsData;
      input = { action: 'preview', baseRevision: s.base, expectedSettingsHash: data.currentHash, expectedSettingsRevision: data.settingsRevision, patch: { aiAnswer: !data.settings.aiAnswer } };
    } else input = { action: 'preview', baseRevision: s.base, objectIds };
    const response = await api(`/api/governance/${kind === 'delete' ? 'delete/preview' : kind}`, { method: kind === 'settings' ? 'PATCH' : 'POST', body: JSON.stringify(input) });
    expect(response.ok, JSON.stringify(response)).toBe(true); if (!response.ok) throw new Error('Preview unavailable');
    return { kind, workspaceId: s.ctx.workspaceId, preview: response.data } as DataAction;
  }
  return { ...s, app, request, preview };
}

describe('1.5.0 data approval and execution lifecycle', () => {
  it('keeps a lost ordinary export response unknown without regenerating files or replacing the original operation', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/governance/export' && init?.body && JSON.parse(String(init.body)).action === 'execute') {
        expect(response.ok).toBe(true);
        throw new Error('Lost original export response');
      }
      return response;
    });
    const flow = new DataFlow(s.request); const preview = await s.preview('export');
    flow.prepare(preview, s.ctx.actorId); await flow.approve(); await flow.commit();
    const unknown = flow.getSnapshot(); const calls = s.request.mock.calls.length;
    expect(unknown.stage).toBe('unknown');
    await flow.verify(); await flow.verify(); await flow.commit(); await flow.approve();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'unknown', prepared: unknown.prepared, approval: unknown.approval, result: null });
    expect(flow.invalidate()).toBe(false); expect(flow.finish()).toBe(false); expect(flow.prepare(preview, s.ctx.actorId)).toBe(false);
    expect(s.request.mock.calls).toHaveLength(calls);
    expect(s.request.mock.calls.filter(([path, init]) => path === '/api/governance/export' && init?.body && JSON.parse(String(init.body)).action === 'execute')).toHaveLength(1);
  });
  it('does not downgrade an unavailable exact settings receipt to a matching final-value success', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/governance/settings/verify') return { ...response, ok: false, error: { code: 'NOT_CONFIGURED', message: 'Receipt reader unavailable', dataState: 'unknown', nextAction: 'read_original_receipt', retryable: false } } as ApiResponse<unknown>;
      return response;
    });
    const flow = new DataFlow(s.request); flow.prepare(await s.preview('settings'), s.ctx.actorId); await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown'); expect(flow.getSnapshot().result).toBeNull(); expect(flow.invalidate()).toBe(false);
  });
  it.each(['settings', 'export', 'delete'] as const)('recovers %s approval by the stable original registration ID without replaying registration or execution', async (kind) => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const result = await original(path, init);
      if (path === '/api/workspace/approvals/governance') throw new Error('Lost registered approval');
      return result;
    });
    const flow = new DataFlow(s.request); flow.prepare(await s.preview(kind), s.ctx.actorId); await flow.approve();
    expect(flow.getSnapshot().stage).toBe('approval_unknown'); expect(flow.invalidate()).toBe(false);
    const call = s.request.mock.calls.find(([path]) => path === '/api/workspace/approvals/governance')!;
    const request = JSON.parse(String(call[1]!.body)); expect(request.operationId).toEqual(expect.any(String));
    await flow.recoverApproval();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'approved', approval: { purpose: kind } });
    expect(s.request.mock.calls.some(([path]) => path === `/api/workspace/approval-registrations/${kind}/${request.operationId}`)).toBe(true);
    expect(s.request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/governance')).toHaveLength(1);
    expect((await s.services.readApprovalRegistration!(s.ctx, { purpose: kind, operationId: request.operationId }))).toMatchObject({ ok: true, data: { requestHash: await contentHash(request) } });
    expect(s.request.mock.calls.filter(([, init]) => init?.body && ['commit', 'execute'].includes(JSON.parse(String(init.body)).action))).toHaveLength(0);
    await flow.commit(); expect(flow.getSnapshot().stage, JSON.stringify(flow.getSnapshot())).toBe('succeeded');
  });
  it('keeps missing, mismatched and malformed recovered registrations locked to the original settings preview', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!; let mutation = {};
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/workspace/approvals/governance') throw new Error('Lost response');
      if (path.includes('/approval-registrations/') && response.ok) return { ...response, data: { ...response.data as object, ...mutation } };
      return response;
    });
    const flow = new DataFlow(s.request); const preview = await s.preview('settings'); flow.prepare(preview, s.ctx.actorId); await flow.approve();
    const prepared = flow.getSnapshot().prepared;
    for (const mismatch of [{ operationId: 'other' }, { purpose: 'export' }, { requestHash: 'other' }, { actorId: 'other' }, { workspaceId: 'other' }, { absenceIsFinal: true }, { status: 'not_registered', approval: null, requestHash: null }, { status: 'unknown', approval: null, requestHash: null }]) {
      mutation = mismatch; await flow.recoverApproval();
      expect(flow.getSnapshot()).toMatchObject({ stage: 'approval_unknown', prepared });
      expect(flow.prepare(preview, s.ctx.actorId)).toBe(false); await flow.approve(); await flow.commit();
    }
    expect(s.request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/governance')).toHaveLength(1);
    mutation = {}; await flow.recoverApproval(); expect(flow.getSnapshot().stage).toBe('approved');
    await flow.revoke(); expect(flow.getSnapshot().stage).toBe('idle');
  });
  it('only clears an unknown data registration after its original approval is verifiably revoked', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!; let approvalId = '';
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/workspace/approvals/governance' && response.ok) { approvalId = (response.data as { id: string }).id; throw new Error('Lost response'); }
      return response;
    });
    const flow = new DataFlow(s.request); flow.prepare(await s.preview('export'), s.ctx.actorId); await flow.approve();
    expect(await s.services.revokeApproval!(s.ctx, approvalId)).toMatchObject({ ok: true, data: { revoked: true } });
    await flow.recoverApproval(); expect(flow.getSnapshot().stage).toBe('idle');
    expect(s.request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/governance')).toHaveLength(1);
  });
  it('recovers an unknown settings save by its original receipt after later settings changes, without sending it again', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path.endsWith('/settings') && init?.method === 'PATCH' && JSON.parse(String(init.body)).action === 'execute') throw new Error('Lost after save');
      return response;
    });
    const flow = new DataFlow(s.request); flow.prepare(await s.preview('settings'), s.ctx.actorId); await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown'); const id = flow.getSnapshot().approval!.id;
    const other = new DataFlow(original); other.prepare(await s.preview('settings', [], original), s.ctx.actorId); await other.approve(); await other.commit();
    expect(other.getSnapshot().stage).toBe('succeeded');
    await flow.verify();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', approval: { id }, result: { kind: 'settings', receipt: { approvalId: id, previousRevision: 0, revision: 1 }, value: { settingsRevision: 2, settings: { aiAnswer: false } }, currentMatchesSaved: false } });
    expect(s.request.mock.calls.filter(([path, init]) => path.endsWith('/settings') && init?.method === 'PATCH' && JSON.parse(String(init.body)).action === 'execute')).toHaveLength(1);
    expect(flow.finish()).toBe(true);
  });
  it('does not attribute another session matching settings to an unknown save, or issue a new operation', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    const first = new DataFlow(s.request), second = new DataFlow(original);
    const preview = await s.preview('settings'); first.prepare(preview, s.ctx.actorId); second.prepare(preview, s.ctx.actorId);
    await first.approve(); await second.approve();
    s.request.mockImplementation(async (path, init) => {
      if (init?.method === 'PATCH' && path.endsWith('/settings')) throw new Error('Lost before execution');
      return original(path, init);
    });
    await first.commit(); await second.commit();
    const prior = first.getSnapshot(); await first.verify();
    expect(first.getSnapshot()).toMatchObject({ stage: 'unknown', approval: prior.approval, prepared: prior.prepared });
    expect(first.invalidate()).toBe(false);
    expect(first.prepare(preview, s.ctx.actorId)).toBe(false);
    expect(s.request.mock.calls.filter(([path, init]) => path.endsWith('/settings') && init?.method === 'PATCH' && JSON.parse(String(init.body)).action === 'execute')).toHaveLength(1);
  });
  it('saves and reads settings, then permits a second independently approved change', async () => {
    const s = await setup(); const flow = new DataFlow(s.request);
    for (let revision = 1; revision <= 2; revision++) {
      flow.prepare(await s.preview('settings'), s.ctx.actorId);
      await flow.approve(); await flow.commit();
      expect(flow.getSnapshot(), JSON.stringify(flow.getSnapshot())).toMatchObject({ stage: 'succeeded', result: { kind: 'settings', value: { settingsRevision: revision } } });
      expect(flow.finish()).toBe(true);
    }
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('rejects a stale approval from a second trusted session at the same settings revision', async () => {
    const s = await setup();
    const token = s.sessions.issue({ actorId: 'second-actor', workspace: { id: s.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private', mode: 'fixture' }, scopes: Object.values(SCOPES) });
    const other: RequestApi = async (path, init) => (await s.app.request(path, { ...init, headers: { ...s.headers, Authorization: `Bearer ${token}` } })).json();
    const first = new DataFlow(s.request), second = new DataFlow(other);
    first.prepare(await s.preview('settings'), s.ctx.actorId); second.prepare(await s.preview('settings', [], other), 'second-actor');
    await first.approve(); await second.approve(); await first.commit(); await second.commit();
    expect(first.getSnapshot().stage).toBe('succeeded');
    expect(second.getSnapshot()).toMatchObject({ stage: 'failed', error: { code: 'CONFLICT' } });
    expect(await s.services.settingsState!(s.ctx)).toMatchObject({ ok: true, data: { revision: 1 } });
  });
  it('reads an unknown delete result by the original plan, retains unknown layers, then can export another object', async () => {
    const s = await setup(); const original = s.request.getMockImplementation()!;
    s.request.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      return path.endsWith('/delete/execute') ? { ...response, ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Lost fixture response', retryable: false, dataState: 'unknown', nextAction: 'read_delete_report' } } as ApiResponse<unknown> : response;
    });
    const flow = new DataFlow(s.request); const plan = await s.preview('delete'); flow.prepare(plan, s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown'); expect(flow.invalidate()).toBe(false);
    await flow.verify();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', result: { kind: 'delete', value: { retrievalBlocked: true, physicalDeletionComplete: false, layers: expect.arrayContaining([expect.objectContaining({ name: 'git_history', state: 'unknown' })]) } } });
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/delete/execute'))).toHaveLength(1);
    flow.finish(); flow.prepare(await s.preview('export', ['k2']), s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot()).toMatchObject({ stage: 'succeeded', result: { kind: 'export' } });
    expect(s.request.mock.calls.filter(([path]) => path.endsWith('/export'))).toHaveLength(2);
    expect(s.git.publish).not.toHaveBeenCalled();
  });
});
