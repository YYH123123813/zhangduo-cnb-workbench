import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApiResponse } from '../../contracts/api';
import type { DraftReceipt, DraftSaveOptions, DraftState } from '../../contracts/handoff';
import { createServices } from '../../platform/services';
import { OperationJournal } from '../../platform/journal';
import { ApprovalAuthority } from '../../platform/approvals';
import { SCOPES } from '../../contracts/scopes';
import { handoffPlatformFixture } from './testing/platform';
import { appFor } from './testing/app';
import type { Review } from './model';
import { restoreProgressState, toProgress, verifyProgressReceipt } from './progress';
import type { ProgressSaveResult } from './progress';

const fixtures: Awaited<ReturnType<typeof handoffPlatformFixture>>[] = [], directories: string[] = [];
afterEach(() => { fixtures.splice(0).forEach((s) => s.journal.close()); directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const data = <T>(result: ApiResponse<T> | { ok: true; data: T } | { ok: false; error: unknown }): T => { if (!result.ok) throw Error(JSON.stringify(result)); return result.data; };
async function setup(file?: string) {
  const s = await handoffPlatformFixture(file); fixtures.push(s);
  const review = data((await s.request<Review>('')).result);
  const progress = data(toProgress(review, review.items[0]!, s.base));
  const options: DraftSaveOptions = { operationId: 'progress-save-1', source: { kind: 'candidate', candidateId: review.items[0]!.subject.id },
    expectedConversationHash: s.source.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
  return { s, review, progress, options };
}

describe('H07 actual shared candidate and draft Services over synthetic transports, not CNB live', () => {
  it('persists blank decisions and empty condition text, restores all unfinished fields and never writes Git', async () => {
    const { s, review, progress, options } = await setup();
    expect(vi.isMockFunction(s.services.readCandidates)).toBe(false);
    expect(vi.isMockFunction(s.services.saveDraft)).toBe(false);
    expect(data(await s.services.readDraftState!(s.ctx, progress.id))).toMatchObject({ state: 'missing', revision: 0 });
    progress.conditions[0]!.text = ''; progress.relationInput.rationale = '半完成关系';
    const saved = data((await s.request<ProgressSaveResult>('/progress', { progress, options }, 'PUT')).result);
    expect(saved.receipt).toMatchObject({ operationId: options.operationId, previousRevision: 0, revision: 1 });
    const read = data((await s.request<DraftState>(`/draft-state?draftId=${progress.id}`)).result);
    const restored = data(await restoreProgressState(review, read));
    expect(restored.items[0]).toMatchObject({ statement: '', disposition: null, conditions: [{ text: '' }], relationInput: { rationale: '半完成关系' } });
    expect(await s.services.readDraft(s.ctx, progress.id)).toMatchObject({ ok: false, error: { nextAction: 'read_review_progress' } });
    expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('lets only one of two sessions save from the same revision, preserving the other local edit', async () => {
    const { s, progress, options } = await setup();
    const workspace = data(await s.services.workspace(s.ctx));
    const token = s.sessions.issue({ actorId: s.ctx.actorId, workspace, scopes: Object.values(SCOPES) });
    const requests = [
      s.request<ProgressSaveResult>('/progress', { progress: { ...progress, statement: '会话 A' }, options }, 'PUT'),
      s.request<ProgressSaveResult>('/progress', { progress: { ...progress, statement: '会话 B' }, options: { ...options, operationId: 'progress-save-B' } }, 'PUT', { ...s.headers, Authorization: `Bearer ${token}` }),
    ];
    const results = await Promise.all(requests);
    expect(results.filter(({ result }) => result.ok)).toHaveLength(1);
    expect(results.find(({ result }) => !result.ok)?.result).toMatchObject({ error: { code: 'CONFLICT', dataState: 'preserved' } });
    expect(data(await s.services.readDraftState!(s.ctx, progress.id)).revision).toBe(1);
    expect(progress.statement).toBe(''); expect(s.git.publish).not.toHaveBeenCalled();
  });
  it('recovers a dropped save response by the original receipt even after a later save changed the document', async () => {
    const { s, progress, options } = await setup();
    const save = s.services.saveReviewProgress!;
    s.services.saveReviewProgress = vi.fn(async (...args: Parameters<typeof save>) => { await save(...args); throw Error('lost response'); });
    expect((await s.request('/progress', { progress, options }, 'PUT')).result).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
    const state = data(await s.services.readDraftState!(s.ctx, progress.id));
    expect(data(await save(s.ctx, { ...progress, statement: '较新的编辑' }, { ...options, operationId: 'new-save', expectedRevision: state.revision, expectedContentHash: state.contentHash })).revision).toBe(2);
    const receipt = data((await s.request<DraftReceipt>(`/draft-receipt?draftId=${progress.id}&operationId=${options.operationId}`)).result);
    expect((await verifyProgressReceipt({ progress, options }, receipt, s.ctx)).ok).toBe(true);
    expect(receipt.revision).toBe(1); expect(s.services.saveReviewProgress).toHaveBeenCalledTimes(1);
    expect((await s.request(`/draft-receipt?draftId=${progress.id}&operationId=absent`)).result).toMatchObject({ ok: false, error: { dataState: 'unknown' } });
  });
  it('reopens the shared SQLite state without replaying model, draft or Git writes', async () => {
    mkdirSync('.local', { recursive: true }); const dir = mkdtempSync(resolve('.local/handoff-progress-')); directories.push(dir);
    const file = join(dir, 'state.sqlite'); const { s, review, progress, options } = await setup(file);
    data((await s.request<ProgressSaveResult>('/progress', { progress, options }, 'PUT')).result);
    s.journal.close(); fixtures.splice(fixtures.indexOf(s), 1);
    const reopened = new OperationJournal(file, { fixture: true });
    try {
      const services = createServices({ ...s.options, journal: reopened, approvalAuthority: new ApprovalAuthority(s.sessions, reopened) });
      const response = await appFor(services).request(`/api/handoff/${s.source.id}/draft-state?draftId=${progress.id}`, { headers: s.headers });
      const state = data(await response.json() as ApiResponse<DraftState>);
      expect(data(await restoreProgressState(review, state)).items[0]?.draftVersion?.revision).toBe(1);
      expect(data(await services.readCandidates(s.ctx, s.source.id))).toHaveLength(1);
      expect(s.git.publish).not.toHaveBeenCalled();
    } finally { reopened.close(); }
  });
});
