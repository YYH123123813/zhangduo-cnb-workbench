import { describe, expect, it, vi } from 'vitest';
import type { HandoffDraft } from '../../contracts/domain';
import type { Review } from './model';
import { writeStatement } from './model';
import { toDraft, restoreDraft, verifyDraftReadback } from './draft';
import { appFor } from './testing/app';
import { fixtureServices, context } from './testing/services';
import { snapshot } from './testing/knowledge';
import { time } from './testing/fixtures';
import { relation } from './testing/knowledge';
import { draftOptions } from './testing/draft-options';

async function setup() {
  const store = new Map<string, HandoffDraft>();
  const services = fixtureServices({ snapshot: async () => ({ ok: true, data: structuredClone(snapshot) }),
    saveDraft: vi.fn(async (_ctx, draft) => { store.set(draft.id, structuredClone(draft)); return { ok: true as const, data: draft }; }),
    readDraft: vi.fn(async (_ctx, id) => store.has(id) ? { ok: true as const, data: structuredClone(store.get(id)!) } :
      { ok: false as const, error: { code: 'VALIDATION' as const, message: 'Draft does not exist', retryable: false, dataState: 'not_written' as const, nextAction: 'create_draft' } }),
  });
  const app = appFor(services);
  const review = (await (await app.request('/api/handoff/conversation-1')).json()).data as Review;
  const item = writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '我的限定陈述');
  const result = toDraft(review, item, snapshot.revision, time);
  if (!result.ok) throw Error('fixture');
  return { app, services, draft: result.data, review, store };
}
const request = (draft: HandoffDraft, consent = true) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft, consent, options: draftOptions(draft) }) });
describe('H07 durable draft port flow', () => {
  it('saves a draft, verifies readback and restores exactly the selected candidate', async () => {
    const { app, services, draft, review } = await setup();
    const saved = await app.request('/api/handoff/conversation-1/draft', request(draft));
    expect(saved.status).toBe(200);
    expect(services.readDraft).toHaveBeenCalled();
    const response = await app.request(`/api/handoff/conversation-1/draft?draftId=${draft.id}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    const restored = restoreDraft(review, body.data);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data.items[0]?.statement).toBe('我的限定陈述');
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('refuses cancellation, empty statements, forged sources and foreign identities', async () => {
    const { app, services, draft } = await setup();
    expect((await app.request('/api/handoff/conversation-1/draft', request(draft, false))).status).toBe(422);
    for (const node of [{ ...draft.node, humanStatement: ' ' }, { ...draft.node, workspaceId: 'foreign' },
      { ...draft.node, sources: [{ ...draft.node.sources[0]!, excerpt: '篡改原句' }] }]) {
      expect((await app.request('/api/handoff/conversation-1/draft', request({ ...draft, node }))).status).not.toBe(200);
    }
    expect(services.saveDraft).not.toHaveBeenCalled();
  });
  it('rejects stale base versions and missing draft permission', async () => {
    const { services, draft } = await setup();
    expect((await appFor(services).request('/api/handoff/conversation-1/draft', request({ ...draft, baseRevision: 'fixture-old' }))).status).toBe(409);
    services.context = async () => ({ ok: true, data: { ...context, scopes: [ 'conversation:read', 'candidate:read', 'knowledge:read' ] } });
    expect((await appFor(services).request('/api/handoff/conversation-1/draft', request(draft))).status).toBe(403);
    expect(services.saveDraft).not.toHaveBeenCalled();
  });
  it('reports unknown readback instead of saved and does not retry writes', async () => {
    const { services, draft } = await setup();
    services.readDraft = async () => ({ ok: false, error: { code: 'UPSTREAM', message: 'offline', retryable: true, dataState: 'unknown', nextAction: 'read_back' } });
    const response = await appFor(services).request('/api/handoff/conversation-1/draft', request(draft));
    expect((await response.json()).error.code).toBe('UNKNOWN_RESULT');
    expect(services.saveDraft).toHaveBeenCalledTimes(1);
  });
  it('reuses the same draft ID for repeated saves without duplicating objects', async () => {
    const { app, draft, store } = await setup();
    await app.request('/api/handoff/conversation-1/draft', request(draft));
    await app.request('/api/handoff/conversation-1/draft', request(draft));
    expect(store.size).toBe(1);
  });
  it('does not resolve an uncertain write just because an older draft can be read', async () => {
    const { draft } = await setup();
    const older = { ...draft, node: { ...draft.node, humanStatement: '旧草稿正文' } };
    expect(verifyDraftReadback(draft, older)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_back' } });
    expect(verifyDraftReadback(draft, null)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    expect(verifyDraftReadback(draft, structuredClone(draft))).toEqual({ ok: true, data: draft });
  });
  it('rejects mismatching readback after saving without retrying the write', async () => {
    const { services, draft } = await setup();
    services.readDraft = async () => ({ ok: true, data: { ...draft, node: { ...draft.node, boundaries: ['来自其他编辑者'] } } });
    const response = await appFor(services).request('/api/handoff/conversation-1/draft', request(draft));
    expect((await response.json()).error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown' });
    expect(services.saveDraft).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupted source provenance and references before restoring their text', async () => {
    const { review, draft } = await setup();
    for (const node of [
      { ...draft.node, sources: [{ ...draft.node.sources[0]!, excerpt: '被改写的原句' }] },
      { ...draft.node, candidateIds: ['another-candidate'] },
      { ...draft.node, revision: 'wrong-base' },
      { ...draft.node, confirmation: 'confirmed' as const, confirmedBy: 'someone-else', confirmedAt: time },
    ]) {
      expect(restoreDraft(review, { ...draft, node })).toMatchObject({ ok: false });
      expect(review.items[0]?.statement).toBe('');
    }
  });
  it('restores someone else\'s recorded confirmations as requiring a fresh human decision', async () => {
    const { review, draft } = await setup();
    review.items[0]!.relationInput.rationale = '将被明确替换的表单';
    draft.node.conditions = [{ id: 'key-condition', text: '有条件成立', status: 'confirmed', confirmedBy: 'another-actor', evidenceIds: [] }];
    draft.relations = [{ ...relation(), confirmedBy: 'another-actor', source: { workspaceId: context.workspaceId, objectId: draft.node.id, revision: draft.baseRevision } }];
    const restored = restoreDraft(review, draft);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const item = restored.data.items[0]!;
    expect(item.conditions[0]).toMatchObject({ status: 'unknown', text: '有条件成立' });
    expect(item.conditions[0]?.confirmedBy).toBeUndefined();
    expect(item.relations[0]?.state).toBe('proposed');
    expect(item.relations[0]?.rationale).toBe(draft.relations[0]?.rationale);
    expect(item.relationInput.rationale).toBe('');
  });
});
