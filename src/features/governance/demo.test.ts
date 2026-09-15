import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, json, node, ok, snapshot } from './fixtures.test-support';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import { createApp } from '../../server/app';
import { DataFlow, type DataAction } from './data-flow';
import type { RequestApi } from './approval-flow';
import type { OperationJournal } from '../../platform/journal';
import { afterEach } from 'vitest';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));

const input = { action: 'preview', operationId: 'demo-operation-1', baseRevision: 'fixture-r1', items: [{ nodeId: 'node-1', publicTitle: 'Cache example', publicStatement: 'Check conditions before reuse.', publicConditions: ['Demo condition'], publicSourceLabels: ['Redacted local example'] }], modelDeclaration: 'unknown' };
describe('G13 minimal redacted demonstration package', () => {
  it('uses only explicit public copy and never publishes or copies private source content', async () => {
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ nodes: [node('node-1', { title: 'PRIVATE_TITLE', humanStatement: 'PRIVATE_BODY', conversationId: 'PRIVATE_CONVERSATION', confirmedBy: 'PRIVATE_ACTOR' })] }))) });
    const response = await app.request('/api/governance/demo/preview', json('POST', input));
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ['PRIVATE_TITLE', 'PRIVATE_BODY', 'PRIVATE_CONVERSATION', 'PRIVATE_ACTOR']) expect(text).not.toContain(secret);
    const data = JSON.parse(text).data;
    expect(data).toMatchObject({ published: false, accessVerified: false, approvalStatus: 'unavailable', authorizationBinding: { purpose: 'demo_export', destination: 'local_download', operationId: input.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, baseRevision: input.baseRevision, objectIds: ['node-1'], contentHash: data.previewHash } });
    expect(data.files[0].content).toContain('Check conditions');
    expect(JSON.parse(data.files[1].content)).not.toHaveProperty('workspaceId');
    expect(JSON.parse(data.files[1].content)).not.toHaveProperty('objectIds');
    expect(JSON.stringify(data.files)).not.toContain(ctx.actorId);
    expect(services.exportData).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
  });
  it('rejects stale, missing or misleading source declarations', async () => {
    const { app } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ nodes: [node('node-1', { authorship: 'ai_accepted' })] }))) });
    expect((await app.request('/api/governance/demo/preview', json('POST', { ...input, baseRevision: 'old' }))).status).toBe(409);
    expect((await app.request('/api/governance/demo/preview', json('POST', { ...input, modelDeclaration: 'not_used' }))).status).toBe(422);
    expect((await app.request('/api/governance/demo/preview', json('POST', { ...input, items: [] }))).status).toBe(422);
  });
  it('blocks withdrawn or deletion-barrier objects before building a demo package', async () => {
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ nodes: [node('node-1', { lifecycle: 'withdrawn' })], excludedIds: ['node-1'] }))) });
    const response = await app.request('/api/governance/demo/preview', json('POST', input));
    expect(response.status).toBe(403);
    expect(services.exportData).not.toHaveBeenCalled();
  });
  it('cancels or denies export permission without preparing a package', async () => {
    const { app, services } = fixture();
    expect((await app.request('/api/governance/demo/preview', json('POST', { action: 'cancel' }))).status).toBe(200);
    expect(services.snapshot).not.toHaveBeenCalled();
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/demo/preview', json('POST', input))).status).toBe(403);
  });

  it('invalidates the future authorization binding when redacted content, scope, version or operator changes', async () => {
    const first = fixture();
    const original = (await (await first.app.request('/api/governance/demo/preview', json('POST', input))).json()).data;
    const changedText = (await (await first.app.request('/api/governance/demo/preview', json('POST', { ...input, items: [{ ...input.items[0], publicStatement: 'A changed redacted statement' }] }))).json()).data;
    expect(changedText.previewHash).not.toBe(original.previewHash);
    expect(changedText.authorizationBinding).toMatchObject({ operationId: input.operationId, actorId: ctx.actorId, workspaceId: ctx.workspaceId, objectIds: ['node-1'], baseRevision: input.baseRevision });
    expect(first.services.exportData).not.toHaveBeenCalled();
  });

  it('uses the shared demo_export approval and execution ports with one stable operation ID', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    const app = createApp(s.services);
    const request = vi.fn<RequestApi>(async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json());
    const previewResponse = await request('/api/governance/demo/preview', json('POST', {
      action: 'preview', operationId: 'demo-operation-shared', baseRevision: s.base,
      items: [{ nodeId: 'k1', publicTitle: 'Public title', publicStatement: 'Public statement', publicConditions: ['Public condition'], publicSourceLabels: ['Public source'] }],
      modelDeclaration: 'not_used',
    }));
    expect(previewResponse.ok, JSON.stringify(previewResponse)).toBe(true);
    if (!previewResponse.ok) return;
    const preview = previewResponse.data as Awaited<ReturnType<typeof import('./demo').demoPreview>>;
    expect(preview.approvalStatus).toBe('required');
    expect(preview.request).toMatchObject({ operationId: 'demo-operation-shared', confirmed: true, destination: 'local_download' });
    expect(preview.authorizationBinding).toMatchObject({ purpose: 'demo_export', operationId: 'demo-operation-shared', contentHash: preview.contentHash, requestHash: preview.requestHash });

    const flow = new DataFlow(request);
    expect(flow.prepare({ kind: 'demo', workspaceId: s.ctx.workspaceId, preview } as DataAction, s.ctx.actorId)).toBe(true);
    expect(flow.getSnapshot().prepared?.operationId).toBe('demo-operation-shared');
    await flow.approve();
    await flow.commit();
    expect(flow.getSnapshot(), JSON.stringify(flow.getSnapshot())).toMatchObject({ stage: 'succeeded', result: { kind: 'demo', value: { operationId: 'demo-operation-shared', published: false, destination: 'local_download' } } });
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/approvals/demo-export')).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/demo-exports')).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => path === '/api/workspace/operation-recovery/demo_export/demo-operation-shared')).toBe(true);
    expect(request.mock.calls.some(([path]) => path === '/api/workspace/demo-exports/demo-operation-shared')).toBe(true);
  });

  it('recovers an unknown demo execution by operation-recovery and the same download operation without replaying POST', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    const app = createApp(s.services);
    const original: RequestApi = async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json();
    const request = vi.fn<RequestApi>(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/workspace/demo-exports' && init?.method === 'POST') throw new Error('lost demo export response');
      return response;
    });
    const previewResponse = await request('/api/governance/demo/preview', json('POST', {
      action: 'preview', operationId: 'demo-operation-unknown', baseRevision: s.base,
      items: [{ nodeId: 'k1', publicTitle: 'Public title', publicStatement: 'Public statement', publicConditions: [], publicSourceLabels: [] }],
      modelDeclaration: 'unknown',
    }));
    expect(previewResponse.ok).toBe(true);
    if (!previewResponse.ok) return;
    const flow = new DataFlow(request);
    flow.prepare({ kind: 'demo', workspaceId: s.ctx.workspaceId, preview: previewResponse.data as never } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot(), JSON.stringify(flow.getSnapshot())).toMatchObject({ stage: 'succeeded', result: { kind: 'demo' } });
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/demo-exports')).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/operation-recovery/demo_export/demo-operation-unknown')).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/demo-exports/demo-operation-unknown')).toHaveLength(1);
  });

  it('keeps a demo execution unknown when recovery metadata does not match the original request', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    const app = createApp(s.services);
    const original: RequestApi = async (path, init) => (await app.request(path, { ...init, headers: s.headers })).json();
    const request = vi.fn<RequestApi>(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/workspace/demo-exports' && init?.method === 'POST') throw new Error('lost demo export response');
      if (path === '/api/workspace/operation-recovery/demo_export/demo-operation-mismatch' && response.ok) return { ...response, data: { ...(response.data as Record<string, unknown>), contentHash: 'f'.repeat(64) } };
      return response;
    });
    const previewResponse = await request('/api/governance/demo/preview', json('POST', {
      action: 'preview', operationId: 'demo-operation-mismatch', baseRevision: s.base,
      items: [{ nodeId: 'k1', publicTitle: 'Public title', publicStatement: 'Public statement', publicConditions: [], publicSourceLabels: [] }],
      modelDeclaration: 'unknown',
    }));
    expect(previewResponse.ok).toBe(true);
    if (!previewResponse.ok) return;
    const flow = new DataFlow(request);
    flow.prepare({ kind: 'demo', workspaceId: s.ctx.workspaceId, preview: previewResponse.data as never } as DataAction, s.ctx.actorId);
    await flow.approve(); await flow.commit();
    expect(flow.getSnapshot().stage).toBe('unknown');
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/demo-exports').length).toBe(1);
    expect(request.mock.calls.filter(([path]) => path === '/api/workspace/demo-exports/demo-operation-mismatch').length).toBe(0);
  });
});
