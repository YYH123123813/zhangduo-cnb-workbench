import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLocalDemoRuntime, LOCAL_DEMO_KEY } from '../../src/platform/local-demo';
import { createApp } from '../../src/server/app';
import { CONTRACT_VERSION } from '../../src/contracts/domain';
import { SESSION_BINDING_HEADER, workspaceSessionBinding } from '../../src/contracts/session';
import type { ChatGateway } from '../../src/platform/ai-providers';
import type { TrainingExecutor } from '../../src/platform/training-runner';
import { simulatedTraining, syntheticGateway } from '../../tools/intelligence-fixture-adapters';
import { seedIntelligenceFixture } from '../../tools/intelligence-fixture-seed';
import { DEFAULT_INTELLIGENCE, type TrainingRun } from '../../src/contracts/intelligence';

describe('final isolated intelligence preview wiring', () => {
  it('creates two eligible source groups through HTTP archive and human confirmation without duplicate seeding', async () => {
    const simulation = simulatedTraining(() => 'complete');
    const runtime = createLocalDemoRuntime(`final-seed-${randomUUID()}`, { aiGateway: syntheticGateway(), trainingExecutor: simulation });
    const app = createApp(runtime.services, { runtime });
    try {
      const samples = await seedIntelligenceFixture(app);
      expect(samples).toHaveLength(2); expect(new Set(samples.map((node) => node.id)).size).toBe(2);
      expect(await seedIntelligenceFixture(app)).toEqual(samples);
      const connected = await runtime.connect({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }, new Request('http://localhost'));
      expect(connected.ok).toBe(true); if (!connected.ok) throw Error('Synthetic connection failed');
      const ctx = await runtime.services.context(new Request('http://localhost', { headers: { Authorization: `Bearer ${connected.data.sessionToken}` } }));
      if (!ctx.ok) throw Error('Synthetic context failed');
      const result = await runtime.services.intelligenceCommand!(ctx.data, { action: 'train', operationId: randomUUID(), expectedRevision: 1,
        mode: 'lora', nodeIds: samples.map((node) => node.id), nodeRevisions: Object.fromEntries(samples.map((node) => [node.id, node.revision])), trainingConsent: true, confirmed: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } finally { await simulation.shutdown(); runtime.close(); }
  });
  it('rejects unconfigured and unsupported synthetic model capabilities instead of returning fake structured success', async () => {
    const gateway = syntheticGateway();
    expect(await gateway.send('openai', [])).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(await gateway.send('local', [{ role: 'user', text: '{}' }], true)).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
  });
  it('holds and fails only simulated workers and waits for their shutdown before exposing cleanup', async () => {
    const executor = simulatedTraining(() => 'hold'), id = randomUUID();
    const run: TrainingRun = { id, mode: 'smoke', state: 'running', createdAt: new Date().toISOString(), datasetHash: 'synthetic-only', settingsRevision: 0,
      sampleCount: 0, nodeRefs: [], message: 'Simulated test, no real worker' };
    const promise = executor.run({ workspace: 'synthetic', mode: 'fixture', run, samples: [], settings: DEFAULT_INTELLIGENCE });
    const rejected = expect(promise).rejects.toThrow('stopping');
    expect(executor.inspect!('synthetic', 'fixture', id)).toBe('running');
    expect(() => executor.remove!('synthetic', 'fixture', id)).toThrow('still running');
    await executor.shutdown(); await rejected;
    expect(executor.inspect!('synthetic', 'fixture', id)).toBe('stopped');
  });
  it('injects only the synthetic external gateway and keeps authenticated HTTP and storage real', async () => {
    const send = vi.fn<ChatGateway['send']>(async () => ({ ok: true, data: { text: 'Synthetic response, not a real model.', modelId: 'synthetic-fixture' } }));
    const gateway: ChatGateway = { status: () => [{ id: 'local', ready: true, model: 'synthetic-fixture' }], send };
    const executor: TrainingExecutor = { ready: () => false, pretrainedReady: () => false,
      run: async () => { throw Error('Preview training is disabled'); }, infer: async () => { throw Error('Preview inference is disabled'); } };
    const runtime = createLocalDemoRuntime(`final-test-${randomUUID()}`, { aiGateway: gateway, trainingExecutor: executor });
    const app = createApp(runtime.services, { runtime });
    try {
      const connection = await app.request('/api/workspace/connect', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
      const connected = await connection.json(), cookie = connection.headers.get('set-cookie')!.split(';')[0]!;
      const binding = await workspaceSessionBinding(connected.data);
      const headers = { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', [SESSION_BINDING_HEADER]: binding };
      const overview = await app.request('/api/intelligence', { headers }), body = await overview.json();
      expect(body.meta).toMatchObject({ mode: 'fixture', contractVersion: CONTRACT_VERSION });
      expect(overview.headers.get(SESSION_BINDING_HEADER)).toBe(binding);
      expect(body.data.providers).toEqual(gateway.status()); expect(body.data.training.ready).toBe(false);
      const operationId = randomUUID();
      const created = await (await app.request('/api/intelligence', { method: 'POST', headers,
        body: JSON.stringify({ action: 'create_chat', operationId, title: 'Synthetic final preview', confirmed: true, retentionDays: 30 }) })).json();
      const sent = await (await app.request('/api/intelligence', { method: 'POST', headers, body: JSON.stringify({ action: 'send', operationId: randomUUID(),
        id: created.data.id, expectedRevision: created.data.revision, text: 'Synthetic user message.', provider: 'local', confirmed: true, modelConsent: true }) })).json();
      expect(sent.ok).toBe(true); expect(send).toHaveBeenCalledTimes(1);
      expect(sent.data.messages.map((entry: { role: string }) => entry.role)).toEqual(['user', 'assistant']);
      expect((await app.request(`/api/intelligence/chats/${operationId}`, { headers })).status).toBe(200);
      expect(runtime.status().cnbConnected).toBe(false);
    } finally { runtime.close(); }
  });
});
