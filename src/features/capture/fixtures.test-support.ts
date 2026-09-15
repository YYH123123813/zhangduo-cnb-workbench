import { Hono } from 'hono';
import { vi } from 'vitest';
import type { ApiResponse, RequestContext, Result } from '../../contracts/api';
import { unavailable } from '../../contracts/api';
import { CONTRACT_VERSION, type Conversation } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { registerRoutes } from './server';
import { SCOPES } from '../../contracts/scopes';

export const ctx: RequestContext = { requestId: 'fixture-request', actorId: 'actor-1', workspaceId: 'workspace-1', mode: 'fixture', scopes: Object.values(SCOPES) };
export const sessionFixture = { actorId: ctx.actorId, workspace: { id: ctx.workspaceId, slug: 'fixture/capture', visibility: 'private', mode: 'fixture' }, scopes: ctx.scopes };
export function withFixtureSession(request: (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>) {
  return (path: string, init?: RequestInit): Promise<ApiResponse<unknown>> => path === '/api/workspace/session'
    ? Promise.resolve({ ok: true, data: sessionFixture, meta: { requestId: ctx.requestId, mode: 'fixture', contractVersion: CONTRACT_VERSION } }) : request(path, init);
}
export const conversation: Conversation = {
  id: 'conversation-1', workspaceId: ctx.workspaceId, taskId: 'task-1', origin: 'cnb_issue', issueNumber: 7,
  issueUrl: 'https://cnb.cool/fixture/repo/-/issues/7', sourceAlreadyPersisted: true,
  segments: [{ id: 'segment-1', role: 'user', text: '为什么会重复请求？' }, { id: 'segment-2', role: 'assistant', text: '使用幂等键，但要限定有效期。' }],
  contentHash: 'fixture-only-source-hash', createdAt: '2026-09-05T04:00:00.000Z', state: 'saved',
};
async function off<T>(): Promise<Result<T>> { return unavailable(); }
export function fixture(overrides: Partial<Services> = {}) {
  const services: Services = {
    context: vi.fn(async () => ({ ok: true as const, data: ctx })), workspace: off,
    readIssue: off, saveConversation: off, readConversation: off, readCandidates: off, saveCandidates: off,
    readDraft: off, saveDraft: off, snapshot: off, commit: off, semanticQuery: off, complete: off,
    appendEvidence: off, listEvidence: off, previewDelete: off, executeDelete: off, exportData: off,
    settings: off, saveSettings: off, audit: off, ...overrides,
  };
  const app = new Hono();
  app.get('/api/workspace/session', (c) => c.json({ ok: true, data: sessionFixture, meta: { requestId: ctx.requestId, mode: 'fixture', contractVersion: CONTRACT_VERSION } }));
  registerRoutes(app, services);
  return { app, services };
}
export function post(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
