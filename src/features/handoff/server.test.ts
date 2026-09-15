import { describe, expect, it, vi } from 'vitest';
import { context, fixtureServices } from './testing/services';
import { conversation } from './testing/fixtures';
import { appFor } from './testing/app';
describe('H02 trusted handoff loading', () => {
  it('requires explicit application scopes and never treats wildcard as authorization', async () => {
    const services = fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: ['*'] } }) });
    expect((await appFor(services).request('/api/handoff/conversation-1')).status).toBe(403);
    expect(services.readConversation).not.toHaveBeenCalled();
  });
  it('reads the same stable conversation ID through Services without side effects', async () => {
    const services = fixtureServices();
    const response = await appFor(services).request('/api/handoff/conversation-1');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.conversation.id).toBe(conversation.id);
    expect(body.meta.mode).toBe('fixture');
    expect(services.readCandidates).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1' }), conversation.id);
    expect(services.commit).not.toHaveBeenCalled();
    expect(services.saveConversation).not.toHaveBeenCalled();
  });
  it('denies missing identity before reading private data', async () => {
    const services = fixtureServices({ context: async () => ({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Login required', retryable: false, dataState: 'not_written', nextAction: 'sign_in' } }) });
    expect((await appFor(services).request('/api/handoff/conversation-1')).status).toBe(401);
    expect(services.readConversation).not.toHaveBeenCalled();
  });
  it('refuses cross-workspace data without continuing candidate reads', async () => {
    const services = fixtureServices({ readConversation: async () => ({ ok: true, data: { ...conversation, workspaceId: 'foreign' } }) });
    expect((await appFor(services).request('/api/handoff/conversation-1')).status).toBe(403);
    expect(services.readCandidates).not.toHaveBeenCalled();
  });
  it('rejects a changed source digest instead of silently trusting matching text', async () => {
    const services = fixtureServices({ readConversation: async () => ({ ok: true, data: { ...conversation, contentHash: 'stale-hash' } }) });
    expect((await appFor(services).request('/api/handoff/conversation-1')).status).toBe(422);
  });
  it('sanitizes thrown errors and does not report success', async () => {
    const services = fixtureServices({ readConversation: vi.fn(async () => { throw Error('Authorization: secret private text'); }) });
    const response = await appFor(services).request('/api/handoff/conversation-1');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });
});
