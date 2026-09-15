import type { KnowledgeNode, KnowledgeSnapshot, Relation } from '../../../contracts/domain';
import { candidate, time } from './fixtures';
export const node: KnowledgeNode = { id: 'node-1', workspaceId: 'workspace-1', schemaVersion: 1, revision: 'fixture-r1',
  title: '本条知识', question: '什么时候采用', humanStatement: '我的主张', authorship: 'human_written', candidateIds: ['candidate-1'],
  conversationId: 'conversation-1', kind: 'principle', conditions: [], boundaries: [], sources: candidate().sources,
  confirmation: 'draft', evidenceStatus: 'unverified', lifecycle: 'active', updatedAt: time };
export const snapshot: KnowledgeSnapshot = { workspaceId: 'workspace-1', revision: 'fixture-r1',
  nodes: [{ ...node, id: 'node-2', confirmation: 'confirmed', confirmedBy: 'actor-1', confirmedAt: time }],
  relations: [], excludedIds: [], generatedAt: time };
export function relation(): Relation {
  return { id: 'relation-1', workspaceId: 'workspace-1', source: { workspaceId: 'workspace-1', objectId: 'node-1', revision: 'fixture-r1' },
    target: { workspaceId: 'workspace-1', objectId: 'node-2', revision: 'fixture-r1' }, type: 'depends_on', rationale: '本条成立需要目标条件',
    evidenceIds: ['source-1'], state: 'confirmed', proposedBy: 'actor-1', confirmedBy: 'actor-1', confirmedAt: time, updatedAt: time };
}
