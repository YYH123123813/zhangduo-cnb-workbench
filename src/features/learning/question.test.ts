import { describe, expect, it } from 'vitest';
import { inspectQuestion, publicQuestion } from './question';
import { snapshot } from './testing/fixtures';
import { questionFixture } from './testing/question';

describe('L05 reviewed questions and rubrics', () => {
  it('accepts a pinned recall question and exposes no answer or rubric evidence in the prompt DTO', () => {
    const result = inspectQuestion(questionFixture, snapshot);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const prompt = publicQuestion(result.data);
    expect(prompt.prompt).toBe(questionFixture.prompt);
    const text = JSON.stringify(prompt);
    expect(text).not.toContain(questionFixture.standardAnswer);
    expect(text).not.toContain('expectedEvidence'); expect(text).not.toContain('hints');
  });
  it('requires a reviewed dimension and necessary conditions for near transfer', () => {
    const transfer = { ...questionFixture, kind: 'near_transfer', transfer: { dimension: 'constraints', change: 'Only a partial local copy is available.' } };
    expect(inspectQuestion(transfer, snapshot).ok).toBe(true);
    expect(inspectQuestion({ ...transfer, review: { status: 'pending' } }, snapshot).ok).toBe(false);
    expect(inspectQuestion({ ...transfer, rubric: { ...questionFixture.rubric, necessaryConditions: [] } }, snapshot).ok).toBe(false);
    expect(inspectQuestion({ ...transfer, transfer: undefined }, snapshot).ok).toBe(false);
  });
  it('rejects unreviewed studies, rejected questions, forged workspaces and stale versions', () => {
    expect(inspectQuestion({ ...questionFixture, review: { status: 'pending' } }, snapshot, true).ok).toBe(false);
    expect(inspectQuestion({ ...questionFixture, review: { status: 'rejected' } }, snapshot).ok).toBe(false);
    expect(inspectQuestion({ ...questionFixture, workspaceId: 'other' }, snapshot)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(inspectQuestion(questionFixture, { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'fixture:r2' })) })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('does not label numeric variation as far transfer or accept duplicate rubric criteria', () => {
    expect(inspectQuestion({ ...questionFixture, kind: 'far_transfer' }, snapshot).ok).toBe(false);
    expect(inspectQuestion({ ...questionFixture, kind: 'near_transfer', transfer: { dimension: 'numbers_only', change: 'Only change 2 to 3.' } }, snapshot, true).ok).toBe(false);
    expect(inspectQuestion({ ...questionFixture, rubric: { ...questionFixture.rubric, criteria: [...questionFixture.rubric.criteria, ...questionFixture.rubric.criteria] } }, snapshot).ok).toBe(false);
  });
});
