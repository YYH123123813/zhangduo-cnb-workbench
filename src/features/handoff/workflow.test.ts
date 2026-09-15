import { describe, expect, it, vi } from 'vitest';
import { unavailable } from '../../contracts/api';
import type { HandoffDraft } from '../../contracts/domain';
import { assessSource, setKeyCondition, writeStatement } from './model';
import type { Review } from './model';
import { restoreDraft, toDraft } from './draft';
import { draftOptions } from './testing/draft-options';
import type { HandoffPreview } from './preview';
import { workflowFixture } from './testing/workflow';
import { appFor } from './testing/app';
import { fixtureServices } from './testing/services';

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('H12 conversation to fixed-version formal knowledge (Services fixture only)', () => {
  it('traces human expression, judgment, source, boundary, relation, Issue and real fixture receipt across the entire API flow', async () => {
    const fixture = workflowFixture();
    const loaded = await fixture.app.request('/api/handoff/conversation-1');
    const review = (await loaded.json()).data as Review;
    let item = writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '当目标前提成立时，才采用本条限定结论。');
    const conditioned = setKeyCondition(item, '先核验目标前提', 'confirmed'); if (!conditioned.ok) throw Error('fixture'); item = conditioned.data;
    const assessed = assessSource(item, 'source-1', 'partial', '原句只支持先核验，不证明所有结论'); if (!assessed.ok) throw Error('fixture'); item = assessed.data;
    item.boundaries = ['不适用于前提已变化的任务'];
    const now = new Date().toISOString(); const target = fixture.current().nodes[0]!;
    item.relations = [{ id: 'workflow-relation', workspaceId: review.conversation.workspaceId,
      source: { workspaceId: review.conversation.workspaceId, objectId: item.nodeId, revision: fixture.current().revision },
      target: { workspaceId: target.workspaceId, objectId: target.id, revision: target.revision }, type: 'depends_on',
      rationale: '本条依赖目标前提', evidenceIds: ['source-1'], state: 'confirmed', proposedBy: review.actorId, confirmedBy: review.actorId, confirmedAt: now, updatedAt: now }];
    const draft = toDraft(review, item, fixture.current().revision, now); if (!draft.ok) throw Error('fixture');
    const saved = await fixture.app.request('/api/handoff/conversation-1/draft', json('PUT', { draft: draft.data, consent: true, options: draftOptions(draft.data) }));
    expect(saved.status).toBe(200);
    const read = await fixture.app.request(`/api/handoff/conversation-1/draft?draftId=${draft.data.id}`);
    const stored = (await read.json()).data as HandoffDraft;
    expect(restoreDraft(review, stored).ok).toBe(true);
    const previewResponse = await fixture.app.request('/api/handoff/conversation-1/preview', json('POST', { draft: stored, reason: '保留有条件的判断' }));
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()).data as HandoffPreview;
    expect(fixture.writes()).toBe(0);
    const approved = await fixture.app.request('/api/handoff/conversation-1/approval', json('POST', { draft: stored, changes: preview.changes, confirmed: true }));
    expect(approved.status).toBe(200);
    const approval = (await approved.json()).data;
    expect(fixture.writes()).toBe(0);
    const committed = await fixture.app.request('/api/handoff/conversation-1/commit', json('POST', { draft: stored, changes: preview.changes, approval, confirmed: true }));
    expect(committed.status).toBe(200);
    const receipt = (await committed.json()).data;
    const formal = fixture.current().nodes.find((node) => node.id === item.nodeId)!;
    expect(formal.humanStatement).toBe(item.statement); expect(formal.authorship).toBe('human_written');
    expect(formal.confirmedBy).toBe(review.actorId); expect(formal.evidenceStatus).toBe('partial');
    expect(formal.boundaries).toEqual(item.boundaries); expect(formal.sources[0]?.excerpt).toBe(item.subject.sources[0]!.excerpt);
    expect(formal.conversationId).toBe(review.conversation.id); expect(review.conversation.issueNumber).toBe(7);
    expect(formal.revision).toBe(receipt.revision);
    expect(fixture.current().relations[0]?.source.revision).toBe(receipt.revision);
    expect(fixture.current().relations[0]?.target.revision).toBe(target.revision);
    expect(fixture.services.complete).not.toHaveBeenCalled(); expect(fixture.services.saveConversation).not.toHaveBeenCalled();
  });
  it('has no default remote success when context is unconfigured', async () => {
    const services = fixtureServices({ context: async () => unavailable() });
    const app = appFor(services);
    for (const [method, path] of [['GET', 'status'], ['GET', 'conversation-1'], ['PUT', 'conversation-1/draft'], ['POST', 'conversation-1/preview'],
      ['POST', 'conversation-1/approval'], ['POST', 'conversation-1/commit'], ['GET', 'conversation-1/receipt']] as const) {
      const response = await app.request(`/api/handoff/${path}`, { method });
      expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.json(); expect(body.ok).toBe(false); expect(body.meta.mode).toBe('unconfigured');
    }
    expect(services.commit).not.toHaveBeenCalled(); expect(services.saveDraft).not.toHaveBeenCalled();
  });
  it('does not send a write from absent approval or readback bridges', async () => {
    const services = fixtureServices(); const app = appFor(services);
    expect((await app.request('/api/handoff/conversation-1/approval', json('POST', {}))).status).toBe(503);
    expect((await app.request('/api/handoff/conversation-1/receipt?changeSetId=operation-1')).status).toBe(503);
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('returns malformed JSON as a recoverable validation error before reading private content', async () => {
    const services = fixtureServices();
    const response = await appFor(services).request('/api/handoff/conversation-1/commit', { method: 'POST', body: '{bad json' });
    expect(response.status).toBe(422); expect(services.readConversation).not.toHaveBeenCalled();
  });
});
