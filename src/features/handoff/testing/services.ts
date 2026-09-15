import { vi } from 'vitest';
import type { Services } from '../../../contracts/ports';
import type { RequestContext } from '../../../contracts/api';
import { unavailable } from '../../../contracts/api';
import { candidate, conversation } from './fixtures';

export const context: RequestContext = { actorId: 'actor-1', workspaceId: 'workspace-1', requestId: 'request-1', mode: 'fixture',
  scopes: ['workspace:read', 'conversation:read', 'candidate:read', 'draft:read', 'draft:write', 'knowledge:read', 'knowledge:write'] };
export function fixtureServices(overrides: Partial<Services> = {}): Services {
  const unavailablePort = async () => unavailable<never>();
  return {
    context: vi.fn(async () => ({ ok: true as const, data: context })), workspace: unavailablePort,
    readIssue: unavailablePort, saveConversation: vi.fn(unavailablePort),
    readConversation: vi.fn(async () => ({ ok: true as const, data: structuredClone(conversation) })),
    readCandidates: vi.fn(async () => ({ ok: true as const, data: [candidate()] })),
    saveCandidates: vi.fn(unavailablePort), readDraft: unavailablePort, saveDraft: vi.fn(unavailablePort),
    snapshot: unavailablePort, commit: vi.fn(unavailablePort), semanticQuery: unavailablePort, complete: vi.fn(unavailablePort),
    appendEvidence: unavailablePort, listEvidence: unavailablePort, previewDelete: unavailablePort,
    executeDelete: unavailablePort, exportData: unavailablePort, settings: unavailablePort,
    saveSettings: unavailablePort, audit: unavailablePort, ...overrides,
  };
}
