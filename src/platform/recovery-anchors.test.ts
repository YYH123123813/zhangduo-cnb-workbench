import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../contracts/api';
import type { Services } from '../contracts/ports';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { RecoveryAnchorStore } from './recovery-anchors';
import { OperationJournal } from './journal';
import { OperationRecoveryStore } from './operation-recovery';
import { ApprovalAuthority } from './approvals';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach((fn) => fn()); });
function data<T>(r: Result<T>): T { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw Error(r.error.message); return r.data; }

describe('consented operation recovery identities, synthetic external transport', () => {
  it('requires independent consent, keeps no body, survives reconnect and SQLite reopen, and expires without replay', async () => {
    mkdirSync('.local/fixture', { recursive: true });
    const dir = mkdtempSync(resolve('.local/fixture/anchors-')), file = join(dir, 'state.sqlite');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = await platformFixture(file); let journal = f.journal; cleanup.push(() => journal.close());
    let clock = Date.now();
    const store = () => new RecoveryAnchorStore(f.sessions, journal, async (ctx, query) => new OperationRecoveryStore(f.sessions, journal, new ApprovalAuthority(f.sessions, journal)).read(ctx, query), () => clock);
    const input = { actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, feature: 'retrieval', operation: { kind: 'model', operationId: 'answer-original', modelPurpose: 'answer' },
      binding: { contentHash: 'a'.repeat(64), baseRevision: f.base }, expiresAt: new Date(clock + 86_400_000).toISOString(), confirmed: true };
    expect(await store().save(f.ctx, { ...input, confirmed: false })).toMatchObject({ ok: false });
    expect(await store().save(f.ctx, { ...input, query: 'PRIVATE_QUERY' })).toMatchObject({ ok: false });
    const anchor = data(await store().save(f.ctx, input));
    expect(JSON.stringify(anchor)).not.toContain('PRIVATE_QUERY');
    expect(data(await store().save(f.ctx, input))).toEqual(anchor);
    expect(await store().save(f.ctx, { ...input, binding: { ...input.binding, contentHash: 'b'.repeat(64) } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    journal.close(); journal = new OperationJournal(file, { fixture: true });
    const workspace = { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private' as const, mode: 'fixture' as const };
    const other = data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${f.sessions.issue({ actorId: 'other', workspace, scopes: [...f.ctx.scopes] })}` } })));
    expect(data(store().list(other))).toEqual([]);
    expect(data(await store().read(other, anchor.id))).toBeNull();
    const token = f.sessions.issue({ actorId: f.ctx.actorId, workspace, scopes: [...f.ctx.scopes] });
    const reconnected = data(f.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } })));
    expect(data(store().list(reconnected))).toEqual([anchor]);
    const write = vi.spyOn(journal, 'putRecord');
    const recovered = data(await store().read(reconnected, anchor.id));
    expect(recovered).toMatchObject({ identity: anchor, binding: 'unknown', readOnly: true, retryAllowed: false });
    expect(write).not.toHaveBeenCalled();
    clock += 86_400_001;
    journal.expirePrivatePayloads(new Date(clock).toISOString());
    expect(data(store().list(reconnected))).toEqual([]);
    expect(data(await store().read(reconnected, anchor.id))).toBeNull();
    expect(await store().save(reconnected, input)).toMatchObject({ ok: false });
  });

  it('checks the original binding on read and never imports a changed operation as success', async () => {
    const f = await platformFixture(); cleanup.push(() => f.journal.close());
    const lookup = vi.fn<NonNullable<Services['readOperationRecovery']>>(async (_ctx, operation) => ({ ok: true, data: { kind: operation.kind, operationId: operation.operationId,
      actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, approvalId: null, recordId: null, purpose: null,
      requestHash: 'a'.repeat(64), contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null,
      stage: 'saved', readOnly: true, absenceIsFinal: false } } as const));
    const store = new RecoveryAnchorStore(f.sessions, f.journal, lookup);
    const input = { actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, feature: 'learning', operation: { kind: 'review', operationId: 'review-original' }, binding: { requestHash: 'a'.repeat(64) },
      expiresAt: new Date(Date.now() + 86_000_000).toISOString(), confirmed: true };
    const anchor = data(await store.save(f.ctx, input));
    expect(data(await store.read(f.ctx, anchor.id))).toMatchObject({ binding: 'matched', retryAllowed: false });
    lookup.mockImplementation(async (_ctx, operation) => ({ ok: true, data: { kind: operation.kind, operationId: operation.operationId,
      actorId: f.ctx.actorId, workspaceId: f.ctx.workspaceId, approvalId: null, recordId: null, purpose: null,
      requestHash: 'b'.repeat(64), contentHash: null, baseRevision: null, objectIds: [], approvalExpiresAt: null,
      stage: 'saved', readOnly: true, absenceIsFinal: false } } as const));
    expect(data(await store.read(f.ctx, anchor.id))).toMatchObject({ binding: 'mismatch', original: null, retryAllowed: false });
    f.sessions.revokeAll();
    expect(await store.read(f.ctx, anchor.id)).toMatchObject({ ok: false });
  });
});
