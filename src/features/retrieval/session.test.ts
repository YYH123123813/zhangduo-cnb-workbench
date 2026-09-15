import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from './server';
import { context, fixtureServices, request } from './test-support';

const reads = [
  { path: '/api/retrieval/query', init: { method: 'POST', body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' } } },
  { path: '/api/retrieval/nodes/n1', init: {} },
  { path: '/api/retrieval/graph/n1', init: {} },
];

describe('R04/R11 final read authorization', () => {
  it.each(reads)('passes the original trusted context object through $path', async ({ path, init }) => {
    const issued = Object.freeze({ ...context, scopes: Object.freeze([...context.scopes]) });
    const base = fixtureServices();
    const services = fixtureServices({ context: async () => ({ ok: true, data: issued }), snapshot: async (ctx) => {
      if (ctx !== issued) return { ok: false, error: { code: 'FORBIDDEN', message: 'Unregistered context', nextAction: 'sign_in', retryable: false, dataState: 'not_written' } };
      return base.snapshot(ctx);
    } });
    const app = new Hono(); registerRoutes(app, services);
    expect((await app.request(new Request(`http://localhost${path}`, init))).status).toBe(200);
  });
  it.each(reads)('discards $path when cancellation arrives during the final context check', async ({ path, init }) => {
    const controller = new AbortController(); let calls = 0;
    const services = fixtureServices({ context: async () => {
      if (++calls === 2) controller.abort();
      return { ok: true, data: context };
    } });
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request(new Request(`http://localhost${path}`, { ...init, signal: controller.signal }));
    expect(calls).toBe(2); expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('Cache immutable data.');
  });
  it.each(reads)('does not allow a reused mutable session object to rebind $path', async ({ path, init }) => {
    const trusted = structuredClone(context); let calls = 0;
    const services = fixtureServices({ context: async () => {
      if (++calls === 2) trusted.actorId = 'another-actor';
      return { ok: true, data: trusted };
    } });
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request(new Request(`http://localhost${path}`, init));
    expect(calls).toBe(2); expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Cache immutable data.');
  });
});
