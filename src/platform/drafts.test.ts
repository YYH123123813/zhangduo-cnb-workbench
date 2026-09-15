import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { createApp } from '../server/app';
import type { DraftSaveOptions, ReviewProgress } from '../contracts/handoff';
import type { HandoffDraft } from '../contracts/domain';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup(file = ':memory:') {
  const s = await platformFixture(file); if (file === ':memory:') journals.push(s.journal);
  const issue = { number: '7', title: 'Manual source', body: 'Private synthetic source', created_at: '2026-09-05T00:00:00Z', invisible: true };
  const original = s.transport.getMockImplementation()!;
  s.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : original(...args));
  const result = await s.services.readIssue(s.ctx, 7); if (!result.ok) throw new Error('Expected conversation');
  const conversation = result.data;
  const draft: HandoffDraft = { id: 'manual-draft', conversationId: conversation.id, candidateId: null, baseRevision: s.base, relations: [],
    node: { ...s.node, id: 'manual-knowledge', revision: s.base, conversationId: conversation.id, confirmation: 'draft', confirmedBy: undefined, confirmedAt: undefined } };
  delete draft.node.confirmedBy; delete draft.node.confirmedAt;
  const progress: ReviewProgress = { id: draft.id, workspaceId: s.ctx.workspaceId, conversationId: conversation.id, nodeId: draft.node.id,
    baseRevision: s.base, disposition: 'later', title: '', question: '', statement: '', kind: 'claim', authorship: 'human_written', conditions: [], boundaries: [], sources: [], relations: [],
    relationInput: { targetId: '', type: 'depends_on', direction: '', rationale: 'Incomplete relation', evidenceIds: [] } };
  const saveOptions: DraftSaveOptions = { operationId: 'draft-save-1', source: { kind: 'manual', spans: [] }, expectedConversationHash: conversation.contentHash,
    expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  return { ...s, issue, conversation, draft, progress, saveOptions };
}

