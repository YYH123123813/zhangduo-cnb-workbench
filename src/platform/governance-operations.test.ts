import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { OperationJournal } from './journal';
import { createServices } from './services';
import { contentHash } from '../contracts/hash';
import type { GovernanceOperationSaveRequest } from '../contracts/governance-operation';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
const request = (payload: Record<string, unknown>, operationId = 'governance-operation-1'): GovernanceOperationSaveRequest => ({
  operationId, kind: 'change', baseRevision: 'a'.repeat(40), payload, expectedRevision: 0, retentionDays: 30, confirmed: true,
});

describe('W6-REQ-010 governance original payload storage', () => {
  it('persists the exact approved preview and receipt across SQLite reopen without rebuilding it', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/governance-operation-fixture-')), file = join(directory, 'state.sqlite');
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const s = await platformFixture(file); cleanup.push(() => { try { s.journal.close(); } catch { /* Reopened in this test. */ } });
    const payload = { changeSet: { id: 'change-a', reason: 'Keep the original reason', nodes: [{ id: 'node-a', humanStatement: 'Original payload' }] }, selectedRevision: 'a'.repeat(40) };
    const saved = await s.services.saveGovernanceOperation!(s.ctx, request(payload));
    expect(saved).toMatchObject({ ok: true, data: { state: 'available', kind: 'change', baseRevision: 'a'.repeat(40), payload } });
    if (!saved.ok) return;
    expect(saved.data.contentHash).toBe(await contentHash(payload));
    expect(await s.services.readGovernanceOperationReceipt!(s.ctx, saved.data.operationId)).toMatchObject({ ok: true, data: { operationId: saved.data.operationId, outcome: 'saved', contentHash: saved.data.contentHash } });
    s.journal.close(); const reopened = new OperationJournal(file, { fixture: true }); cleanup.push(() => reopened.close());
    const restarted = createServices({ ...s.options, journal: reopened });
    expect(await restarted.readGovernanceOperation!(s.ctx, saved.data.operationId)).toEqual(saved);
    expect(await restarted.readGovernanceOperationReceipt!(s.ctx, saved.data.operationId)).toMatchObject({ ok: true, data: { requestHash: saved.data.requestHash } });
  });
  it('is idempotent for the same complete request, rejects a changed payload and never extends the original expiry', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close()); const first = await s.services.saveGovernanceOperation!(s.ctx, request({ value: 'A' }));
    if (!first.ok) throw Error('Expected first save'); const before = first.data.expiresAt;
    expect(await s.services.saveGovernanceOperation!(s.ctx, request({ value: 'A' }))).toEqual(first);
    expect(await s.services.saveGovernanceOperation!(s.ctx, request({ value: 'B' }))).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    const reread = await s.services.readGovernanceOperation!(s.ctx, first.data.operationId); if (!reread.ok) throw Error('Expected reread');
    expect(reread.data).toMatchObject({ expiresAt: before });
  });
  it('requires explicit 30-day consent, strict CAS zero and plain bounded JSON before writing', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close());
    expect(await s.services.saveGovernanceOperation!(s.ctx, { ...request({ value: 'A' }), confirmed: false } as unknown as GovernanceOperationSaveRequest)).toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'not_written' } });
    expect(await s.services.saveGovernanceOperation!(s.ctx, { ...request({ value: 'A' }), expectedRevision: 1 } as unknown as GovernanceOperationSaveRequest)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await s.services.saveGovernanceOperation!(s.ctx, { ...request({ value: undefined as unknown as string }) })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(s.journal.records(s.ctx.workspaceId, s.ctx.actorId, 'governance_operation')).toHaveLength(0);
  });
  it('clears only the payload on expiry, retains the receipt and rejects the wrong scope', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close()); const saved = await s.services.saveGovernanceOperation!(s.ctx, request({ privateStatement: 'private formal preview' }));
    if (!saved.ok) throw Error('Expected save'); s.journal.expirePrivatePayloads(new Date(Date.now() + 31 * 86_400_000).toISOString());
    expect(await s.services.readGovernanceOperation!(s.ctx, saved.data.operationId)).toMatchObject({ ok: true, data: { state: 'expired' } });
    const expired = await s.services.readGovernanceOperation!(s.ctx, saved.data.operationId); if (!expired.ok || !expired.data) throw Error('Expected expired state');
    expect('payload' in expired.data).toBe(false);
    expect(await s.services.readGovernanceOperationReceipt!(s.ctx, saved.data.operationId)).toMatchObject({ ok: true, data: { outcome: 'saved' } });
    const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw Error('Expected workspace');
    const restricted = s.sessions.issue({ actorId: s.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] });
    const context = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${restricted}` } })); if (!context.ok) throw Error('Expected restricted context');
    expect(await s.services.readGovernanceOperation!(context.data, saved.data.operationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('does not expose another actor payload and rolls the whole save back when receipt insertion fails', async () => {
    const s = await platformFixture(); cleanup.push(() => s.journal.close()); const saved = await s.services.saveGovernanceOperation!(s.ctx, request({ privateStatement: 'do not disclose' }));
    if (!saved.ok) throw Error('Expected save'); const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw Error('Expected workspace');
    const otherToken = s.sessions.issue({ actorId: 'other-actor', workspace: workspace.data, scopes: Object.values((await import('../contracts/scopes')).SCOPES) });
    const other = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${otherToken}` } })); if (!other.ok) throw Error('Expected other context');
    expect(await s.services.readGovernanceOperation!(other.data, saved.data.operationId)).toMatchObject({ ok: true, data: null });
    const original = s.journal.putRecord.bind(s.journal); vi.spyOn(s.journal, 'putRecord').mockImplementation((...args) => args[2] === 'governance_operation_receipt' ? false : original(...args));
    expect(await s.services.saveGovernanceOperation!(s.ctx, request({ value: 'rollback' }, 'governance-operation-2'))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'governance_operation', 'governance-operation-2')).toBeUndefined();
  });
});
