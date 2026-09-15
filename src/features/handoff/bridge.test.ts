import { describe, expect, it, vi } from 'vitest';
import type { Approval, CommitReceipt } from '../../contracts/domain';
import { hashChangeSet } from '../../contracts/hash';
import { toDraft } from './draft';
import { writeStatement } from './model';
import type { Review } from './model';
import type { HandoffPreview } from './preview';
import { workflowFixture } from './testing/workflow';
import { context } from './testing/services';

const json = (value: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function setup() {
  const fixture = workflowFixture();
  const review = (await (await fixture.app.request('/api/handoff/conversation-1')).json()).data as Review;
  const item = writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '满足前提才可采用的人工陈述');
  const draft = toDraft(review, item, fixture.current().revision, new Date().toISOString());
  if (!draft.ok) throw Error('fixture');
  const preview = (await (await fixture.app.request('/api/handoff/conversation-1/preview', json({ draft: draft.data, reason: '人工交接' }))).json()).data as HandoffPreview;
  return { ...fixture, preview, input: { draft: preview.draft, changes: preview.changes, confirmed: true } };
}
describe('H12 contract 1.4 knowledge approval and receipt bridges', () => {
  it('registers only the exact reviewed operation through the shared port, with zero Git writes', async () => {
    const fixture = await setup();
    const response = await fixture.app.request('/api/handoff/conversation-1/approval', json(fixture.input));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ actorId: context.actorId, workspaceId: context.workspaceId, purpose: 'commit_knowledge', contentHash: fixture.preview.changes.contentHash });
    expect(fixture.services.approveKnowledge).toHaveBeenCalledWith(expect.objectContaining({ actorId: context.actorId }), { changes: fixture.preview.changes, confirmed: true });
    expect(vi.mocked(fixture.services.approveKnowledge!).mock.calls[0]?.[0]).toBe(context);
    expect(fixture.services.commit).not.toHaveBeenCalled();
    expect(fixture.writes()).toBe(0);
  });
  it('rejects refusal, altered content, forged identity and lost write scope before registration', async () => {
    const fixture = await setup();
    expect((await fixture.app.request('/api/handoff/conversation-1/approval', json({ ...fixture.input, confirmed: false }))).status).toBe(422);
    const changes = structuredClone(fixture.preview.changes); changes.nodes[0]!.humanStatement = '不属于预览的陈述'; changes.contentHash = await hashChangeSet(changes);
    expect((await fixture.app.request('/api/handoff/conversation-1/approval', json({ ...fixture.input, changes }))).status).toBe(422);
    expect((await fixture.app.request('/api/handoff/conversation-1/approval', json({ ...fixture.input, actorId: 'attacker' }))).status).toBe(422);
    fixture.services.context = async () => ({ ok: true, data: { ...context, scopes: context.scopes.filter((scope) => scope !== 'knowledge:write') } });
    expect((await fixture.app.request('/api/handoff/conversation-1/approval', json(fixture.input))).status).toBe(403);
    expect(fixture.services.approveKnowledge).not.toHaveBeenCalled();
  });
  it('reports malformed or wrongly scoped issuer responses as unknown registration, never usable approval', async () => {
    const fixture = await setup();
    fixture.services.approveKnowledge = async () => ({ ok: true, data: { ...fixture.approve(fixture.preview.changes), objectIds: ['unrelated-node'] } });
    const response = await fixture.app.request('/api/handoff/conversation-1/approval', json(fixture.input));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'check_approval' });
    expect(fixture.services.commit).not.toHaveBeenCalled();
  });
  it('recovers a completed but interrupted write using GET alone and preserves the exact operation', async () => {
    const fixture = await setup();
    const approved = await fixture.app.request('/api/handoff/conversation-1/approval', json(fixture.input));
    const approval = (await approved.json()).data as Approval;
    fixture.interruptNext();
    const submitted = await fixture.app.request('/api/handoff/conversation-1/commit', json({ ...fixture.input, approval }));
    expect((await submitted.json()).error.code).toBe('UNKNOWN_RESULT');
    const recovered = await fixture.app.request(`/api/handoff/conversation-1/receipt?changeSetId=${fixture.preview.changes.id}`);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).data).toMatchObject({ changeSetId: fixture.preview.changes.id, revision: fixture.current().revision, indexing: 'pending' });
    expect(fixture.services.commit).toHaveBeenCalledTimes(1);
    expect(fixture.services.readCommit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fixture.services.readCommit!).mock.calls[0]?.[0]).toBe(context);
    expect(fixture.writes()).toBe(1);
  });
  it('keeps a null or corrupted readback unknown rather than claiming the write never happened', async () => {
    const fixture = await setup(); const path = `/api/handoff/conversation-1/receipt?changeSetId=${fixture.preview.changes.id}`;
    const missing = await fixture.app.request(path);
    expect((await missing.json()).error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown' });
    const corrupt: CommitReceipt = { changeSetId: 'another-operation', revision: 'fixture-commit', commitUrl: 'https://cnb.cool/fixture', indexing: 'pending' };
    fixture.services.readCommit = async () => ({ ok: true, data: corrupt });
    expect((await (await fixture.app.request(path)).json()).error.code).toBe('UNKNOWN_RESULT');
    expect(fixture.services.commit).not.toHaveBeenCalled();
  });
  it('requires a valid operation and read permission before calling readCommit', async () => {
    const fixture = await setup();
    expect((await fixture.app.request('/api/handoff/conversation-1/receipt')).status).toBe(422);
    fixture.services.context = async () => ({ ok: true, data: { ...context, scopes: ['*'] } });
    expect((await fixture.app.request('/api/handoff/conversation-1/receipt?changeSetId=operation-1')).status).toBe(403);
    expect(fixture.services.readCommit).not.toHaveBeenCalled();
  });
  it('revokes a registered approval through its shared port and rejects its later commit', async () => {
    const fixture = await setup();
    const approved = await fixture.app.request('/api/handoff/conversation-1/approval', json(fixture.input));
    const approval = (await approved.json()).data as Approval;
    for (let index = 0; index < 2; index++) {
      const revoked = await fixture.app.request(`/api/handoff/conversation-1/approval/${approval.id}/revoke`, { method: 'POST' });
      expect((await revoked.json()).data).toEqual({ revoked: true });
    }
    expect((await fixture.app.request('/api/handoff/conversation-1/commit', json({ ...fixture.input, approval }))).status).toBe(403);
    expect(fixture.writes()).toBe(0);
  });
});
