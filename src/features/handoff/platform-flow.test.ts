import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, CommitReceipt, HandoffDraft, KnowledgeSnapshot } from '../../contracts/domain';
import type { ApiResponse } from '../../contracts/api';
import { SCOPES } from '../../contracts/scopes';
import { restoreDraft } from './draft';
import { draftOptions } from './testing/draft-options';
import { newSubmission, settleReceiptRead, settleSubmission } from './submission';
import { handoffPlatformFixture, platformPreview } from './testing/platform';

type Fixture = Awaited<ReturnType<typeof handoffPlatformFixture>>;
const fixtures: Fixture[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.journal.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function setup(file?: string) {
  const fixture = await handoffPlatformFixture(file); fixtures.push(fixture);
  return { fixture, ...await platformPreview(fixture) };
}
function data<T>(response: ApiResponse<T>): T {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error(JSON.stringify(response));
  return response.data;
}

describe('H12 handoff HTTP with shared Services (synthetic upstream and CNB transport, not live G1/G2)', () => {
  it('preserves source, human judgment and fixed relation versions through approval, publication and readback', async () => {
    const { fixture: s, input, item, review } = await setup();
    const saved = await s.request<HandoffDraft>('/draft', { draft: input.draft, consent: true, options: draftOptions(input.draft, s.source.contentHash) }, 'PUT');
    expect(data(saved.result)).toEqual(input.draft);
    const restored = data((await s.request<HandoffDraft>(`/draft?draftId=${input.draft.id}`)).result);
    expect(restoreDraft(review, restored).ok).toBe(true);
    expect(s.git.prepare).not.toHaveBeenCalled(); expect(s.git.publish).not.toHaveBeenCalled();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    expect(s.git.publish).not.toHaveBeenCalled();
    const committed = await s.request<CommitReceipt>('/commit', { ...input, approval });
    expect(committed.response.status).toBe(200);
    expect(committed.response.headers.get('cache-control')).toBe('no-store');
    expect(committed.result.meta.mode).toBe('fixture');
    const receipt = data(committed.result);
    expect(receipt).toMatchObject({ changeSetId: input.changes.id, indexing: 'pending' });
    expect(receipt.revision).toMatch(/^[a-f0-9]{40}$/);
    const snapshot = data((await s.request<KnowledgeSnapshot>('/snapshot')).result);
    const node = snapshot.nodes.find((entry) => entry.id === item.nodeId)!;
    expect(node).toMatchObject({ humanStatement: item.statement, authorship: 'human_written', confirmation: 'confirmed',
      confirmedBy: review.actorId, evidenceStatus: 'partial', boundaries: item.boundaries,
      conversationId: s.source.id, candidateIds: [item.subject.id], revision: receipt.revision });
    expect(node.conditions[0]).toMatchObject({ status: 'confirmed', confirmedBy: review.actorId });
    expect(node.sources).toEqual(item.sources); expect(review.conversation.issueNumber).toBe(7);
    expect(review.conversation.issueUrl).toBe(s.source.issueUrl);
    expect(snapshot.relations[0]).toMatchObject({ source: { revision: receipt.revision }, target: { revision: s.base } });
    expect(snapshot.nodes.find((entry) => entry.id === s.node.id)?.revision).toBe(s.base);
    expect(await s.services.snapshot(s.ctx, s.base)).toMatchObject({ ok: true, data: { nodes: [expect.objectContaining({ id: s.node.id })], relations: [] } });
    expect(data((await s.request<CommitReceipt>(`/receipt?changeSetId=${input.changes.id}`)).result)).toEqual(receipt);
    expect(data((await s.request<CommitReceipt>('/commit', { ...input, approval })).result)).toEqual(receipt);
    expect(s.git.prepare).toHaveBeenCalledTimes(1); expect(s.git.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects missing confirmation, forged approvals, anonymous requests and spoofed workspace before publication', async () => {
    const { fixture: s, input } = await setup();
    expect((await s.request('/approval', { ...input, confirmed: false })).response.status).toBe(422);
    const approval = data((await s.request<Approval>('/approval', input)).result);
    expect((await s.request('/commit', { ...input, approval, confirmed: false })).response.status).toBe(422);
    expect((await s.request('/commit', { ...input, approval: { ...approval, id: 'forged-approval' } })).response.status).toBe(403);
    const anonymous = await s.app.request(`/api/handoff/${s.source.id}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(anonymous.status).toBe(401);
    const spoofed = await s.app.request(`/api/handoff/${s.source.id}/approval`, { method: 'POST', headers: { ...s.headers, 'X-Workspace': 'foreign' }, body: JSON.stringify(input) });
    expect(spoofed.status).toBe(403);
    const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw new Error('fixture workspace');
    const token = s.sessions.issue({ workspace: workspace.data, actorId: s.ctx.actorId, scopes: Object.values(SCOPES).filter((scope) => scope !== SCOPES.knowledgeWrite) });
    expect((await s.request('/approval', input, 'POST', { ...s.headers, Authorization: `Bearer ${token}` })).response.status).toBe(403);
    expect(s.git.prepare).not.toHaveBeenCalled(); expect(s.git.publish).not.toHaveBeenCalled();
  });

  it('honors authoritative revocation and expiry without creating a Git operation', async () => {
    const { fixture: s, input } = await setup();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    for (let index = 0; index < 2; index++) {
      expect(data((await s.request<{ revoked: boolean }>(`/approval/${approval.id}/revoke`, undefined, 'POST')).result)).toEqual({ revoked: true });
    }
    expect((await s.request('/commit', { ...input, approval })).response.status).toBe(403);
    const second = await platformPreview(s);
    const expiring = data((await s.request<Approval>('/approval', second.input)).result);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(expiring.expiresAt) + 1);
    expect((await s.request('/commit', { ...second.input, approval: expiring })).response.status).toBe(403);
    expect(s.git.prepare).not.toHaveBeenCalled(); expect(s.git.publish).not.toHaveBeenCalled();
  });

  it('allows only one concurrent operation from a shared base and preserves the losing draft', async () => {
    const { fixture: s, input } = await setup();
    const second = await platformPreview(s);
    const a = data((await s.request<Approval>('/approval', input)).result);
    const b = data((await s.request<Approval>('/approval', second.input)).result);
    const results = await Promise.all([s.request<CommitReceipt>('/commit', { ...input, approval: a }),
      s.request<CommitReceipt>('/commit', { ...second.input, approval: b })]);
    expect(results.map((entry) => entry.response.status).sort()).toEqual([200, 409]);
    const rejected = results.find((entry) => !entry.result.ok)!;
    expect(rejected.result).toMatchObject({ ok: false, error: { code: 'CONFLICT', dataState: 'preserved' } });
    const snapshot = data((await s.request<KnowledgeSnapshot>('/snapshot')).result);
    expect(snapshot.nodes.filter((node) => node.id === input.draft.node.id)).toHaveLength(1);
    expect(input.draft.node.confirmation).toBe('draft');
  });

  it('recovers an interrupted publication through GET only, with no second publication on replay', async () => {
    const { fixture: s, input } = await setup();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    const publish = vi.mocked(s.git.publish).getMockImplementation()!;
    vi.mocked(s.git.publish).mockImplementationOnce(async (request) => { await publish(request); throw new Error('fixture lost response'); });
    expect((await s.request('/commit', { ...input, approval })).result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    const recovered = data((await s.request<CommitReceipt>(`/receipt?changeSetId=${input.changes.id}`)).result);
    expect(recovered.indexing).toBe('pending');
    expect(data((await s.request<CommitReceipt>('/commit', { ...input, approval })).result)).toEqual(recovered);
    expect(s.git.publish).toHaveBeenCalledTimes(1);
  });

  it('never treats a missing or unreachable commit as proof of no write and does not republish', async () => {
    const { fixture: s, input } = await setup();
    const path = `/receipt?changeSetId=${input.changes.id}`;
    expect((await s.request(path)).result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    const approval = data((await s.request<Approval>('/approval', input)).result);
    vi.mocked(s.git.publish).mockRejectedValueOnce(new Error('fixture outcome unknown'));
    expect((await s.request('/commit', { ...input, approval })).response.status).toBe(409);
    expect((await s.request(path)).result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect((await s.request('/commit', { ...input, approval })).response.status).toBe(409);
    expect(s.git.publish).toHaveBeenCalledTimes(1);
  });

  it('can revoke and re-review after a lost conflict response is resolved by authoritative readback', async () => {
    const { fixture: s, input, preview } = await setup();
    const approval = data((await s.request<Approval>('/approval', input)).result);
    vi.mocked(s.git.publish).mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'Fixture CAS rejected',
      retryable: false, dataState: 'not_written', nextAction: 'preview_again' } });
    const commit = s.services.commit;
    s.services.commit = async (...args) => { await commit(...args); throw new Error('fixture dropped conflict response'); };
    const attempted = await s.request<CommitReceipt>('/commit', { ...input, approval });
    const uncertain = settleSubmission({ ...newSubmission(), preview, approval }, attempted.result);
    expect(uncertain.unknown).toBe(true);
    const readback = await s.request<CommitReceipt>(`/receipt?changeSetId=${input.changes.id}`);
    const resolved = settleReceiptRead(uncertain, readback.result);
    expect(resolved).toMatchObject({ unknown: false, rejected: true, approval, receipt: null });
    expect(data((await s.request<{ revoked: boolean }>(`/approval/${approval.id}/revoke`, undefined, 'POST')).result)).toEqual({ revoked: true });
    expect(s.git.publish).toHaveBeenCalledTimes(1);
    expect(data((await s.request<KnowledgeSnapshot>('/snapshot')).result).revision).toBe(s.base);
  });

  it('reads a completed receipt from the persisted journal after reopening without trusting the previous UI', async () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/handoff-platform-')); directories.push(directory);
    const file = join(directory, 'operations.sqlite');
    const { fixture: s, input } = await setup(file);
    const approval = data((await s.request<Approval>('/approval', input)).result);
    const receipt = data((await s.request<CommitReceipt>('/commit', { ...input, approval })).result);
    s.journal.close(); fixtures.splice(fixtures.indexOf(s), 1);
    const reopened = await handoffPlatformFixture(file); fixtures.push(reopened);
    expect(data((await reopened.request<CommitReceipt>(`/receipt?changeSetId=${input.changes.id}`)).result)).toEqual(receipt);
    expect(reopened.git.publish).not.toHaveBeenCalled();
    const workspace = await reopened.services.workspace(reopened.ctx); if (!workspace.ok) throw new Error('fixture workspace');
    const token = reopened.sessions.issue({ actorId: 'other-actor', workspace: workspace.data, scopes: Object.values(SCOPES) });
    expect((await reopened.request(`/receipt?changeSetId=${input.changes.id}`, undefined, 'GET', { ...reopened.headers, Authorization: `Bearer ${token}` })).response.status).toBe(403);
  });
});
