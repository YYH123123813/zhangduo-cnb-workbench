import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { importReviewCatalog } from './review-catalog';
import type { ReviewQuestion } from '../contracts/review-session';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
describe('S07 server-controlled catalog import, synthetic external transport', () => {
  it('requires scope/consent, imports immutable reviewed private questions atomically, and expires bodies', async () => {
    const f = await platformFixture(); cleanup.push(() => f.journal.close());
    const question: ReviewQuestion = { id: 'q1', revision: 'qv1', workspaceId: f.ctx.workspaceId, nodeRef: { workspaceId: f.ctx.workspaceId, objectId: f.node.id, revision: f.base },
      kind: 'recall', prompt: 'What is the prerequisite?', standardAnswer: 'PRIVATE_RUBRIC', hints: ['hint one', 'hint two', 'hint three'],
      rubric: { version: 'rubric1', criteria: [{ id: 'c1', description: 'prerequisite', expectedEvidence: 'PRIVATE_RUBRIC', required: true }], necessaryConditions: [] },
      review: { status: 'approved', reviewedBy: f.ctx.actorId, reviewedAt: '2026-09-12T00:00:00Z' } };
    const input = { operationId: 'import-1', workspaceId: f.ctx.workspaceId, questions: [question], retentionDays: 30, confirmed: true };
    expect(() => importReviewCatalog(f.sessions, f.journal, { ...input, confirmed: false }, f.ctx.workspaceId)).toThrow();
    expect(() => importReviewCatalog(f.sessions, f.journal, input, 'other-workspace')).toThrow();
    const receipt = importReviewCatalog(f.sessions, f.journal, input, f.ctx.workspaceId);
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_RUBRIC');
    expect(importReviewCatalog(f.sessions, f.journal, input, f.ctx.workspaceId)).toEqual(receipt);
    expect(() => importReviewCatalog(f.sessions, f.journal, { ...input, operationId: 'bad-import', questions: [{ ...question, id: 'q2' }, { ...question, prompt: 'Replacement' }] }, f.ctx.workspaceId)).toThrow();
    expect(f.journal.records(f.ctx.workspaceId, '@workspace', 'review_question')).toHaveLength(1);
    f.journal.expirePrivatePayloads(new Date(Date.parse(receipt.expiresAt) + 1).toISOString());
    expect(JSON.stringify(f.journal.records(f.ctx.workspaceId, '@workspace', 'review_question'))).not.toContain('PRIVATE_RUBRIC');
    expect(importReviewCatalog(f.sessions, f.journal, input, f.ctx.workspaceId)).toEqual(receipt);
    expect(() => importReviewCatalog(f.sessions, f.journal, { ...input, operationId: 'after-expiry' }, f.ctx.workspaceId)).toThrow();
  });
});
