import type { Candidate, Conversation } from '../../../contracts/domain';
import { hashConversation, hashSegment } from '../../../contracts/hash';

export const time = '2026-09-05T04:00:00.000Z';
export const conversation: Conversation = {
  id: 'conversation-1', workspaceId: 'workspace-1', taskId: 'task-1', origin: 'cnb_issue',
  issueNumber: 7, issueUrl: 'https://cnb.cool/fixture/private/-/issues/7',
  sourceAlreadyPersisted: true, segments: [{ id: 'segment-1', role: 'user', text: '先确认适用条件，再采用结论。' }],
  contentHash: 'fixture-source-hash', createdAt: time, state: 'saved',
};
conversation.contentHash = await hashConversation(conversation);
const segmentHash = await hashSegment(conversation.id, conversation.segments[0]!);
export function candidate(id = 'candidate-1'): Candidate {
  return {
    id, conversationId: conversation.id, title: '采用结论前确认条件', question: '什么时候可以采用？',
    claim: '先确认适用条件，再采用结论。', kind: 'principle', whyKeep: '避免省略前提',
    spans: [{ id: `span-${id}`, conversationId: conversation.id, segmentId: 'segment-1', start: 0,
      end: conversation.segments[0]!.text.length, quote: conversation.segments[0]!.text, contentHash: segmentHash }],
    sources: [{ id: 'source-1', kind: 'conversation', title: '原始现场', excerpt: '先确认适用条件，再采用结论。',
      accessedAt: time, support: 'unverified', supportedClaim: '', limitation: '' }],
    uncertainties: ['适用条件尚未判断'], modelId: 'fixture-no-model-call', promptVersion: 'fixture-v1',
    generatedAt: time, state: 'proposed',
  };
}
