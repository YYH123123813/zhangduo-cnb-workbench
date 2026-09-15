import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOperationReceipt } from '../../contracts/model';
import type { Services } from '../../contracts/ports';
import { registerRoutes } from './server';
import { context, fixtureServices } from './test-support';

const receipt: ModelOperationReceipt = { approvalId: 'approved', actorId: 'u1', workspaceId: 'w1', purpose: 'answer',
  contentHash: 'a'.repeat(64), baseRevision: 'fixture-r1', state: 'done', modelId: 'fixture-model' };
const issued = { ...context, scopes: ['workspace:read', 'model:answer'] };
function setup(readModelOperation?: Services['readModelOperation']) {
  const services = fixtureServices({ context: async () => ({ ok: true, data: issued }), readModelOperation }); const app = new Hono(); registerRoutes(app, services);
  return { services, read: () => app.request('/api/retrieval/answer/operations/approved') };
}
describe('1.9 read-only model operation adapter', () => {
  it('reads an actor-bound answer receipt without sending or reconstructing model output', async () => {
    const f = setup(async (ctx, id) => { expect(ctx).toBe(issued); expect(id).toBe('approved'); return { ok: true, data: receipt }; });
    const response = await f.read(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toEqual(receipt); expect(f.services.complete).not.toHaveBeenCalled();
  });
  it('keeps a missing record distinct from an unavailable port', async () => {
    const missing = await setup(async () => ({ ok: true, data: null })).read();
    expect(missing.status).toBe(200); expect((await missing.json()).data).toBeNull();
    expect((await setup().read()).status).toBe(503);
  });
  it('rejects unrelated actor, workspace, purpose or approval receipts and extra private data', async () => {
    for (const patch of [{ actorId: 'other' }, { workspaceId: 'other' }, { purpose: 'extract' as const }, { approvalId: 'different' }, { output: 'PRIVATE_MODEL_BODY' }]) {
      const f = setup(async () => ({ ok: true, data: { ...receipt, ...patch } })); const response = await f.read();
      expect([403, 502]).toContain(response.status); expect(await response.text()).not.toContain('PRIVATE_MODEL_BODY');
      expect(f.services.complete).not.toHaveBeenCalled();
    }
  });
  it('requires receipt scopes before reading and rechecks them before releasing metadata', async () => {
    const read = vi.fn<NonNullable<Services['readModelOperation']>>(async () => ({ ok: true, data: receipt }));
    const f = setup(read);
    f.services.context = async () => ({ ok: true, data: context });
    expect((await f.read()).status).toBe(403); expect(read).not.toHaveBeenCalled();
    f.services.context = vi.fn().mockResolvedValueOnce({ ok: true, data: issued }).mockResolvedValueOnce({ ok: true, data: context });
    const response = await f.read(); expect(response.status).toBe(403); expect(await response.text()).not.toContain('fixture-model');
    expect(f.services.snapshot).not.toHaveBeenCalled(); expect(f.services.complete).not.toHaveBeenCalled();
  });
});
