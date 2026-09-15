import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createServices } from './services';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { hashSegment, hashSettings } from '../contracts/hash';
import type { Candidate } from '../contracts/domain';
import type { ModelTransport } from './model';
import type { CandidateSaveOptions } from '../contracts/candidates';
import { CandidateStore } from './candidates';
import { createApp } from '../server/app';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
async function setup(file = ':memory:', empty = false) {
  const s = await platformFixture(file); if (file === ':memory:') journals.push(s.journal);
  const issue = { number: '7', title: 'Synthetic source', body: 'Confirmed synthetic source text', created_at: '2026-09-05T00:00:00Z', invisible: true };
  const original = s.transport.getMockImplementation()!;
  s.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : original(...args));
  const current = await s.services.readIssue(s.ctx, 7); if (!current.ok) throw new Error('Expected source');
  const conversation = current.data, segment = conversation.segments[1]!;
  const proposal = { title: 'Candidate', question: 'Which source?', claim: 'Synthetic claim', kind: 'claim' as const, whyKeep: 'Review this claim', uncertainties: ['Not independently verified'], spans: [{ segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text }] };
  const generatedAt = new Date().toISOString();
  const complete = vi.fn<ModelTransport['complete']>(async () => ({ ok: true, data: { value: { candidates: empty ? [] : [proposal] }, modelId: 'fixture-model', generatedAt } }));
  const model: ModelTransport = { mode: 'fixture', complete };
  const services = createServices({ ...s.options, model });
  async function setAI(enabled: boolean) {
    const state = await services.settingsState!(s.ctx); if (!state.ok) throw new Error('Expected settings');
    const settings = { ...state.data.settings, aiExtraction: enabled };
    const approved = await services.approveGovernance!(s.ctx, { purpose: 'settings', settings, baseRevision: s.base, expectedSettingsHash: await hashSettings(s.ctx.workspaceId, s.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true });
    if (!approved.ok) throw new Error('Expected settings approval'); await services.saveSettings(s.ctx, settings, approved.data);
  }
  await setAI(true);
  const input = { purpose: 'extract' as const, text: 'Selected synthetic input', sourceIds: [segment.id] };
  const approvalRequest = { input, objectIds: input.sourceIds, conversationId: conversation.id, baseRevision: conversation.contentHash, confirmed: true as const };
  const approved = await services.approveModel!(s.ctx, approvalRequest); if (!approved.ok) throw new Error('Expected model approval');
  expect((await services.complete(s.ctx, { ...input, approval: approved.data })).ok).toBe(true);
  const candidates: Candidate[] = empty ? [] : [{ ...proposal, id: 'candidate1', conversationId: conversation.id,
    spans: [{ ...proposal.spans[0]!, id: 'span1', conversationId: conversation.id, contentHash: await hashSegment(conversation.id, segment) }],
    sources: [{ id: 'span1', kind: 'conversation', title: 'Selected source', excerpt: segment.text, accessedAt: generatedAt, support: 'unverified', supportedClaim: proposal.claim, limitation: 'Only proves the quote exists' }],
    modelId: 'fixture-model', generatedAt, promptVersion: 'fixture-prompt', state: 'proposed' }];
  const options: CandidateSaveOptions = { modelApproval: approved.data, expectedConversationHash: conversation.contentHash, expectedRevision: 0, retentionDays: 7, confirmed: true };
  return { ...s, serviceOptions: s.options, services, model, complete, conversation, issue, candidates, options, input, approvalRequest, setAI };
}

