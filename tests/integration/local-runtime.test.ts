import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalDemoRuntime, localDemoFiles, LOCAL_DEMO_KEY } from '../../src/platform/local-demo';
import { createApp } from '../../src/server/app';
import { runLocalJourney } from './local-journey';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));
describe('local usable runtime with synthetic CNB/Git, never live acceptance', () => {
  it('runs the AI-off capture-to-revision journey and independent review through actual shared HTTP Services', async () => {
    const id = `journey-${randomUUID()}`;
    cleanup.push(() => localDemoFiles(id).forEach((file) => { for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); }));
    const runtime = createLocalDemoRuntime(id); cleanup.push(() => runtime.close());
    const app = createApp(runtime.services, { runtime });
    const result = await runLocalJourney((request) => Promise.resolve(app.request(request)));
    expect(result).toMatchObject({ mode: 'fixture', browserAcceptance: false, indexState: 'current' });
    expect(result.afterCommit).not.toBe(result.beforeCommit);
  }, 30_000);
  it('connects real Services, reads seeded knowledge and reviewed questions, keeps AI off and survives a new runtime', async () => {
    const id = `test-${randomUUID()}`;
    cleanup.push(() => localDemoFiles(id).forEach((file) => { for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); }));
    const runtime = createLocalDemoRuntime(id); cleanup.push(() => runtime.close());
    const app = createApp(runtime.services, { runtime });
    const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json' };
    const connection = await app.request('/api/workspace/connect', { method: 'POST', headers, body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
    expect(connection.status).toBe(200);
    const Cookie = connection.headers.get('Set-Cookie')!.split(';')[0]!;
    const session = (await connection.json()).data;
    expect(session).toMatchObject({ actorId: 'cnb-user:local-demo', workspace: { mode: 'fixture', visibility: 'private' } });
    const context = await runtime.services.context(new Request('http://localhost', { headers: { Cookie } })); if (!context.ok) throw Error('Missing demo identity');
    expect(await runtime.services.settings(context.data)).toMatchObject({ ok: true, data: { aiAnswer: false, aiReview: false, aiExtraction: false, saveQueryHistory: false } });
    const snapshot = await runtime.services.snapshot(context.data); expect(snapshot.ok).toBe(true); if (!snapshot.ok) return;
    expect(snapshot.data.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'demo-cache', confirmation: 'confirmed' })]));
    expect(await runtime.services.readReviewQuestions!(context.data, { nodeId: 'demo-cache', revision: snapshot.data.revision })).toMatchObject({ ok: true, data: [expect.objectContaining({ reviewStatus: 'approved' })] });
    runtime.close();
    const reopened = createLocalDemoRuntime(id); cleanup.push(() => reopened.close());
    const newApp = createApp(reopened.services, { runtime: reopened });
    expect((await newApp.request('/api/workspace/session', { headers: { ...headers, Cookie } })).status).toBe(401);
    const connectedAgain = await newApp.request('/api/workspace/connect', { method: 'POST', headers, body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
    expect(connectedAgain.status).toBe(200);
    expect(reopened.status().mode).toBe('fixture');
    expect(reopened.status().cnbConnected).toBe(false);
  });
});
