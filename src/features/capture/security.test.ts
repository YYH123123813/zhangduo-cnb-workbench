import { describe, expect, it, vi } from 'vitest';
import { conversation, ctx, fixture, post } from './fixtures.test-support';
import { hashConversation } from '../../contracts/hash';

describe('capture HTTP safety regression', () => {
  it('marks private capture results and failures as non-cacheable even when composed independently', async () => {
    const { app } = fixture({ readIssue: async () => ({ ok: true, data: conversation }) });
    for (const selected of [true, false]) {
      const response = await post(app, '/api/capture/issue', { issueNumber: 7, selected });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
  it('does not forward private platform error messages, tokens or arbitrary recovery strings', async () => {
    const { app } = fixture({ readIssue: async () => ({ ok: false, error: { code: 'UPSTREAM', message: 'PRIVATE_ORIGINAL_BODY Authorization: Bearer fixture-secret', retryable: true, dataState: 'not_written', nextAction: 'PRIVATE_ORIGINAL_BODY' } }) });
    const response = await post(app, '/api/capture/issue', { issueNumber: 7, selected: true });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain('PRIVATE_ORIGINAL_BODY'); expect(body).not.toContain('fixture-secret');
  });
  it('rejects oversized/invalid requests before a platform read or write', async () => {
    const readIssue = vi.fn(); const { app } = fixture({ readIssue });
    for (const body of ['{bad', JSON.stringify({ issueNumber: 7, selected: true, extra: 'x'.repeat(300000) })]) {
      expect((await app.request('/api/capture/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(422);
    }
    expect(readIssue).not.toHaveBeenCalled();
  });
  it('does not issue approval for a correctly hashed but entirely empty conversation', async () => {
    const value = { ...conversation, origin: 'paste' as const, sourceAlreadyPersisted: false, state: 'preview' as const, segments: [{ id: 's1', role: 'user' as const, text: '   ' }] };
    value.contentHash = await hashConversation(value);
    const approveConversation = vi.fn(); const { app } = fixture({ approveConversation });
    expect((await post(app, '/api/capture/approve', { conversation: value, baseRevision: 'new', confirmed: true })).status).toBe(422);
    expect(approveConversation).not.toHaveBeenCalled();
  });
  it('rejects missing revocation scope without delegating to a fixture port', async () => {
    const revokeApproval = vi.fn(); const { app } = fixture({ context: async () => ({ ok: true, data: { ...ctx, scopes: [] } }), revokeApproval });
    expect((await post(app, '/api/capture/approvals/id/revoke', {})).status).toBe(403);
    expect(revokeApproval).not.toHaveBeenCalled();
  });
});
