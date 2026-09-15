import { describe, expect, it, vi } from 'vitest';
import { hashEvidence } from '../../contracts/hash';
import type { Approval, EvidenceRecord } from '../../contracts/domain';
import { attemptEvidence, saveAttemptEvidence } from './evidence';
import { failure, success } from './errors';
import { context, fixtureServices } from './testing/fixtures';
import { submittedFixture, startFixture } from './testing/attempt';
import { createFeedback, reviewFeedback } from './feedback';

const now = '2026-09-05T02:00:00Z';
async function approvedRecord() {
  const attempt = submittedFixture();
  const result = attemptEvidence(attempt);
  if (!result.ok) throw new Error('invalid fixture');
  const record = result.data;
  const approval: Approval = { id: 'approval-1', workspaceId: context.workspaceId, actorId: context.actorId, purpose: 'save_evidence', objectIds: [record.id], contentHash: await hashEvidence(record), baseRevision: attempt.snapshotRevision, approvedAt: now, expiresAt: '2026-09-05T02:10:00Z' };
  return { attempt, record, approval };
}
function evidenceStore() {
  const records: EvidenceRecord[] = [];
  const services = fixtureServices({
    listEvidence: vi.fn(async () => success(structuredClone(records))),
    appendEvidence: vi.fn(async (_ctx, record, approval) => {
      if (approval.id !== 'approval-1') return failure('FORBIDDEN', 'Approval was not registered or has been revoked.');
      const previous = records.find((item) => item.id === record.id);
      if (!previous) records.push(structuredClone(record));
      return success(structuredClone(previous ?? record));
    }),
  });
  return { services, records };
}

describe('L09 evidence authorization and read-back', () => {
  it('derives shared EvidenceRecord from the trusted submitted state, never a client exposure flag', () => {
    expect(attemptEvidence(startFixture()).ok).toBe(false);
    expect(attemptEvidence(submittedFixture('unknown'))).toMatchObject({ ok: true, data: { answerVisible: true, result: 'unverified', kind: 'recall' } });
  });
  it('appends through Services, verifies read-back, and reuses the same id on retry', async () => {
    const { attempt, approval } = await approvedRecord(); const { services, records } = evidenceStore();
    const result = await saveAttemptEvidence(services, context, attempt, null, { consent: true, approval }, now);
    expect(result).toMatchObject({ ok: true, data: { persistence: 'saved', verification: 'read_back', indexing: 'excluded' } });
    expect(records).toHaveLength(1);
    expect((await saveAttemptEvidence(services, context, attempt, null, { consent: true, approval }, now)).ok).toBe(true);
    expect(services.appendEvidence).toHaveBeenCalledTimes(1); expect(services.semanticQuery).not.toHaveBeenCalled();
  });
  it('rejects refusal, expired approval, forged scopes, changed content and platform revocation', async () => {
    const { attempt, approval } = await approvedRecord(); const { services } = evidenceStore();
    expect((await saveAttemptEvidence(services, context, attempt, null, { consent: false, approval }, now)).ok).toBe(false);
    expect((await saveAttemptEvidence(services, context, attempt, null, { consent: true, approval: { ...approval, expiresAt: now } }, now)).ok).toBe(false);
    expect((await saveAttemptEvidence(services, { ...context, scopes: [] }, attempt, null, { consent: true, approval }, now)).ok).toBe(false);
    expect((await saveAttemptEvidence(services, context, attempt, null, { consent: true, approval: { ...approval, contentHash: 'forged' } }, now)).ok).toBe(false);
    expect(services.appendEvidence).not.toHaveBeenCalled();
    expect(await saveAttemptEvidence(services, context, attempt, null, { consent: true, approval: { ...approval, id: 'revoked' } }, now)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
  it('reads back uncertain writes without retrying the mutation', async () => {
    const { attempt, approval } = await approvedRecord(); const store = evidenceStore();
    store.services.appendEvidence = vi.fn(async (_ctx, record) => { store.records.push(structuredClone(record)); return failure('UNKNOWN_RESULT', 'Timed out', 'read_back', 'unknown'); });
    expect((await saveAttemptEvidence(store.services, context, attempt, null, { consent: true, approval }, now)).ok).toBe(true);
    expect(store.services.appendEvidence).toHaveBeenCalledTimes(1);
    const missing = fixtureServices({ appendEvidence: vi.fn(async () => failure('UNKNOWN_RESULT', 'Timed out', 'read_back', 'unknown')) });
    expect(await saveAttemptEvidence(missing, context, attempt, null, { consent: true, approval }, now)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect(missing.appendEvidence).toHaveBeenCalledTimes(1);
  });
  it('does not treat an unverified success receipt as a saved record, or leak thrown secrets', async () => {
    const { attempt, approval, record } = await approvedRecord();
    const missing = fixtureServices({ appendEvidence: vi.fn(async () => success(record)) });
    expect(await saveAttemptEvidence(missing, context, attempt, null, { consent: true, approval }, now)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    const throwing = fixtureServices({ appendEvidence: vi.fn(async () => { throw new Error('Authorization: secret'); }) });
    expect(JSON.stringify(await saveAttemptEvidence(throwing, context, attempt, null, { consent: true, approval }, now))).not.toContain('secret');
  });
  it('rejects stale knowledge and conflicting duplicate records before writing', async () => {
    const { attempt, approval, record } = await approvedRecord(); const store = evidenceStore();
    store.records.push({ ...record, answer: 'different payload' });
    expect(await saveAttemptEvidence(store.services, context, attempt, null, { consent: true, approval }, now)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(store.services.appendEvidence).not.toHaveBeenCalled();
    const current = fixtureServices({ snapshot: async () => success({ workspaceId: context.workspaceId, revision: 'fixture:r2', nodes: [], relations: [], excludedIds: [], generatedAt: now }) });
    expect(await saveAttemptEvidence(current, context, attempt, null, { consent: true, approval }, now)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('preserves invalid-question feedback and rejects feedback for a different attempt', () => {
    const attempt = submittedFixture(); const feedback = createFeedback(attempt);
    if (!feedback.ok) throw new Error('invalid fixture');
    const invalid = reviewFeedback(feedback.data, { criteria: [], invalidReason: 'Invalid premise.' }, attempt, context, 0, now);
    if (!invalid.ok) throw new Error('invalid fixture');
    expect(attemptEvidence(attempt, invalid.data)).toMatchObject({ ok: true, data: { result: 'invalid_question' } });
    expect(attemptEvidence(attempt, { ...invalid.data, attemptId: 'other' }).ok).toBe(false);
  });
});
