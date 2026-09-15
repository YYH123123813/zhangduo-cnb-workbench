import { describe, expect, it } from 'vitest';
import type { Approval } from '../../contracts/domain';
import { toDraft } from './draft';
import { writeStatement } from './model';
import type { Review } from './model';
import type { HandoffPreview } from './preview';
import { workflowFixture } from './testing/workflow';

async function setup() {
  const fixture = workflowFixture();
  const review = (await (await fixture.app.request('/api/handoff/conversation-1')).json()).data as Review;
  const draft = toDraft(review, writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '我的限定陈述'), fixture.current().revision, new Date().toISOString());
  if (!draft.ok) throw Error('fixture');
  const preview = (await (await fixture.app.request('/api/handoff/conversation-1/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: draft.data, reason: '人工交接' }) })).json()).data as HandoffPreview;
  return { ...fixture, preview, approval: fixture.approve(preview.changes) };
}
function post(preview: HandoffPreview, approval: Approval, confirmed = true) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: preview.draft, changes: preview.changes, approval, confirmed }) };
}
describe('H10 explicit atomic commit', () => {
  it('commits once and replays the same operation after HEAD advances', async () => {
    const { app, preview, approval, writes, services } = await setup();
    expect(services.commit).not.toHaveBeenCalled();
    const first = await app.request('/api/handoff/conversation-1/commit', post(preview, approval));
    expect(first.status).toBe(200);
    const second = await app.request('/api/handoff/conversation-1/commit', post(preview, approval));
    expect(second.status).toBe(200);
    expect((await first.json()).data).toEqual((await second.json()).data);
    expect(writes()).toBe(1);
  });
  it('rejects expired, future, foreign, wrong-purpose and wrong-scope approvals before commit', async () => {
    const { app, preview, approval, services } = await setup();
    for (const patch of [{ expiresAt: '2020-01-01T00:00:00.000Z' }, { approvedAt: '2099-01-01T00:00:00.000Z' },
      { actorId: 'forged' }, { workspaceId: 'foreign' }, { purpose: 'save_conversation' as const }, { objectIds: [] }, { contentHash: 'forged' }]) {
      expect([403, 422]).toContain((await app.request('/api/handoff/conversation-1/commit', post(preview, { ...approval, ...patch }))).status);
    }
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('refuses cancellation and changed preview contents', async () => {
    const { app, preview, approval, services } = await setup();
    expect((await app.request('/api/handoff/conversation-1/commit', post(preview, approval, false))).status).toBe(422);
    preview.changes.nodes[0]!.humanStatement = '偷改正文';
    expect((await app.request('/api/handoff/conversation-1/commit', post(preview, approval))).status).toBe(422);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('delegates authoritative revocation and HEAD checks to Services', async () => {
    const { app, preview, approval, revoked, advanceHead, writes } = await setup();
    revoked.add(approval.id);
    expect((await app.request('/api/handoff/conversation-1/commit', post(preview, approval))).status).toBe(403);
    revoked.clear(); advanceHead();
    expect((await app.request('/api/handoff/conversation-1/commit', post(preview, approval))).status).toBe(409);
    expect(writes()).toBe(0);
  });
  it('preserves UNKNOWN_RESULT without retrying writes or inventing a receipt', async () => {
    const { app, preview, approval, interruptNext, services, writes } = await setup();
    interruptNext();
    const response = await app.request('/api/handoff/conversation-1/commit', post(preview, approval));
    const body = await response.json();
    expect(body.error.code).toBe('UNKNOWN_RESULT'); expect(body.data).toBeUndefined();
    expect(services.commit).toHaveBeenCalledTimes(1); expect(writes()).toBe(1);
  });
});
