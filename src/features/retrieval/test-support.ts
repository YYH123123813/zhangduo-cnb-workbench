import { vi } from 'vitest';
import { unavailable, type RequestContext } from '../../contracts/api';
import type { KnowledgeNode, KnowledgeSnapshot, RetrievalRequest, Relation } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';

export const time = '2026-09-05T04:00:00Z';
export const context: RequestContext = { requestId: 'request-fixture', workspaceId: 'w1', actorId: 'u1', mode: 'fixture', scopes: ['knowledge:read'] };
export const request: RetrievalRequest = {
  task: { id: 'task-1', workspaceId: 'w1', question: 'cache', constraints: [], mode: 'independent', updatedAt: time },
  query: 'cache', confirmedOnly: true,
};
export function node(id = 'n1', patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
  const statement = patch.humanStatement ?? 'Cache immutable data.';
  return {
    id, workspaceId: 'w1', schemaVersion: 1, revision: 'fixture-r1', title: `cache ${id}`,
    question: 'When to use cache?', humanStatement: statement, authorship: 'human_written',
    candidateIds: [], conversationId: 'conversation-1', kind: 'principle', conditions: [], boundaries: [],
    sources: [{ id: `s-${id}`, kind: 'official', title: 'Fixture source', excerpt: statement,
      accessedAt: time, support: 'supports', supportedClaim: statement, limitation: '', url: 'https://example.com/source' }],
    confirmation: 'confirmed', evidenceStatus: 'supported', lifecycle: 'active', confirmedBy: 'u1', confirmedAt: time, updatedAt: time,
    ...patch,
  };
}
export function relation(id: string, source: string, target: string, type: Relation['type'] = 'depends_on', patch: Partial<Relation> = {}): Relation {
  return { id, workspaceId: 'w1', source: { workspaceId: 'w1', objectId: source, revision: 'fixture-r1' },
    target: { workspaceId: 'w1', objectId: target, revision: 'fixture-r1' }, type,
    rationale: `${source} ${type} ${target}`, evidenceIds: [`s-${source}`], state: 'confirmed',
    proposedBy: 'u1', confirmedBy: 'u1', confirmedAt: time, updatedAt: time, ...patch };
}
export function snapshot(nodes = [node()], patch: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot {
  return { workspaceId: 'w1', revision: 'fixture-r1', nodes, relations: [], excludedIds: [], generatedAt: time, ...patch };
}
export function fixtureServices(overrides: Partial<Services> = {}): Services {
  const ports = {
    semanticQueryWithStatus: undefined, approveModel: undefined, revokeApproval: undefined, readModelOperation: undefined, recordReviewExposure: undefined,
    context: vi.fn(async () => ({ ok: true as const, data: context })),
    snapshot: vi.fn(async () => ({ ok: true as const, data: snapshot() })),
    semanticQuery: vi.fn(async () => unavailable()), complete: vi.fn(async () => unavailable()),
    ...overrides,
  };
  return new Proxy(ports, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => unavailable()) }) as Services;
}
