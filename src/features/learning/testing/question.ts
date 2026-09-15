import type { ReviewQuestion } from '../question';
import { task, useInput } from './fixtures';

export const questionFixture: ReviewQuestion = {
  id: 'question-1', workspaceId: task.workspaceId, revision: 'fixture:q1', kind: 'recall',
  nodeRef: useInput.nodeRefs[0]!, prompt: 'What prerequisite is required before using the offline method?',
  standardAnswer: 'A local copy must exist before disconnecting.',
  hints: ['Consider the environment.', 'Consider available data.', 'Check the local copy.'],
  rubric: { version: 'fixture:rubric-1', criteria: [{ id: 'criterion-1', description: 'State the prerequisite.', expectedEvidence: 'A local copy must exist.', required: true }], necessaryConditions: ['A local copy exists'] },
  review: { status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: task.updatedAt },
};
