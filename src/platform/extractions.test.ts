import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Candidate } from '../contracts/domain';
import { contentHash, hashSegment, hashSettings } from '../contracts/hash';
import type { ModelTransport } from './model';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { createServices } from './services';
import { createApp } from '../server/app';
import { platformFixture } from '../../tests/integration/platform-fixture';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
async function setup() {
  mkdirSync('.local', { recursive: true });
  const directory = mkdtempSync(resolve('.local/extractions-fixture-')), file = join(directory, 'state.sqlite');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const base = await platformFixture(file);
  let journal = base.journal; cleanups.push(() => journal.close());
  const issue = { number: '7', title: 'Private synthetic title', body: 'Private synthetic source text', created_at: '2026-09-05T00:00:00Z', invisible: true };
  const transport = base.transport.getMockImplementation()!;
  base.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : transport(...args));
  const source = await base.services.readIssue(base.ctx, 7); if (!source.ok) throw Error('Expected synthetic source');
  const conversation = source.data, segment = conversation.segments[1]!;
  const projection = { title: 'Private candidate', question: 'Question', claim: 'Private synthetic claim', kind: 'claim' as const, whyKeep: 'Reason', uncertainties: [],
    spans: [{ segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text }] };
  const generatedAt = new Date().toISOString();
  const complete = vi.fn<ModelTransport['complete']>(async () => ({ ok: true, data: { value: { candidates: [projection] }, modelId: 'synthetic-model', generatedAt } }));
  const model: ModelTransport = { mode: 'fixture', complete };
  const build = (db: OperationJournal) => createServices({ ...base.options, journal: db, approvalAuthority: new ApprovalAuthority(base.sessions, db), model });
  let services = build(journal);
  async function setAI(enabled: boolean) {
    const state = await services.settingsState!(base.ctx); if (!state.ok) throw Error('Expected settings');
    const settings = { ...state.data.settings, aiExtraction: enabled };
    const approval = await services.approveGovernance!(base.ctx, { purpose: 'settings', settings, baseRevision: base.base,
      expectedSettingsHash: await hashSettings(base.ctx.workspaceId, base.base, state.data.settings), expectedSettingsRevision: state.data.revision, confirmed: true });
    if (!approval.ok || !(await services.saveSettings(base.ctx, settings, approval.data)).ok) throw Error('Expected AI policy');
  }
  await setAI(true);
  const input = { purpose: 'extract' as const, text: 'Private synthetic model input', sourceIds: [segment.id] };
  const request = { input, objectIds: input.sourceIds, conversationId: conversation.id, baseRevision: conversation.contentHash, confirmed: true as const };
  async function approve() { const result = await services.approveModel!(base.ctx, { ...request, operationId: crypto.randomUUID() }); if (!result.ok) throw Error(JSON.stringify(result)); return result.data; }
  const approval = await approve();
  const candidates: Candidate[] = [{ ...projection, id: 'candidate1', conversationId: conversation.id,
    spans: [{ ...projection.spans[0]!, id: 'span1', conversationId: conversation.id, contentHash: await hashSegment(conversation.id, segment) }],
    sources: [{ id: 'span1', kind: 'conversation', title: 'Source', excerpt: segment.text, accessedAt: generatedAt, support: 'unverified', supportedClaim: projection.claim, limitation: 'Only proves the selected quote exists' }],
    modelId: 'synthetic-model', generatedAt, promptVersion: 'synthetic-v1', state: 'proposed' }];
  const saveOptions = { modelApproval: approval, expectedConversationHash: conversation.contentHash, expectedRevision: 0, retentionDays: 7 as const, confirmed: true as const };
  return { ...base, issue, conversation, segment, projection, input, request, approve, approval, candidates, saveOptions, complete, setAI,
    services: () => services, journal: () => journal,
    reopen() { journal.close(); journal = new OperationJournal(file, { fixture: true }); services = build(journal); },
    peer() { const db = new OperationJournal(file, { fixture: true }); cleanups.push(() => db.close()); return { journal: db, services: build(db) }; },
    async read(path: string, headers = base.headers) { const response = await createApp(services).request(path, { headers }); expect(response.headers.get('Cache-Control')).toBe('no-store'); return response.json(); },
  };
}