describe('W10 private draft and partial-review persistence', () => {
  it('separates a missing draft from forbidden access and saves blank manual progress with AI disabled', async () => {
    const s = await setup();
    expect(await s.services.readDraftState!(s.ctx, s.draft.id)).toMatchObject({ ok: true, data: { state: 'missing', revision: 0, document: null } });
    expect(await s.services.readDraft(s.ctx, s.draft.id)).toMatchObject({ ok: false, error: { code: 'VALIDATION', nextAction: 'draft_missing' } });
    const saved = await s.services.saveReviewProgress!(s.ctx, s.progress, s.saveOptions);
    expect(saved).toMatchObject({ ok: true, data: { state: 'available', revision: 1, source: { kind: 'manual' }, document: { kind: 'progress', value: s.progress } } });
    expect(await s.services.readDraft(s.ctx, s.draft.id)).toMatchObject({ ok: false, error: { nextAction: 'read_review_progress' } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('shares one CAS version between partial progress and complete drafts and never overwrites the winner', async () => {
    const s = await setup();
    const saved = await s.services.saveReviewProgress!(s.ctx, s.progress, s.saveOptions); if (!saved.ok) throw new Error('Expected progress');
    const options = { ...s.saveOptions, expectedRevision: 1, expectedContentHash: saved.data.contentHash };
    const results = await Promise.all([
      s.services.saveDraft(s.ctx, s.draft, { ...options, operationId: 'complete-1' }),
      s.services.saveReviewProgress!(s.ctx, { ...s.progress, statement: 'Competing input' }, { ...options, operationId: 'progress-2' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await s.services.readDraftState!(s.ctx, s.draft.id)).toMatchObject({ ok: true, data: { revision: 2 } });
    expect((await s.services.saveDraft(s.ctx, s.draft, { ...options, operationId: 'stale-save' })).ok).toBe(false);
  });
  it('preserves the exact original operation receipt even when a later save changes the draft', async () => {
    const s = await setup(); expect(await s.services.saveDraft(s.ctx, s.draft, s.saveOptions)).toEqual({ ok: true, data: s.draft });
    const state = await s.services.readDraftState!(s.ctx, s.draft.id); if (!state.ok) throw new Error('Expected state');
    const receipt = await s.services.readDraftReceipt!(s.ctx, 'draft-save-1');
    expect(receipt).toMatchObject({ ok: true, data: { operationId: 'draft-save-1', revision: 1, previousRevision: 0, contentHash: state.data.contentHash } });
    const newer = { ...s.draft, node: { ...s.draft.node, humanStatement: 'Updated human statement' } };
    expect((await s.services.saveDraft(s.ctx, newer, { ...s.saveOptions, operationId: 'draft-save-2', expectedRevision: 1, expectedContentHash: state.data.contentHash })).ok).toBe(true);
    expect(await s.services.readDraftReceipt!(s.ctx, 'draft-save-1')).toEqual(receipt);
    expect(await s.services.readDraftReceipt!(s.ctx, 'never-sent')).toEqual({ ok: true, data: null });
    expect((await s.services.saveDraft(s.ctx, newer, s.saveOptions)).ok).toBe(false);
    const response = await createApp(s.services).request('/api/workspace/draft-receipts/draft-save-1', { headers: s.headers });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain(s.draft.node.humanStatement);
  });
  it('rejects missing consent, forged manual authorship, absent candidates, stale source and revoked access without saving', async () => {
    for (const variant of ['consent', 'authorship', 'candidate', 'source', 'revoked', 'forged']) {
      const s = await setup(); const draft = structuredClone(s.draft);
      if (variant === 'authorship') draft.node.authorship = 'ai_accepted';
      if (variant === 'source') s.issue.body = 'Changed source';
      if (variant === 'revoked') s.sessions.revoke(s.token);
      const options = variant === 'consent' ? undefined : variant === 'candidate' ? { ...s.saveOptions, source: { kind: 'candidate' as const, candidateId: 'missing' } } : s.saveOptions;
      expect((await s.services.saveDraft(variant === 'forged' ? { ...s.ctx } : s.ctx, draft, options)).ok).toBe(false);
      expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'handoff', s.draft.id)).toBeUndefined();
    }
  });
  it('reopens SQLite with the same original save and applies current deletion barriers to private content', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/drafts-fixture-')); const file = join(directory, 'state.sqlite');
    const s = await setup(file);
    try {
      await s.services.saveDraft(s.ctx, s.draft, s.saveOptions); s.journal.close();
      const journal = new OperationJournal(file, { fixture: true });
      try {
        const services = createServices({ ...s.options, journal, approvalAuthority: new ApprovalAuthority(s.sessions, journal) });
        expect(await services.readDraft(s.ctx, s.draft.id)).toEqual({ ok: true, data: s.draft });
        expect(await services.saveDraft(s.ctx, s.draft, s.saveOptions)).toEqual({ ok: true, data: s.draft });
        expect(await services.readDraftReceipt!(s.ctx, 'draft-save-1')).toMatchObject({ ok: true, data: { revision: 1 } });
        journal.block(s.ctx.workspaceId, [s.draft.node.id], 'delete-plan');
        expect((await services.readDraft(s.ctx, s.draft.id)).ok).toBe(false);
      } finally { journal.close(); }
    } finally { try { s.journal.close(); } catch { /* The original connection was closed for restart. */ } rmSync(directory, { recursive: true, force: true }); }
  });
  it('rolls back the payload and receipt together if the transaction cannot finish', async () => {
    const s = await setup();
    vi.spyOn(s.journal, 'addAudit').mockImplementationOnce(() => { throw new Error('Fixture disk failure'); });
    expect((await s.services.saveDraft(s.ctx, s.draft, s.saveOptions)).ok).toBe(false);
    expect(await s.services.readDraftState!(s.ctx, s.draft.id)).toMatchObject({ ok: true, data: { state: 'missing' } });
    expect(await s.services.readDraftReceipt!(s.ctx, s.saveOptions.operationId)).toEqual({ ok: true, data: null });
  });
  it('keeps other identities isolated and expires payloads without erasing operation metadata', async () => {
    const s = await setup(); await s.services.saveDraft(s.ctx, s.draft, s.saveOptions);
    const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw new Error('Expected workspace');
    const token = s.sessions.issue({ actorId: 'other-actor', workspace: workspace.data, scopes: [...s.ctx.scopes] });
    const other = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
    if (!other.ok) throw new Error('Expected other actor');
    expect(await s.services.readDraftState!(other.data, s.draft.id)).toMatchObject({ ok: true, data: { state: 'missing', document: null } });
    expect(await s.services.readDraftReceipt!(other.data, s.saveOptions.operationId)).toEqual({ ok: true, data: null });
    const row = s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'handoff', s.draft.id)!;
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'handoff', s.draft.id, { ...row.value as object, expiresAt: '2000-01-01T00:00:00Z' }, row.version);
    expect(await s.services.readDraftState!(s.ctx, s.draft.id)).toMatchObject({ ok: true, data: { state: 'expired', document: null, source: null } });
    expect(JSON.stringify(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'handoff', s.draft.id))).not.toContain(s.draft.node.humanStatement);
    expect(await s.services.readDraftReceipt!(s.ctx, s.saveOptions.operationId)).toMatchObject({ ok: true, data: { outcome: 'saved' } });
  });
  it('uses SQLite CAS across two independent service connections to the same durable file', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/draft-cas-fixture-')), file = join(directory, 'state.sqlite');
    const s = await setup(file), second = new OperationJournal(file, { fixture: true });
    try {
      const services = createServices({ ...s.options, journal: second, approvalAuthority: new ApprovalAuthority(s.sessions, second) });
      const results = await Promise.all([
        s.services.saveReviewProgress!(s.ctx, s.progress, s.saveOptions),
        services.saveReviewProgress!(s.ctx, { ...s.progress, statement: 'Second session' }, { ...s.saveOptions, operationId: 'other-operation' }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await s.services.readDraftState!(s.ctx, s.draft.id)).toEqual(await services.readDraftState!(s.ctx, s.draft.id));
    } finally { second.close(); s.journal.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
