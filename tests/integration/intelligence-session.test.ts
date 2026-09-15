import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app';
import { IntelligenceClient } from '../../src/app/intelligence-client';
import { bindIntelligenceSession } from '../../src/app/api-client';
import { WorkspaceSessionSchema } from '../../src/contracts/session';
import { contentHash } from '../../src/contracts/hash';
import type { IntelligenceMutation } from '../../src/contracts/intelligence';
import { platformFixture } from './platform-fixture';

afterEach(() => vi.unstubAllGlobals());

it('blocks old C approvals through actual HTTP when another tab replaces the cookie before shell recheck', async () => {
  const f = await platformFixture(), app = createApp(f.services);
  const { data } = await (await app.request('/api/workspace/session', { headers: f.headers })).json();
  const session = WorkspaceSessionSchema.parse(data), release = bindIntelligenceSession(session), client = new IntelligenceClient();
  let token = f.token;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (path, init) => {
    const headers = new Headers(init?.headers); headers.set('Cookie', `zhangduo_session=${token}`); headers.set('Origin', 'http://localhost');
    return app.request(String(path), { ...init, headers });
  }));
  try {
    await client.refresh(); expect(client.getSnapshot().verified).toBe(true);
    token = f.sessions.issue({ ...session, actorId: 'synthetic-other-actor' });
    const command: IntelligenceMutation = { action: 'create_chat', operationId: randomUUID(), title: 'Old identity private draft', confirmed: true, retentionDays: 30 };
    const result = await client.execute(command);
    expect(result).toBeNull(); expect(client.getSnapshot()).toMatchObject({ denied: true, data: null, verified: false });
    expect(client.getSnapshot().unresolved).toEqual({ action: 'create_chat', operationId: command.operationId,
      targetId: command.operationId, requestHash: await contentHash(command), command: null });
    expect(JSON.stringify(client.getSnapshot())).not.toContain(command.title);
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(await client.execute({ ...command, operationId: randomUUID() })).toBeNull();
    expect(await client.readOperation()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(f.journal.records(session.workspace.id, session.actorId, 'intelligence_chat')).toHaveLength(0);
    expect(f.journal.records(session.workspace.id, 'synthetic-other-actor', 'intelligence_chat')).toHaveLength(0);
  } finally { client.dispose(); release(); f.journal.close(); }
});
