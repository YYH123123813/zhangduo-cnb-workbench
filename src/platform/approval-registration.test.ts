import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createApp } from '../server/app';
import type { Result } from '../contracts/api';
import type { Approval, Conversation } from '../contracts/domain';
import { contentHash, hashConversation, hashSettings } from '../contracts/hash';
import type { GovernanceApprovalRequest } from '../contracts/governance';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import type { ModelTransport } from './model';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function data<T>(value: Result<T>): T { expect(value.ok, JSON.stringify(value)).toBe(true); if (!value.ok) throw Error(JSON.stringify(value)); return value.data; }
async function setup(persistent = false) {
  let file = ':memory:';
  if (persistent) { mkdirSync('.local/fixture', { recursive: true }); const dir = mkdtempSync(resolve('.local/fixture/registration-')); file = join(dir, 'state.sqlite'); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); }
  const f = await platformFixture(file); let journal = f.journal; cleanup.push(() => journal.close());
  const complete = vi.fn<ModelTransport['complete']>(); const model: ModelTransport = { mode: 'fixture', complete };
  let services = createServices({ ...f.options, model });
  async function settings(operationId: string): Promise<GovernanceApprovalRequest> {
    const current = data(await services.settingsState!(f.ctx));
    return { operationId, purpose: 'settings', settings: { ...current.settings, aiAnswer: true }, baseRevision: f.base,
      expectedSettingsHash: await hashSettings(f.ctx.workspaceId, f.base, current.settings), expectedSettingsRevision: current.revision, confirmed: true };
  }
  return { ...f, file, complete, settings, services: () => services, reopen(now = Date.now) { journal.close(); journal = new OperationJournal(file, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal, now), model }); },
  };
}

