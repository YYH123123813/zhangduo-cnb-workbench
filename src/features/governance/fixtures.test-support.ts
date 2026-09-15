import { vi } from 'vitest';
import { Hono } from 'hono';
import { unavailable, type RequestContext } from '../../contracts/api';
import type { EvidenceRecord, KnowledgeNode, KnowledgeSnapshot, Relation } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { registerRoutes } from './server';

export const now = '2026-09-05T04:00:00.000Z';
export function ok<T>(data: T): { ok: true; data: T } { return { ok: true, data }; }
export const ctx: RequestContext = {
  requestId: 'request-fixture', actorId: 'actor-1', workspaceId: 'workspace-1', mode: 'fixture',
  scopes: ['knowledge:read', 'knowledge:write', 'evidence:read', 'data:export', 'data:delete', 'settings:read', 'settings:write', 'audit:read'],
};
export function node(id = 'node-1', overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id, workspaceId: ctx.workspaceId, schemaVersion: 1, revision: 'fixture-r1',
    title: 'Conditional cache', question: 'When can this cache be reused?',
    humanStatement: 'Reuse only when the version is unchanged.', authorship: 'human_written',
    candidateIds: [], conversationId: 'conversation-1', kind: 'principle',
    conditions: [{ id: 'condition-1', text: 'Same version', status: 'confirmed', evidenceIds: ['source-1'], confirmedBy: ctx.actorId }],
    boundaries: ['Not for changed versions'],
    sources: [{ id: 'source-1', kind: 'user_observation', title: 'Local experiment', excerpt: 'Version changes invalidate the cache.', accessedAt: now, support: 'supports', supportedClaim: 'Reuse at the same version', limitation: 'One local test' }],
    confirmation: 'confirmed', evidenceStatus: 'supported', lifecycle: 'active',
    confirmedBy: ctx.actorId, confirmedAt: now, updatedAt: now, ...overrides,
  };
}
export function relation(id = 'edge-1', source = 'node-2', target = 'node-1', overrides: Partial<Relation> = {}): Relation {
  return {
    id, workspaceId: ctx.workspaceId,
    source: { workspaceId: ctx.workspaceId, objectId: source, revision: 'fixture-r1' },
    target: { workspaceId: ctx.workspaceId, objectId: target, revision: 'fixture-r1' },
    type: 'depends_on', rationale: 'Requires the version condition', evidenceIds: ['source-1'],
    state: 'confirmed', proposedBy: ctx.actorId, confirmedBy: ctx.actorId, confirmedAt: now, updatedAt: now, ...overrides,
  };
}
export function snapshot(overrides: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot {
  return { workspaceId: ctx.workspaceId, revision: 'fixture-r1', nodes: [node(), node('node-2')], relations: [relation()], excludedIds: [], generatedAt: now, ...overrides };
}
export function fixture(overrides: Partial<Services> = {}) {
  const services: Services = {
    context: vi.fn<Services['context']>(async () => ok(ctx)),
    workspace: vi.fn<Services['workspace']>(async () => ok({ id: ctx.workspaceId, slug: 'fixture/private', visibility: 'private', mode: 'fixture' })),
    readIssue: vi.fn(async () => unavailable<never>()), saveConversation: vi.fn(async () => unavailable<never>()),
    readConversation: vi.fn(async () => unavailable<never>()), readCandidates: vi.fn(async () => unavailable<never>()),
    saveCandidates: vi.fn(async () => unavailable<never>()), readDraft: vi.fn(async () => unavailable<never>()),
    saveDraft: vi.fn(async () => unavailable<never>()), snapshot: vi.fn<Services['snapshot']>(async (_ctx, revision) => revision ? unavailable() : ok(snapshot())),
    commit: vi.fn(async () => unavailable<never>()), semanticQuery: vi.fn(async () => unavailable<never>()),
    complete: vi.fn(async () => unavailable<never>()), appendEvidence: vi.fn(async () => unavailable<never>()),
    listEvidence: vi.fn(async () => ok([])), previewDelete: vi.fn(async () => unavailable<never>()),
    executeDelete: vi.fn(async () => unavailable<never>()), exportData: vi.fn(async () => unavailable<never>()),
    settings: vi.fn(async () => unavailable<never>()), saveSettings: vi.fn(async () => unavailable<never>()),
    audit: vi.fn(async () => unavailable<never>()), ...overrides,
  };
  const app = new Hono();
  registerRoutes(app, services);
  return { services, app };
}
export function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}
export function structuredUse(): EvidenceRecord {
  const revision = 'a'.repeat(40), original = node('node-1', { revision });
  const ref = (id: string) => ({ workspaceId: ctx.workspaceId, objectId: id, revision });
  return { id: 'use-1', workspaceId: ctx.workspaceId, taskId: 'task-1', kind: 'use', nodeRefs: [ref('node-1')], relationRefs: [], decision: 'verify_later',
    answer: 'Original recorded answer', answerVisible: true, hintLevel: 0, selfConfidence: 'skipped', result: 'self_reported', recordedAt: now,
    useContext: { task: { id: 'task-1', workspaceId: ctx.workspaceId, question: 'Original task question', constraints: [{ id: 'task-condition', text: 'Original task boundary' }], mode: 'assisted', updatedAt: now },
      snapshotRevision: revision, knowledge: [{ id: original.id, revision, title: original.title, humanStatement: original.humanStatement, conditions: original.conditions, boundaries: original.boundaries, evidenceStatus: original.evidenceStatus }],
      relations: [], paths: [{ seedId: 'node-1', relationIds: [], nodeIds: ['node-1'], reason: 'Original retrieved path' }], reason: 'Original decision reason',
      retrievalContext: { queryId: 'query-1', coverage: 'partial', missingConditions: ['Original missing condition'], warnings: [], trust: 'client_preview_only' } } };
}
