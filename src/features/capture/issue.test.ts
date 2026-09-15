import { describe, expect, it, vi } from 'vitest';
import { conversation, fixture, post } from './fixtures.test-support';
import { failure } from './result';

describe('C02 explicitly selected Issue', () => {
  it('reads exactly one chosen Issue and preserves roles, IDs, time and existing storage', async () => {
    const readIssue = vi.fn(async (_ctx: unknown, _issueNumber: number) => ({ ok: true as const, data: conversation }));
    const { app } = fixture({ readIssue });
    const response = await post(app, '/api/capture/issue', { issueNumber: 7, selected: true });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ ...conversation, sourceAlreadyPersisted: true });
    expect(readIssue).toHaveBeenCalledOnce();
    expect(readIssue.mock.calls[0]?.[1]).toBe(7);
  });
  it('does not read when identity is forbidden or selection cancelled', async () => {
    const readIssue = vi.fn();
    const denied = fixture({ context: async () => failure('FORBIDDEN', 'denied'), readIssue });
    expect((await post(denied.app, '/api/capture/issue', { issueNumber: 7, selected: true })).status).toBe(403);
    const allowed = fixture({ readIssue });
    expect((await post(allowed.app, '/api/capture/issue', { issueNumber: 7, selected: false })).status).toBe(422);
    expect(readIssue).not.toHaveBeenCalled();
  });
  it('rejects malformed selection and cross-workspace data', async () => {
    const readIssue = vi.fn(async () => ({ ok: true as const, data: { ...conversation, workspaceId: 'other' } }));
    const { app } = fixture({ readIssue });
    expect((await post(app, '/api/capture/issue', { issueNumber: -1, selected: true })).status).toBe(422);
    expect(readIssue).not.toHaveBeenCalled();
    expect((await post(app, '/api/capture/issue', { issueNumber: 7, selected: true })).status).toBe(403);
  });
  it('does not expose upstream exception text or fake read success', async () => {
    const { app } = fixture({ readIssue: async () => { throw new Error('SECRET PRIVATE BODY'); } });
    const response = await post(app, '/api/capture/issue', { issueNumber: 7, selected: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
  });
});
