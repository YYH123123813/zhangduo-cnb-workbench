import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from './platform-fixture';
import { createApp } from '../../src/server/app';
import type { OperationJournal } from '../../src/platform/journal';
import { WorkspaceSessionSchema } from '../../src/contracts/session';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
describe('W12 trusted UI workspace identity', () => {
  it('returns only the authenticated actor, workspace and scopes, never a bearer token', async () => {
    const s = await platformFixture(); journals.push(s.journal); const app = createApp(s.services);
    const response = await app.request('/api/workspace/session', { headers: s.headers });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json(); expect(WorkspaceSessionSchema.safeParse(body.data).success).toBe(true);
    expect(body.data).toMatchObject({ actorId: s.ctx.actorId, workspace: { id: s.ctx.workspaceId, mode: 'fixture' } });
    expect(JSON.stringify(body)).not.toContain(s.token);
    expect((await app.request('/api/workspace/session', { headers: { ...s.headers, 'X-Actor': 'forged' } })).status).toBe(403);
    s.sessions.revoke(s.token); expect((await app.request('/api/workspace/session', { headers: s.headers })).status).toBe(401);
  });
});
