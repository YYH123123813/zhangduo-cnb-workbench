import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from './server';
import { context, fixtureServices, task, useInput } from './testing/fixtures';
import { failure, success } from './errors';
import { buildUseDraft } from './history';
import { snapshot } from './testing/fixtures';
import type { RetrievalResult } from '../../contracts/domain';

describe('L01 trusted application routes', () => {
  it.each(['partial', 'unavailable'] as const)('previews a %s retrieval handoff without claiming trusted exposure or storing it', async (coverage) => {
    const retrieval: RetrievalResult = {
      queryId: 'query-1', snapshotRevision: snapshot.revision,
      groups: { eligible: [], conditional: snapshot.nodes, conflicts: [], excludedIds: [] },
      paths: [{ seedId: 'node-1', nodeIds: ['node-1'], relationIds: [], reason: 'Selected retrieval result' }],
      answer: null, missingConditions: ['A local copy exists'], warnings: ['Coverage warning'], coverage,
    };
    const semanticQueryWithStatus = vi.fn(async () => failure('NOT_IMPLEMENTED', 'Unexpected semantic query'));
    const approveModel = vi.fn(async () => failure('NOT_IMPLEMENTED', 'Unexpected model approval'));
    const services = fixtureServices({ semanticQueryWithStatus, approveModel }); const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({
      action: 'preview_retrieved', task, retrieval, nodeId: 'node-1', decision: 'adopt', reason: useInput.reason,
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: {
      persistence: 'not_saved', handoffTrust: 'client_preview_only', warnings: expect.arrayContaining(['Coverage warning']),
      draft: { taskSnapshot: task, retrievalContext: { queryId: 'query-1', coverage }, paths: retrieval.paths,
        record: { kind: 'use', answerVisible: true, result: 'unverified' }, indexing: 'excluded' },
    } });
    expect(services.appendEvidence).not.toHaveBeenCalled();
    expect(services.complete).not.toHaveBeenCalled();
    expect(services.semanticQuery).not.toHaveBeenCalled();
    expect(semanticQueryWithStatus).not.toHaveBeenCalled();
    expect(approveModel).not.toHaveBeenCalled();
  });
  it('does not mistake a failed authoritative Git read for a usable text fallback', async () => {
    const services = fixtureServices({ snapshot: vi.fn(async () => failure('UPSTREAM', 'Git snapshot is unavailable.')) });
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({
      action: 'preview_retrieved', task, nodeId: 'node-1', decision: 'adopt', reason: useInput.reason,
      retrieval: { queryId: 'query-1', snapshotRevision: snapshot.revision,
        groups: { eligible: [], conditional: snapshot.nodes, conflicts: [], excludedIds: [] },
        paths: [], answer: null, missingConditions: [], warnings: [], coverage: 'unavailable' },
    }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UPSTREAM', dataState: 'not_written' } });
    expect(services.appendEvidence).not.toHaveBeenCalled();
    expect(services.complete).not.toHaveBeenCalled();
    expect(services.semanticQuery).not.toHaveBeenCalled();
  });
  it('previews without invoking a write, model, or semantic index', async () => {
    const services = fixtureServices();
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview', selection: useInput }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { decision: 'adopt', persistence: 'not_saved' }, meta: { mode: 'fixture' } });
    expect(services.appendEvidence).not.toHaveBeenCalled();
    expect(services.complete).not.toHaveBeenCalled();
    expect(services.semanticQuery).not.toHaveBeenCalled();
  });
  it('cancels without reading or persisting personal content', async () => {
    const services = fixtureServices(); const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) });
    expect(await response.json()).toMatchObject({ ok: true, data: { cancelled: true, persistence: 'not_saved' } });
    expect(services.snapshot).not.toHaveBeenCalled(); expect(services.appendEvidence).not.toHaveBeenCalled();
  });
  it('denies forged scopes/mode/workspace and malformed JSON', async () => {
    const services = fixtureServices({ context: async () => success({ ...context, scopes: [] }) });
    const app = new Hono(); registerRoutes(app, services);
    expect((await app.request('/api/learning/context?mode=live', { headers: { 'X-Scopes': 'knowledge:read' } })).status).toBe(403);
    expect(services.snapshot).not.toHaveBeenCalled();
    const other = new Hono(); registerRoutes(other, fixtureServices());
    expect((await other.request('/api/learning/use', { method: 'POST', body: '{' })).status).toBe(422);
    expect((await other.request('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'preview', selection: { ...useInput, task: { ...task, workspaceId: 'other' } } }) })).status).toBe(403);
  });
  it('sanitizes thrown platform failures and disables caches', async () => {
    const app = new Hono(); registerRoutes(app, fixtureServices({ snapshot: vi.fn(async () => { throw new Error('Authorization: secret-private-data'); }) }));
    const response = await app.request('/api/learning/context');
    expect(response.status).toBe(500); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret-private-data');
  });
});

describe('L02 evidence route boundaries', () => {
  it('requires knowledge access for attempt mutations and read-back, without blocking cancellation behind that scope', async () => {
    const services = fixtureServices({ context: vi.fn(async () => success({ ...context, scopes: ['evidence:read', 'evidence:write'] })) });
    const app = new Hono(); registerRoutes(app, services);
    const post = (body: unknown) => app.request('/api/learning/attempts', { method: 'POST', body: JSON.stringify(body) });
    for (const event of [{ type: 'confidence', value: 'skipped' }, { type: 'begin' }, { type: 'hint', level: 1 }, { type: 'reveal' }, { type: 'submit', answer: 'Local copy' }]) {
      const response = await post({ action: 'event', operationId: `event-${event.type}`, attemptId: 'attempt-1', expectedVersion: 2, event });
      expect(response.status, event.type).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
    }
    expect((await post({ action: 'feedback', operationId: 'feedback-1', attemptId: 'attempt-1', expectedVersion: 3, feedbackVersion: 0, review: { criteria: [], invalidReason: 'Invalid question' } })).status).toBe(403);
    expect((await app.request('/api/learning/attempts/attempt-1')).status).toBe(403);
    const cancelled = await post({ action: 'event', operationId: 'event-cancel', attemptId: 'attempt-1', expectedVersion: 2, event: { type: 'cancel' } });
    expect(cancelled.status).toBe(501);
    expect(await cancelled.json()).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED', dataState: 'not_written' } });
    expect(services.snapshot).not.toHaveBeenCalled(); expect(services.listEvidence).not.toHaveBeenCalled();
    expect(services.appendEvidence).not.toHaveBeenCalled(); expect(services.complete).not.toHaveBeenCalled();
  });
  it('refuses ambiguous evidence IDs instead of attaching an outcome to the first matching task', async () => {
    const draft = buildUseDraft(useInput, snapshot, 'record-1', task.updatedAt);
    if (!draft.ok) throw new Error('invalid fixture');
    const records = [draft.data.record, { ...draft.data.record, taskId: 'another-task', answer: 'PRIVATE OTHER RECORD' }];
    const services = fixtureServices({ listEvidence: vi.fn(async () => success(records)) });
    const app = new Hono(); registerRoutes(app, services);
    const listing = await app.request('/api/learning/records');
    expect(listing.status).toBe(502);
    expect(await listing.text()).not.toContain('PRIVATE OTHER RECORD');
    const outcome = await app.request('/api/learning/outcomes', { method: 'POST', body: JSON.stringify({ action: 'preview', outcome: {
      useRecordId: 'record-1', status: 'failed', summary: 'Failed', failureReason: 'Missing prerequisite',
    } }) });
    expect(outcome.status).toBe(502);
    expect(await outcome.text()).not.toContain('revisionLinks');
    expect(services.appendEvidence).not.toHaveBeenCalled();
  });
  it('preserves the original trusted RequestContext object passed to Services', async () => {
    const trusted = Object.freeze({ ...context, scopes: Object.freeze([...context.scopes]) });
    const services = fixtureServices({ context: vi.fn(async () => success(trusted)), snapshot: vi.fn(async (received) => {
      expect(received).toBe(trusted);
      return success(snapshot);
    }) });
    const app = new Hono(); registerRoutes(app, services);
    expect((await app.request('/api/learning/context')).status).toBe(200);
    expect((await app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'preview', selection: useInput }) })).status).toBe(200);
    expect(services.snapshot).toHaveBeenCalledTimes(2);
  });
  it('reads original knowledge by the saved reference, not a caller-selected revision', async () => {
    const revision = 'a'.repeat(40);
    const historical = { ...snapshot, revision, nodes: snapshot.nodes.map((node) => ({ ...node, revision })) };
    const draft = buildUseDraft({ ...useInput, snapshotRevision: revision, nodeRefs: [{ ...useInput.nodeRefs[0], revision }] }, historical, 'record-1', task.updatedAt);
    if (!draft.ok) throw new Error('invalid fixture');
    const services = fixtureServices({ listEvidence: vi.fn(async () => success([draft.data.record])), snapshot: vi.fn(async () => success(historical)) });
    const app = new Hono(); registerRoutes(app, services);
    const path = '/api/learning/records/record-1/knowledge?nodeId=node-1';
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, data: { snapshotRevision: revision, contextState: 'not_recorded', knowledge: { humanStatement: snapshot.nodes[0]!.humanStatement } } });
    expect((await app.request(`${path}&revision=${'b'.repeat(40)}`)).status).toBe(422);
    expect((await app.request(`${path}&nodeId=node-2`)).status).toBe(422);
    expect(services.listEvidence).toHaveBeenCalledTimes(1);
    expect(services.appendEvidence).not.toHaveBeenCalled();
  });
  it('requires consent and never reports an unconnected save as successful', async () => {
    const services = fixtureServices(); const app = new Hono(); registerRoutes(app, services);
    for (const consent of [false, true]) {
      const response = await app.request('/api/learning/use', { method: 'POST', body: JSON.stringify({ action: 'save', selection: useInput, consent }) });
      expect(response.status).toBe(consent ? 501 : 403);
      expect(await response.json()).toMatchObject({ ok: false, error: { dataState: 'not_written' } });
    }
    expect(services.appendEvidence).not.toHaveBeenCalled();
  });
  it('reads original evidence through Services and fails closed on foreign records', async () => {
    const draft = buildUseDraft(useInput, snapshot, 'record-1', task.updatedAt);
    if (!draft.ok) throw new Error('invalid fixture');
    const services = fixtureServices({ listEvidence: async () => success([draft.data.record]) });
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/records?taskId=task-1');
    expect(await response.json()).toMatchObject({ ok: true, data: { records: [{ contextState: 'not_recorded', record: { id: 'record-1' } }] } });
    const privateBody = 'PRIVATE_FOREIGN_LEGACY_RECORD';
    const foreign = new Hono(); registerRoutes(foreign, fixtureServices({ listEvidence: async () => success([{ ...draft.data.record, workspaceId: 'other', answer: privateBody }]) }));
    const denied = await foreign.request('/api/learning/records');
    const deniedBody = await denied.json() as { ok: boolean; error?: { code?: string; message?: string }; data?: unknown };
    expect(denied.status).toBe(403);
    expect(deniedBody).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(deniedBody).not.toHaveProperty('data');
    expect(JSON.stringify(deniedBody)).not.toContain(privateBody);
  });
});