describe('W2-REQ-009 durable extraction stages and original-operation discovery', () => {
  it('rejects invalid references before candidate saving and reads the terminal after SQLite reopen', async () => {
    const s = await setup();
    s.complete.mockResolvedValue({ ok: true, data: { value: { candidates: [{ ...s.projection, spans: [{ ...s.projection.spans[0]!, quote: 'INVALID' }] }] }, modelId: 'synthetic-model', generatedAt: new Date().toISOString() } });
    expect(await s.services().complete(s.ctx, { ...s.input, approval: s.approval })).toMatchObject({ ok: false, error: { code: 'UPSTREAM' } });
    s.reopen();
    const receipt = { operationId: s.approval.id, modelApprovalId: s.approval.id, conversationId: s.conversation.id, actorId: s.ctx.actorId, workspaceId: s.ctx.workspaceId,
      conversationHash: s.conversation.contentHash, inputHash: s.approval.contentHash, stage: 'rejected_without_save', rejectionReason: 'invalid_reference', retryAllowed: false };
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`)).toMatchObject({ ok: true, data: receipt });
    expect(await s.read(`/api/workspace/conversations/${s.conversation.id}/extractions`)).toMatchObject({ ok: true, data: { operations: [receipt], absenceIsFinal: false } });
    expect(await s.services().readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'missing', revision: 0 } });
    expect((await s.services().saveCandidates(s.ctx, s.conversation.id, s.candidates, s.saveOptions)).ok).toBe(false);
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it.each([false, true])('commits the %s empty batch receipt in the same candidate transaction, including lost responses', async (empty) => {
    const s = await setup(); if (empty) s.complete.mockResolvedValue({ ok: true, data: { value: { candidates: [] }, modelId: 'synthetic-model', generatedAt: new Date().toISOString() } });
    expect((await s.services().complete(s.ctx, { ...s.input, approval: s.approval })).ok).toBe(true);
    const candidates = empty ? [] : s.candidates;
    const save = s.services().saveCandidates;
    await expect((async () => { expect((await save(s.ctx, s.conversation.id, candidates, s.saveOptions)).ok).toBe(true); throw Error('Synthetic lost response'); })()).rejects.toThrow('Synthetic lost response');
    s.reopen();
    const result = await s.read(`/api/workspace/extraction-operations/${s.approval.id}`);
    expect(result).toMatchObject({ ok: true, data: { stage: empty ? 'saved_empty' : 'saved_nonempty', batchRevision: 1, candidateContentHash: await contentHash(candidates), modelApprovalId: s.approval.id } });
    expect(await s.services().readCandidates(s.ctx, s.conversation.id)).toEqual({ ok: true, data: candidates });
    const encoded = JSON.stringify(result);
    for (const text of [s.input.text, s.segment.text, s.projection.claim]) expect(encoded).not.toContain(text);
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it('allows already-approved concurrent calls, while candidate CAS remains the final winner', async () => {
    const s = await setup(), second = await s.approve(), peer = s.peer();
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }), normal = s.complete.getMockImplementation()!;
    s.complete.mockImplementation(async (...args) => { await barrier; return normal(...args); });
    const a = s.services().complete(s.ctx, { ...s.input, approval: s.approval });
    const b = peer.services.complete(s.ctx, { ...s.input, approval: second });
    try { await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2)); }
    finally { release(); }
    const results = await Promise.all([a, b]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(s.journal().extractionOperationIds(s.ctx.workspaceId, s.ctx.actorId, s.conversation.id)).toHaveLength(2);
  });
  it('discovers an unknown original after restart and rejects a new paid attempt even after the old approval is revoked', async () => {
    const s = await setup(), second = await s.approve(); s.complete.mockRejectedValue(Error('Synthetic upstream unknown'));
    expect(await s.services().complete(s.ctx, { ...s.input, approval: s.approval })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    await s.services().revokeApproval!(s.ctx, s.approval.id); s.reopen();
    expect(await s.read(`/api/workspace/conversations/${s.conversation.id}/extractions`)).toMatchObject({ ok: true, data: { operations: [{ operationId: s.approval.id, stage: 'unknown' }] } });
    expect(await s.services().complete(s.ctx, { ...s.input, approval: second })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it('rolls candidate content back when the matching original terminal cannot be stored', async () => {
    const s = await setup(); await s.services().complete(s.ctx, { ...s.input, approval: s.approval });
    const original = s.journal().putRecord.bind(s.journal());
    const write = vi.spyOn(s.journal(), 'putRecord').mockImplementation((...args) => {
      if (args[2] === 'model_operation' && JSON.stringify(args[4]).includes('saved_nonempty')) return false;
      return original(...args);
    });
    expect(await s.services().saveCandidates(s.ctx, s.conversation.id, s.candidates, s.saveOptions)).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    write.mockRestore(); s.reopen();
    expect(await s.services().readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'missing' } });
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`)).toMatchObject({ ok: true, data: { stage: 'candidate_saving' } });
    expect(s.complete).toHaveBeenCalledOnce();
  });
  it('keeps the receipt after payload expiry and AI shutdown, but blocks reads after source deletion', async () => {
    const s = await setup(); await s.services().complete(s.ctx, { ...s.input, approval: s.approval });
    await s.services().saveCandidates(s.ctx, s.conversation.id, s.candidates, s.saveOptions);
    await s.setAI(false); s.journal().expirePrivatePayloads(new Date(Date.now() + 8 * 86_400_000).toISOString()); s.reopen();
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`)).toMatchObject({ ok: true, data: { stage: 'saved_nonempty', batchRevision: 1 } });
    expect(await s.services().readCandidateState!(s.ctx, s.conversation.id)).toMatchObject({ ok: true, data: { state: 'expired', candidates: [] } });
    s.journal().block(s.ctx.workspaceId, [s.segment.id], 'delete1');
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.read(`/api/workspace/conversations/${s.conversation.id}/extractions`)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('does not disclose private operation metadata across identities, forged contexts or revoked sessions', async () => {
    const s = await setup(); await s.services().complete(s.ctx, { ...s.input, approval: s.approval });
    const workspace = await s.services().workspace(s.ctx); if (!workspace.ok) throw Error('Expected workspace');
    const other = s.sessions.issue({ actorId: 'another-actor', workspace: workspace.data, scopes: [...s.ctx.scopes] });
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`, { ...s.headers, Authorization: `Bearer ${other}` })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const onlyWorkspace = s.sessions.issue({ actorId: s.ctx.actorId, workspace: workspace.data, scopes: ['workspace:read'] });
    const before = s.transport.mock.calls.length;
    expect(await s.read(`/api/workspace/conversations/${s.conversation.id}/extractions`, { ...s.headers, Authorization: `Bearer ${onlyWorkspace}` })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await s.services().readExtractionOperation!({ ...s.ctx }, s.approval.id)).toMatchObject({ ok: false });
    s.sessions.revoke(s.token);
    expect(await s.read(`/api/workspace/extraction-operations/${s.approval.id}`)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(s.transport).toHaveBeenCalledTimes(before);
  });
  it('discovers legacy model operations as unknown without inventing a no-save terminal or permitting another send', async () => {
    const s = await setup(), second = await s.approve();
    s.journal().putRecord(s.ctx.workspaceId, '@workspace', 'model_operation', s.approval.id,
      { actorId: s.ctx.actorId, contentHash: s.approval.contentHash, purpose: 'extract', state: 'done', date: '2026-09-09', expiresAt: Date.now(), modelId: 'old-model' }, null);
    s.reopen();
    const discovered = await s.read(`/api/workspace/conversations/${s.conversation.id}/extractions`);
    expect(discovered).toMatchObject({ ok: true, data: { operations: [{ operationId: s.approval.id, stage: 'unknown', legacy: true }], absenceIsFinal: false } });
    expect(await s.services().complete(s.ctx, { ...s.input, approval: second })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('records a durable not-sent proof before transmission and refuses the same approval afterward', async () => {
    const s = await setup();
    const close = await s.services().closeModelOperation!(s.ctx, { approvalId: s.approval.id, purpose: 'extract', contentHash: s.approval.contentHash, baseRevision: s.conversation.contentHash, confirmed: true });
    expect(close).toMatchObject({ ok: true, data: { state: 'not_sent', approvalId: s.approval.id } });
    expect(await s.services().readModelOperation!(s.ctx, s.approval.id)).toMatchObject({ ok: true, data: { state: 'not_sent' } });
    expect(await s.services().complete(s.ctx, { ...s.input, approval: s.approval })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(s.complete).not.toHaveBeenCalled();
    expect(await s.read(`/api/workspace/model-operations/${s.approval.id}`)).toMatchObject({ ok: true, data: { state: 'not_sent' } });
    expect(await s.read(`/api/workspace/model-operations/${s.approval.id}/close`, s.headers)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
  it('does not convert an already claimed transmission into not-sent', async () => {
    const s = await setup();
    expect((await s.services().complete(s.ctx, { ...s.input, approval: s.approval })).ok).toBe(true);
    expect(await s.services().closeModelOperation!(s.ctx, { approvalId: s.approval.id, purpose: 'extract', contentHash: s.approval.contentHash, baseRevision: s.conversation.contentHash, confirmed: true })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(await s.services().readModelOperation!(s.ctx, s.approval.id)).toMatchObject({ ok: true, data: { state: 'done' } });
  });
});
