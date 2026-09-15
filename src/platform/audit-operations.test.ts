import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import type { Result } from '../contracts/api';
import { hashChangeSet, hashSettings } from '../contracts/hash';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { createServices } from './services';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach((close) => close()); });
function data<T>(result: Result<T>): T { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
function file() {
  mkdirSync('.local/fixture', { recursive: true }); const dir = mkdtempSync(resolve('.local/fixture/audit-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'state.sqlite');
}
async function setup() {
  const path = file(), f = await platformFixture(path); let journal = f.journal, services = f.services;
  cleanup.push(() => journal.close());
  function reopen() { journal.close(); journal = new OperationJournal(path, { fixture: true });
    services = createServices({ ...f.options, journal, approvalAuthority: new ApprovalAuthority(f.sessions, journal) }); }
  return { ...f, reopen, services: () => services, journal: () => journal };
}
async function settingsRequest(f: Awaited<ReturnType<typeof setup>>) {
  const state = data(await f.services().settingsState!(f.ctx));
  return { purpose: 'settings' as const, settings: { ...state.settings, aiAnswer: true }, baseRevision: f.base,
    expectedSettingsHash: await hashSettings(f.ctx.workspaceId, f.base, state.settings), expectedSettingsRevision: state.revision, confirmed: true as const };
}

describe('W6-REQ-011 authoritative original-operation audit links', () => {
  it('distinguishes separate same-value settings saves and never links an unexecuted approval', async () => {
    const f = await setup(), input = await settingsRequest(f);
    const a = data(await f.services().approveGovernance!(f.ctx, input)), b = data(await f.services().approveGovernance!(f.ctx, input));
    data(await f.services().saveSettings(f.ctx, input.settings, b));
    const next = await settingsRequest(f), c = data(await f.services().approveGovernance!(f.ctx, next));
    data(await f.services().saveSettings(f.ctx, next.settings, c));
    data(await f.services().saveSettings(f.ctx, next.settings, c));
    const events = data(await f.services().audit(f.ctx)).filter((event) => event.action === 'settings_saved');
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectIds: [f.ctx.workspaceId], operation: { kind: 'settings', id: b.id } }),
      expect.objectContaining({ objectIds: [f.ctx.workspaceId], operation: { kind: 'settings', id: c.id } }),
    ]));
    expect(data(await f.services().readSettingsReceipt!(f.ctx, a.id))).toBeNull();
    f.reopen(); expect(data(await f.services().audit(f.ctx)).filter((event) => event.action === 'settings_saved')).toEqual(events);
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
  });
  it('links the exact deletion report while keeping physical cleanup unverified', async () => {
    const f = await setup(), plan = data(await f.services().previewDelete(f.ctx, ['k1']));
    const approval = data(await f.services().approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    data(await f.services().executeDelete(f.ctx, plan, approval)); f.reopen();
    expect(data(await f.services().audit(f.ctx))).toContainEqual(expect.objectContaining({ action: 'retrieval_blocked', outcome: 'physical_cleanup_unverified',
      objectIds: ['k1'], operation: { kind: 'delete', id: plan.id } }));
    expect(data(await f.services().readDeleteReport!(f.ctx, plan.id))).toMatchObject({ planId: plan.id, retrievalBlocked: true });
    expect(f.git.publish).not.toHaveBeenCalled();
  });
  it('adds one original knowledge link only after the published commit has been independently verified', async () => {
    const f = await setup(), changes = { id: 'audit-original-commit', workspaceId: f.ctx.workspaceId, baseRevision: f.base,
      nodes: [{ ...f.node, revision: f.base, humanStatement: 'Revised private statement' }], relations: [], withdrawnIds: [], reason: 'Private change reason', contentHash: '' };
    changes.contentHash = await hashChangeSet(changes);
    const approval = data(await f.services().approveKnowledge!(f.ctx, { changes, confirmed: true }));
    const publish = vi.mocked(f.git.publish).getMockImplementation()!;
    vi.mocked(f.git.publish).mockImplementationOnce(async (...args) => { await publish(...args); throw Error('Lost publication response'); });
    expect(await f.services().commit(f.ctx, changes, approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(data(await f.services().audit(f.ctx)).filter((event) => event.action === 'commit_knowledge')).toEqual([]);
    f.reopen(); const receipt = data(await f.services().readCommit!(f.ctx, changes.id));
    expect(receipt?.changeSetId).toBe(changes.id);
    expect(data(await f.services().readCommit!(f.ctx, changes.id))).toEqual(receipt);
    const events = data(await f.services().audit(f.ctx));
    expect(events.filter((event) => event.action === 'commit_knowledge')).toEqual([
      expect.objectContaining({ objectIds: ['k1'], outcome: 'done', operation: { kind: 'knowledge', id: changes.id } }),
    ]);
    expect(JSON.stringify(events)).not.toContain(changes.reason); expect(JSON.stringify(events)).not.toContain(changes.nodes[0]!.humanStatement);
    expect(f.git.publish).toHaveBeenCalledOnce();
  });
  it('does not keep settings or a receipt when the matching audit transaction fails', async () => {
    const f = await setup(), input = await settingsRequest(f), approved = data(await f.services().approveGovernance!(f.ctx, input));
    vi.spyOn(f.journal(), 'addAudit').mockImplementationOnce(() => { throw Error('Synthetic audit storage failure'); });
    expect((await f.services().saveSettings(f.ctx, input.settings, approved)).ok).toBe(false);
    expect(data(await f.services().settingsState!(f.ctx)).revision).toBe(0);
    expect(data(await f.services().readSettingsReceipt!(f.ctx, approved.id))).toBeNull();
    expect(data(await f.services().audit(f.ctx))).toEqual([]);
  });
  it('checks audit authorization before querying private journal rows', async () => {
    const f = await setup(), workspace = data(await f.services().workspace(f.ctx));
    const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace, scopes: f.ctx.scopes.filter((scope) => scope !== 'audit:read') });
    const ctx = data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
    const read = vi.spyOn(f.journal(), 'audit'); f.transport.mockClear();
    expect((await f.services().audit(ctx)).ok).toBe(false); expect((await f.services().audit({ ...f.ctx })).ok).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it('keeps Git unknown when local audit finalization fails, then resolves without a second publication', async () => {
    const f = await setup(), changes = { id: 'audit-write-failed', workspaceId: f.ctx.workspaceId, baseRevision: f.base,
      nodes: [{ ...f.node, revision: f.base }], relations: [], withdrawnIds: [], reason: 'Verify atomic commit metadata', contentHash: '' };
    changes.contentHash = await hashChangeSet(changes);
    const approval = data(await f.services().approveKnowledge!(f.ctx, { changes, confirmed: true }));
    vi.spyOn(f.journal(), 'addAudit').mockImplementationOnce(() => { throw Error('Audit write failed after remote verification'); });
    expect(await f.services().commit(f.ctx, changes, approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(f.journal().commit(f.ctx.workspaceId, changes.id)?.state).not.toBe('done');
    expect(data(await f.services().audit(f.ctx))).toEqual([]);
    f.reopen(); expect(data(await f.services().readCommit!(f.ctx, changes.id))?.changeSetId).toBe(changes.id);
    expect(data(await f.services().audit(f.ctx))).toEqual([expect.objectContaining({ operation: { kind: 'knowledge', id: changes.id } })]);
    expect(f.git.publish).toHaveBeenCalledOnce();
  });
  it('cannot claim deletion success or create an audit association without the original report', async () => {
    const f = await setup(), plan = data(await f.services().previewDelete(f.ctx, ['k1']));
    const approval = data(await f.services().approveGovernance!(f.ctx, { purpose: 'delete', planId: plan.id, confirmed: true }));
    const put = f.journal().putRecord.bind(f.journal());
    vi.spyOn(f.journal(), 'putRecord').mockImplementation((...args) => args[2] === 'delete_report' ? false : put(...args));
    expect(await f.services().executeDelete(f.ctx, plan, approval)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(data(await f.services().readDeleteReport!(f.ctx, plan.id))).toBeNull();
    expect(data(await f.services().audit(f.ctx))).toEqual([]); expect(f.journal().blocked(f.ctx.workspaceId)).toEqual([]);
    expect(() => f.journal().addAudit(f.ctx.workspaceId, f.ctx.actorId, 'retrieval_blocked', ['k1'], 'physical_cleanup_unverified',
      { kind: 'delete', id: plan.id })).toThrow('requires the original');
  });
  it('migrates version-one SQLite audit rows without inventing original operation identities', () => {
    const path = file(), legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE audit_events (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      object_ids TEXT NOT NULL, occurred_at TEXT NOT NULL, outcome TEXT NOT NULL);
      PRAGMA user_version = 1;`);
    legacy.prepare('INSERT INTO audit_events(workspace,actor,action,object_ids,occurred_at,outcome) VALUES (?,?,?,?,?,?)')
      .run('w1', 'a1', 'settings_saved', '["w1"]', '2026-09-05T00:00:00Z', 'done'); legacy.close();
    const journal = new OperationJournal(path, { fixture: true }); cleanup.push(() => journal.close());
    expect(journal.audit('w1', 'a1')).toEqual([{ action: 'settings_saved', objectIds: ['w1'], occurredAt: '2026-09-05T00:00:00Z', outcome: 'done' }]);
    const read = new DatabaseSync(path); try { expect(Number(read.prepare('PRAGMA user_version').get()?.user_version)).toBe(2); } finally { read.close(); }
  });
  it('rejects unknown future SQLite versions without downgrading or clearing their data', () => {
    const path = file(), future = new DatabaseSync(path); future.exec('PRAGMA user_version = 3;'); future.close();
    expect(() => new OperationJournal(path, { fixture: true })).toThrow('newer than this application');
    const read = new DatabaseSync(path); try { expect(Number(read.prepare('PRAGMA user_version').get()?.user_version)).toBe(3); } finally { read.close(); }
  });
  it('refuses substituted receipt IDs and returns a sanitized Result when stored audit metadata cannot be parsed', async () => {
    const f = await setup();
    f.journal().putRecord(f.ctx.workspaceId, f.ctx.actorId, 'delete_report', 'wrong-key', { planId: 'another-original-plan', retrievalBlocked: true, layers: [] }, null);
    expect(() => f.journal().addAudit(f.ctx.workspaceId, f.ctx.actorId, 'retrieval_blocked', ['k1'], 'physical_cleanup_unverified',
      { kind: 'delete', id: 'wrong-key' })).toThrow('requires the original');
    vi.spyOn(f.journal(), 'audit').mockImplementationOnce(() => { throw Error('private stored metadata must not escape'); });
    const result = await f.services().audit(f.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL', dataState: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('private stored metadata');
  });
});