describe('atomic original approval registration recovery, synthetic transports only', () => {
  it('deduplicates concurrent full requests, and read-only HTTP recovers the original after SQLite restart', async () => {
    const f = await setup(true), request = await f.settings('settings-A');
    const approvals = await Promise.all([f.services().approveGovernance!(f.ctx, request), f.services().approveGovernance!(f.ctx, request)]);
    expect(approvals[0]).toEqual(approvals[1]); const approval = data(approvals[0]!);
    f.reopen(); const before = f.transport.mock.calls.length;
    const response = await createApp(f.services()).request('/api/workspace/approval-registrations/settings/settings-A', { headers: f.headers });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, data: { status: 'registered', approval, requestHash: await contentHash(request), absenceIsFinal: false } });
    expect(f.transport).toHaveBeenCalledTimes(before); expect(f.complete).not.toHaveBeenCalled(); expect(f.git.publish).not.toHaveBeenCalled();
  });
  it('binds settings CAS as operation identity; a later same-value operation is distinct and never overwrites old constraints', async () => {
    const f = await setup(), first = await f.settings('A'); if (first.purpose !== 'settings') throw Error('settings');
    const approval = data(await f.services().approveGovernance!(f.ctx, first)); data(await f.services().saveSettings(f.ctx, first.settings, approval));
    const second = await f.settings('B');
    expect(data(await f.services().approveGovernance!(f.ctx, first))).toEqual(approval);
    expect(await f.services().approveGovernance!(f.ctx, { ...second, operationId: 'A' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(data(await f.services().approveGovernance!(f.ctx, second)).id).not.toBe(approval.id);
    expect(data(await f.services().readSettingsReceipt!(f.ctx, approval.id))).toMatchObject({ revision: 1, previousRevision: 0 });
  });
  it('returns revoked/expired metadata without renewing; missing/damaged records never prove final absence', async () => {
    const f = await setup(true), request = await f.settings('A'), query = { operationId: 'A', purpose: 'settings' as const };
    expect(data(await f.services().readApprovalRegistration!(f.ctx, query))).toMatchObject({ status: 'not_registered', absenceIsFinal: false });
    const approval = data(await f.services().approveGovernance!(f.ctx, request));
    data(await f.services().revokeApproval!(f.ctx, approval.id));
    expect(data(await f.services().readApprovalRegistration!(f.ctx, query))).toMatchObject({ status: 'revoked', approval });
    expect((await f.services().approveGovernance!(f.ctx, request)).ok).toBe(false);
    const other = data(await f.services().approveGovernance!(f.ctx, await f.settings('B')));
    f.reopen(() => Date.parse(other.expiresAt) + 1);
    expect(data(await f.services().readApprovalRegistration!(f.ctx, { ...query, operationId: 'B' }))).toMatchObject({ status: 'expired', approval: other });
  });
  it('recovers model purpose without input/output text, even when its AI switch has since closed', async () => {
    const f = await setup(); const configured = await f.settings('AI-on'); if (configured.purpose !== 'settings') throw Error('settings');
    data(await f.services().saveSettings(f.ctx, configured.settings, data(await f.services().approveGovernance!(f.ctx, configured))));
    f.initial.nodes[0]!.sources.push({ id: 's1', kind: 'user_observation', title: 'Synthetic source', excerpt: 'Synthetic source', accessedAt: '2026-09-05T00:00:00Z', support: 'supports', supportedClaim: f.node.humanStatement, limitation: '' });
    const input = { operationId: 'answer-A', input: { purpose: 'answer' as const, text: 'PRIVATE_MODEL_INPUT', sourceIds: ['s1'] }, objectIds: ['k1'], baseRevision: f.base, confirmed: true as const };
    const approval = data(await f.services().approveModel!(f.ctx, input));
    expect(data(await f.services().approveModel!(f.ctx, input))).toEqual(approval);
    const off = await f.settings('AI-off'); if (off.purpose !== 'settings') throw Error('settings'); off.settings.aiAnswer = false;
    data(await f.services().saveSettings(f.ctx, off.settings, data(await f.services().approveGovernance!(f.ctx, off))));
    const state = data(await f.services().readApprovalRegistration!(f.ctx, { operationId: input.operationId, purpose: 'model_input', modelPurpose: 'answer' }));
    expect(state).toMatchObject({ status: 'registered', approval }); expect(JSON.stringify(state)).not.toContain('PRIVATE_MODEL_INPUT');
    expect((await f.services().readApprovalRegistration!(f.ctx, { operationId: input.operationId, purpose: 'model_input', modelPurpose: 'review' })).ok).toBe(false);
    expect(f.complete).not.toHaveBeenCalled();
  });
  it('supports capture, export and delete registration without initiating their side effects', async () => {
    const f = await setup();
    const conversation: Conversation = { id: 'c-new', workspaceId: f.ctx.workspaceId, taskId: 't1', origin: 'manual', segments: [{ id: 's1', role: 'user', text: 'Private text' }], state: 'preview', sourceAlreadyPersisted: false, contentHash: '', createdAt: new Date().toISOString() };
    conversation.contentHash = await hashConversation(conversation);
    const capture = { operationId: 'capture-A', conversation, baseRevision: 'new', confirmed: true as const };
    const a = data(await f.services().approveConversation!(f.ctx, capture));
    expect(data(await f.services().approveConversation!(f.ctx, capture))).toEqual(a);
    expect(data(await f.services().readApprovalRegistration!(f.ctx, { operationId: capture.operationId, purpose: 'save_conversation' }))).toMatchObject({ approval: a });
    const plan = data(await f.services().previewDelete(f.ctx, ['k1']));
    const requests: GovernanceApprovalRequest[] = [{ operationId: 'export-A', purpose: 'export', objectIds: ['k1'], baseRevision: f.base, confirmed: true },
      { operationId: 'delete-A', purpose: 'delete', planId: plan.id, confirmed: true }];
    for (const request of requests) {
      const approval = data(await f.services().approveGovernance!(f.ctx, request));
      expect(data(await f.services().approveGovernance!(f.ctx, request))).toEqual(approval);
      expect(data(await f.services().readApprovalRegistration!(f.ctx, { operationId: request.operationId!, purpose: request.purpose }))).toMatchObject({ status: 'registered', approval });
    }
    expect(f.journal.blocked(f.ctx.workspaceId)).toEqual([]); expect(f.git.publish).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it('rolls back the approval and constraint if binding insertion fails, and rejects another actor or forged context', async () => {
    const f = await setup(), request = await f.settings('A');
    const write = f.journal.putRecord.bind(f.journal);
    vi.spyOn(f.journal, 'putRecord').mockImplementation((...args) => args[2].startsWith('approval_registration:') ? false : write(...args));
    const registered = vi.spyOn(f.authority, 'register');
    expect((await f.services().approveGovernance!(f.ctx, request)).ok).toBe(false);
    const result = registered.mock.results[0]?.value as Result<Approval>; const failed = data(result);
    expect(f.journal.approval(failed.id)).toBeUndefined(); expect(f.journal.record(f.ctx.workspaceId, f.ctx.actorId, 'approval_constraint', failed.id)).toBeUndefined();
    vi.restoreAllMocks(); data(await f.services().approveGovernance!(f.ctx, request));
    const workspace = data(await f.services().workspace(f.ctx)); const token = f.sessions.issue({ actorId: 'another-actor', workspace, scopes: [...f.ctx.scopes] });
    const other = data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
    const query = { operationId: 'A', purpose: 'settings' as const };
    expect((await f.services().readApprovalRegistration!(other, query)).ok).toBe(false);
    expect((await f.services().readApprovalRegistration!({ ...f.ctx }, query)).ok).toBe(false);
    expect((await f.services().approveGovernance!(other, request)).ok).toBe(false);
    f.journal.putRecord(f.ctx.workspaceId, '@workspace', 'approval_registration:settings', 'broken', { invalid: true }, null);
    expect(data(await f.services().readApprovalRegistration!(f.ctx, { ...query, operationId: 'broken' }))).toMatchObject({ status: 'unknown', approval: null, absenceIsFinal: false });
  });
  it('uses the same registration across two SQLite connections without minting another approval', async () => {
    const f = await setup(true), second = new OperationJournal(f.file, { fixture: true }); cleanup.push(() => second.close());
    const services = createServices({ ...f.options, journal: second, approvalAuthority: new ApprovalAuthority(f.sessions, second) });
    const request = await f.settings('parallel-A');
    const approvals = await Promise.all([f.services().approveGovernance!(f.ctx, request), services.approveGovernance!(f.ctx, request)]);
    expect(data(approvals[0]!)).toEqual(data(approvals[1]!));
    expect(second.records(f.ctx.workspaceId, '@workspace', 'approval_registration:settings')).toHaveLength(1);
  });
  it('requires exact read scopes and query shape, without reading remote content or registering anything', async () => {
    const f = await setup(); data(await f.services().approveGovernance!(f.ctx, await f.settings('A')));
    const workspace = data(await f.services().workspace(f.ctx));
    const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace, scopes: ['workspace:read', 'settings:read'] });
    const app = createApp(f.services()), before = f.transport.mock.calls.length;
    expect((await app.request('/api/workspace/approval-registrations/settings/A', { headers: { ...f.headers, Authorization: `Bearer ${token}` } })).status).toBe(403);
    for (const path of ['model_input/A', 'settings/A?modelPurpose=answer', 'model_input/A?modelPurpose=answer&modelPurpose=review', 'settings/A?body=private'])
      expect((await app.request(`/api/workspace/approval-registrations/${path}`, { headers: f.headers })).status).toBe(422);
    expect(f.transport).toHaveBeenCalledTimes(before); expect(f.complete).not.toHaveBeenCalled();
  });
});