describe('W10 private candidate batches bound to a completed extraction', () => {
  it('saves one immutable batch, verifies readback and keeps ordinary reads available after AI shutdown', async () => {
    const s = await setup();
    expect(await s.services.readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { revision: 0, state: 'missing', candidates: [] } });
    expect(await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options)).toEqual({ ok: true, data: s.candidates });
    expect(await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options)).toEqual({ ok: true, data: s.candidates });
    expect(await s.services.readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { revision: 1, state: 'available', modelApprovalId: s.options.modelApproval.id, retentionDays: 7 } });
    await s.setAI(false);
    expect(await s.services.readCandidates(s.ctx, s.conversation.id)).toEqual({ ok: true, data: s.candidates });
    expect(await s.services.readModelOperation!(s.ctx, s.options.modelApproval.id)).toMatchObject({ ok: true, data: { state: 'done', modelId: 'fixture-model', purpose: 'extract' } });
    expect(s.complete).toHaveBeenCalledTimes(1); expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('records an empty completed batch so it cannot be mistaken for a model operation that never ran', async () => {
    const s = await setup(':memory:', true);
    expect((await s.services.saveCandidates(s.ctx, s.conversation.id, [], s.options)).ok).toBe(true);
    expect(await s.services.readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'available', revision: 1, candidates: [], modelApprovalId: s.options.modelApproval.id } });
  });
  it('rejects missing consent, changed output, forged sources, stale revisions and deleted sources without persisting candidates', async () => {
    for (const variant of ['consent', 'output', 'source', 'model', 'revision', 'deleted']) {
      const s = await setup(); const candidates = structuredClone(s.candidates);
      if (variant === 'output') candidates[0]!.claim = 'Not produced by the approved model';
      if (variant === 'source') candidates[0]!.sources[0]!.excerpt = 'Unselected content';
      if (variant === 'model') candidates[0]!.modelId = 'invented-model';
      if (variant === 'deleted') s.journal.block(s.ctx.workspaceId, [s.conversation.id], 'blocked-source');
      const options = variant === 'consent' ? undefined : { ...s.options, ...(variant === 'revision' ? { expectedRevision: 1 } : {}) };
      expect((await s.services.saveCandidates(s.ctx, s.conversation.id, candidates, options)).ok).toBe(false);
      expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id)).toBeUndefined();
    }
  });
  it('rechecks settings, approval revocation and conversation version at the storage boundary', async () => {
    for (const variant of ['settings', 'revoked', 'source']) {
      const s = await setup();
      if (variant === 'settings') await s.setAI(false);
      if (variant === 'revoked') s.authority.revoke(s.ctx, s.options.modelApproval.id);
      if (variant === 'source') s.issue.body = 'Changed original';
      expect((await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options)).ok).toBe(false);
      expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id)).toBeUndefined();
    }
  });
  it('expires private payloads without representing expiration as proof of physical deletion or no model call', async () => {
    const s = await setup(); await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options);
    const row = s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id)!;
    s.journal.putRecord(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id, { ...row.value as object, expiresAt: '2000-01-01T00:00:00Z' }, row.version);
    expect(await s.services.readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'expired', candidates: [], modelApprovalId: s.options.modelApproval.id } });
    expect((await s.services.readCandidates(s.ctx, s.conversation.id)).ok).toBe(false);
    expect(JSON.stringify(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id))).not.toContain('Synthetic claim');
  });
  it('recovers identical candidates and model metadata after SQLite reopen without another model call', async () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/candidates-fixture-')); const file = join(directory, 'state.sqlite');
    const s = await setup(file);
    try {
      await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options); s.journal.close();
      const reopened = new OperationJournal(file, { fixture: true });
      try {
        const recovered = createServices({ ...s.serviceOptions, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened), model: s.model });
        expect(await recovered.readCandidates(s.ctx, s.conversation.id)).toEqual({ ok: true, data: s.candidates });
        expect(await recovered.readModelOperation!(s.ctx, s.options.modelApproval.id)).toMatchObject({ ok: true, data: { state: 'done' } });
        expect(s.complete).toHaveBeenCalledTimes(1);
      } finally { reopened.close(); }
    } finally { try { s.journal.close(); } catch { /* Already closed for recovery. */ } rmSync(directory, { recursive: true, force: true }); }
  });
  it('rechecks the source after asynchronous preparation and before the SQLite transaction', async () => {
    const s = await setup();
    const read = vi.fn(async () => {
      const result = await s.services.readConversation(s.ctx, s.conversation.id);
      if (read.mock.calls.length === 1) s.issue.body = 'Source changed after preparation';
      return result;
    });
    const store = new CandidateStore(s.sessions, s.journal, s.authority, read, () => { throw new Error('Changed sources must fail before settings'); });
    expect(await store.save(s.ctx, s.conversation.id, s.candidates, s.options)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id)).toBeUndefined();
  });
  it('allows only one immutable batch when two trusted sessions race with different payloads', async () => {
    const s = await setup();
    const second = s.sessions.context(new Request('http://localhost', { headers: s.headers }));
    if (!second.ok) throw new Error('Expected second context');
    const results = await Promise.all([
      s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options),
      s.services.saveCandidates(second.data, s.conversation.id, [{ ...s.candidates[0]!, id: 'other-candidate' }], s.options),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(s.journal.record(s.ctx.workspaceId, s.ctx.actorId, 'candidates', s.conversation.id)?.version).toBe(1);
    expect(s.complete).toHaveBeenCalledTimes(1);
  });
  it('does not return private batches or model metadata to forged or other identities', async () => {
    const s = await setup(); await s.services.saveCandidates(s.ctx, s.conversation.id, s.candidates, s.options);
    expect((await s.services.readCandidates({ ...s.ctx }, s.conversation.id)).ok).toBe(false);
    const workspace = await s.services.workspace(s.ctx); if (!workspace.ok) throw new Error('Expected workspace');
    const token = s.sessions.issue({ actorId: 'other-actor', workspace: workspace.data, scopes: [...s.ctx.scopes] });
    const other = s.sessions.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }));
    if (!other.ok) throw new Error('Expected other actor');
    expect(await s.services.readCandidateState!(other.data, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'missing', candidates: [] } });
    expect((await s.services.readModelOperation!(other.data, s.options.modelApproval.id)).ok).toBe(false);
    s.sessions.revoke(s.token);
    expect((await s.services.readCandidates(s.ctx, s.conversation.id)).ok).toBe(false);
  });
  it('reads model operation HTTP metadata after revocation without resending or exposing model text', async () => {
    const s = await setup(); s.authority.revoke(s.ctx, s.options.modelApproval.id);
    const app = createApp(s.services);
    const response = await app.request(`/api/workspace/model-operations/${s.options.modelApproval.id}`, { headers: s.headers });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, data: { state: 'done', approvalId: s.options.modelApproval.id, modelId: 'fixture-model' } });
    expect(JSON.stringify(body)).not.toContain(s.input.text);
    expect(JSON.stringify(body)).not.toContain(s.candidates[0]!.claim);
    expect(s.complete).toHaveBeenCalledTimes(1);
  });
});