describe('review integration remains fail-closed without trusted ports', () => {
  it('rejects client-supplied exposure proofs and cannot start a pretend session', async () => {
    const services = fixtureServices(); const app = new Hono(); registerRoutes(app, services);
    const start = { action: 'start', operationId: 'attempt-1', taskId: task.id, taskRevision: 1, taskContentHash: 'a'.repeat(64), questionId: 'q-1', questionRevision: 'fixture:q1', nodeRef: useInput.nodeRefs[0], retentionDays: 30, confirmed: true };
    const response = await app.request('/api/learning/attempts', { method: 'POST', body: JSON.stringify(start) });
    expect(response.status).toBe(501);
    const forged = await app.request('/api/learning/attempts', { method: 'POST', body: JSON.stringify({ ...start, answerVisible: false, mode: 'fixture' }) });
    expect(forged.status).toBe(422);
    expect((await app.request('/api/learning/reviews?nodeId=node-1&revision=fixture:r1')).status).toBe(501);
    expect(services.appendEvidence).not.toHaveBeenCalled(); expect(services.complete).not.toHaveBeenCalled();
  });
  it('accepts a well-formed appeal request at the consumer boundary but keeps the unconnected port closed', async () => {
    const services = fixtureServices(); const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/attempts', { method: 'POST', body: JSON.stringify({
      action: 'appeal', operationId: 'appeal-1', attemptId: 'attempt-1', expectedVersion: 3, feedbackVersion: 1,
      nodeRef: useInput.nodeRefs[0], reason: 'The rubric does not match the approved question.',
    }) });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED', dataState: 'not_written' } });
    expect(services.appendEvidence).not.toHaveBeenCalled(); expect(services.complete).not.toHaveBeenCalled();
  });
  it('returns version-fixed revision links for failures and cancels outcome previews without reads', async () => {
    const draft = buildUseDraft(useInput, snapshot, 'record-1', task.updatedAt);
    if (!draft.ok) throw new Error('invalid fixture');
    const services = fixtureServices({ listEvidence: vi.fn(async () => success([draft.data.record])) });
    const app = new Hono(); registerRoutes(app, services);
    const response = await app.request('/api/learning/outcomes', { method: 'POST', body: JSON.stringify({ action: 'preview', outcome: { useRecordId: 'record-1', status: 'failed', summary: 'The copy was missing.', failureReason: 'An unmet prerequisite.' } }) });
    expect(await response.json()).toMatchObject({ ok: true, data: { verification: 'self_reported', revisionLinks: [{ href: '#governance?nodeId=node-1&revision=fixture%3Ar1&useId=record-1&taskId=task-1' }] } });
    const reads = vi.mocked(services.listEvidence).mock.calls.length;
    expect((await app.request('/api/learning/outcomes', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) })).status).toBe(200);
    expect(services.listEvidence).toHaveBeenCalledTimes(reads); expect(services.commit).not.toHaveBeenCalled();
  });
});
