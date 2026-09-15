import { vi } from 'vitest';
import type { KnowledgeSnapshot, TaskContext } from '../../../contracts/domain';
import type { RequestContext } from '../../../contracts/api';
import { unavailable } from '../../../contracts/api';
import type { Services } from '../../../contracts/ports';
import { failure, success } from '../errors';

export const task: TaskContext = {
  id: 'task-1', workspaceId: 'workspace-1', question: 'Can this method be used offline?',
  constraints: [{ id: 'offline', text: 'No network', confirmedBy: 'actor-1' }],
  mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z',
};
export const snapshot: KnowledgeSnapshot = {
  workspaceId: 'workspace-1', revision: 'fixture:r1', excludedIds: [], generatedAt: task.updatedAt,
  nodes: [{
    id: 'node-1', workspaceId: task.workspaceId, schemaVersion: 1, revision: 'fixture:r1',
    title: 'Offline method', question: 'When is this applicable?', humanStatement: 'Use a local copy.',
    authorship: 'human_written', candidateIds: [], conversationId: 'conversation-1', kind: 'method',
    conditions: [{ id: 'local-copy', text: 'A local copy exists', status: 'unknown', evidenceIds: [] }],
    boundaries: ['Not suitable for live updates'], sources: [], confirmation: 'confirmed',
    evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: 'actor-1',
    confirmedAt: task.updatedAt, updatedAt: task.updatedAt,
  }], relations: [],
};
export const useInput = {
  task, snapshotRevision: 'fixture:r1',
  nodeRefs: [{ workspaceId: task.workspaceId, objectId: 'node-1', revision: 'fixture:r1' }],
  relationRefs: [], decision: 'adopt' as const, reason: 'I will verify that a local copy exists.',
};
export const context: RequestContext = {
  requestId: 'request-1', actorId: 'actor-1', workspaceId: task.workspaceId, mode: 'fixture',
  scopes: ['workspace:read', 'knowledge:read', 'evidence:read', 'evidence:write'],
};

export function fixtureServices(overrides: Partial<Services> = {}): Services {
  const missing = async () => unavailable<never>();
  return {
    context: vi.fn(async () => success(structuredClone(context))),
    workspace: vi.fn(async () => success({ id: task.workspaceId, slug: 'synthetic-fixture', visibility: 'private' as const, mode: 'fixture' as const })),
    snapshot: vi.fn(async (_ctx, revision) => revision !== undefined && revision !== snapshot.revision
      ? failure('CONFLICT', 'Synthetic fixture does not contain that revision.') : success(structuredClone(snapshot))),
    readIssue: missing, saveConversation: missing, readConversation: missing,
    readCandidates: missing, saveCandidates: missing, readDraft: missing, saveDraft: missing,
    commit: vi.fn(missing), semanticQuery: vi.fn(missing), complete: vi.fn(missing),
    appendEvidence: vi.fn(missing), listEvidence: vi.fn(async () => success([])),
    previewDelete: missing, executeDelete: missing, exportData: missing,
    settings: vi.fn(async () => success({ aiExtraction: false, aiAnswer: false, aiReview: false, saveQueryHistory: false, reviewReminders: false })),
    saveSettings: missing, audit: missing, ...overrides,
  };
}
