import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from './platform-fixture';
import { createApp } from '../../src/server/app';
import { contentHash } from '../../src/contracts/hash';
import { parseRoute, routeHash } from '../../src/app/routing';
import { readRecoveryIdentity, retainRecoveryIdentity } from '../../src/app/recovery-client';

const close: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); close.splice(0).forEach((fn) => fn()); });
describe('W12 recovery HTTP and shared navigation, synthetic external transport', () => {
  it('survives a new client using only the retained ID and verifies the original task receipt with GET only', async () => {
    const f = await platformFixture(); close.push(() => f.journal.close());
    const app = createApp(f.services);
    const task = { id: 'recovery-task', workspaceId: f.ctx.workspaceId, question: 'PRIVATE_TASK_TEXT', constraints: [], mode: 'assisted' as const, updatedAt: new Date().toISOString() };
    const request = { operationId: 'original-task-save', task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30 as const, confirmed: true as const };
    const input = { feature: 'learning' as const, operation: { kind: 'task' as const, operationId: request.operationId }, binding: { requestHash: await contentHash(request) },
      expiresAt: new Date(Date.now() + 86_000_000).toISOString(), confirmed: true as const };
    const session = { actorId: f.ctx.actorId, workspace: { id: f.ctx.workspaceId, slug: 'fixture/platform', visibility: 'private' as const, mode: 'fixture' as const }, scopes: [...f.ctx.scopes] };
    const transport = vi.fn<typeof fetch>(async (path, init) => app.request(String(path), { ...init, headers: { ...f.headers, ...init?.headers } }));
    const saved = await retainRecoveryIdentity(session, input, transport); expect(saved.ok).toBe(true); if (!saved.ok) return;
    expect(await f.services.saveTask!(f.ctx, request)).toMatchObject({ ok: true });
    transport.mockClear();
    const route = parseRoute(routeHash({ page: 'learning', params: { recoveryId: saved.data.id } }));
    expect(route).toMatchObject({ page: 'learning', params: { recoveryId: saved.data.id } });
    const response = await readRecoveryIdentity(session, route, transport);
    expect(response).toMatchObject({ ok: true, data: { binding: 'matched', original: { recordId: task.id, stage: 'saved' }, retryAllowed: false } });
    expect(JSON.stringify(response)).not.toContain(task.question);
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(await readRecoveryIdentity({ ...session, actorId: 'changed-client-identity' }, route, transport)).toMatchObject({ ok: false });
    expect(parseRoute(`#retrieval?recoveryId=${saved.data.id}&query=PRIVATE_TASK_TEXT`).page).toBe('invalid');
    expect(parseRoute('#retrieval?recoveryId=not-a-hash').page).toBe('invalid');
  });
});
