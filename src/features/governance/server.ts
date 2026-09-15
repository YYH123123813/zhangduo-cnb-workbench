import type { Hono } from 'hono';
import type { Services } from '../../contracts/ports';
import { body, cancelled, checkBase, fail, parse, readSnapshot, requireScope, route, unwrap } from './http';
import { nodeRequestSchema, revisionPreview } from './revisions';
import { impactRequestSchema, readImpact } from './impact';
import { relationPreview, relationRequestSchema } from './relations';
import { commitChanges, commitRequestSchema, prepareChanges, prepareRequestSchema } from './commit';
import { replacementPreview, replaceRequestSchema } from './replacement';
import { historySelectionQuery, readSelectedHistory } from './history-selection';
import { SCOPES } from '../../contracts/scopes';
import { restorePreview, restoreRequestSchema, validateRestoration } from './restore';
import { executeExport, exportPreview, exportRequestSchema } from './export';
import { deleteExecuteRequestSchema, deletePreviewRequestSchema, deleteVerifyRequestSchema, executeDeletion, previewDeletion, readDeletion } from './deletion';
import { changeSettings, settingsRequestSchema, settingsStatus, readSettingsSave, settingsVerifySchema } from './settings';
import { auditView } from './audit';
import { demoPreview, demoRequestSchema } from './demo';
import { readChangesRequestSchema, readCommittedChanges } from './readback';
import { operationLookupSchema, operationScope, readOperation } from './operation-readback';
import { compareVersions, comparisonRequestSchema } from './versions';

export function registerRoutes(app: Hono, services: Services) {
  app.get('/api/governance/nodes/:id/compare', (c) => route(c, services, SCOPES.knowledgeRead, async (ctx) =>
    compareVersions(services, ctx, parse(comparisonRequestSchema, { nodeId: c.req.param('id'), revision: c.req.query('revision') }))));
  app.get('/api/governance/operations/:kind/:id', (c) => route(c, services, operationScope(c.req.param('kind')), async (ctx) =>
    readOperation(services, ctx, parse(operationLookupSchema, { kind: c.req.param('kind'), id: c.req.param('id') }))));
  app.get('/api/governance/status', (c) => route(c, services, 'knowledge:read', async (ctx) => ({
    snapshot: await readSnapshot(services, ctx), actorId: ctx.actorId, scopes: ctx.scopes, implementation: 'implemented_fixture',
  })));
  app.patch('/api/governance/nodes/:id', (c) => route(c, services, 'knowledge:write', async (ctx) => {
    const input = await body(c, nodeRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return revisionPreview(await readSnapshot(services, ctx), ctx, c.req.param('id'), input);
  }));
  app.post('/api/governance/impact', (c) => route(c, services, 'knowledge:read', async (ctx) => {
    const input = await body(c, impactRequestSchema);
    if (input.action === 'cancel') return cancelled;
    const snapshot = await readSnapshot(services, ctx);
    return readImpact(services, ctx, snapshot, input);
  }));
  app.post('/api/governance/changes/prepare', (c) => route(c, services, SCOPES.knowledgeWrite, async (ctx) => {
    const input = await body(c, prepareRequestSchema);
    if (input.action === 'cancel') return cancelled;
    const snapshot = await readSnapshot(services, ctx);
    checkBase(snapshot, input.changes.baseRevision);
    const restoredIds = await validateRestoration(services, ctx, snapshot, input.changes, input.restoration);
    return prepareChanges(ctx, snapshot, input.changes, !!services.approveKnowledge, restoredIds, input.restoration);
  }));
  app.patch('/api/governance/relations/:id', (c) => route(c, services, 'knowledge:write', async (ctx) => {
    const input = await body(c, relationRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return relationPreview(await readSnapshot(services, ctx), ctx, c.req.param('id'), input);
  }));
  app.post('/api/governance/changes/commit', (c) => route(c, services, 'knowledge:write', async (ctx) => {
    const input = await body(c, commitRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return commitChanges(services, ctx, input);
  }));
  app.post('/api/governance/changes/verify', (c) => route(c, services, SCOPES.knowledgeRead, async (ctx) => {
    const input = await body(c, readChangesRequestSchema);
    return input.action === 'cancel' ? cancelled : readCommittedChanges(services, ctx, input.changes);
  }));
  app.post('/api/governance/replace', (c) => route(c, services, 'knowledge:write', async (ctx) => {
    const input = await body(c, replaceRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return replacementPreview(await readSnapshot(services, ctx), ctx, input);
  }));
  app.get('/api/governance/history', (c) => route(c, services, SCOPES.knowledgeRead, async (ctx) => {
    requireScope(ctx, SCOPES.evidenceRead);
    return readSelectedHistory(services, ctx, historySelectionQuery(c.req.queries()));
  }));
  app.post('/api/governance/rollback', (c) => route(c, services, SCOPES.knowledgeWrite, async (ctx) => {
    const input = await body(c, restoreRequestSchema);
    if (input.action === 'cancel') return cancelled;
    const head = await readSnapshot(services, ctx);
    checkBase(head, input.baseRevision);
    return restorePreview(head, await readSnapshot(services, ctx, input.historicalRevision), ctx, input);
  }));
  app.post('/api/governance/export', (c) => route(c, services, SCOPES.dataExport, async (ctx) => {
    const input = await body(c, exportRequestSchema);
    if (input.action === 'cancel') return cancelled;
    const snapshot = await readSnapshot(services, ctx);
    return input.action === 'preview' ? exportPreview(services, ctx, snapshot, input) : executeExport(services, ctx, snapshot, input);
  }));
  app.post('/api/governance/delete/preview', (c) => route(c, services, SCOPES.dataDelete, async (ctx) => {
    const input = await body(c, deletePreviewRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return previewDeletion(services, ctx, await readSnapshot(services, ctx), input);
  }));
  app.post('/api/governance/delete/execute', (c) => route(c, services, SCOPES.dataDelete, async (ctx) => {
    const input = await body(c, deleteExecuteRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return executeDeletion(services, ctx, await readSnapshot(services, ctx), input);
  }));
  app.post('/api/governance/delete/verify', (c) => route(c, services, SCOPES.dataDelete, async (ctx) => {
    const input = await body(c, deleteVerifyRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return readDeletion(services, ctx, await readSnapshot(services, ctx), input);
  }));
  app.get('/api/governance/settings', (c) => route(c, services, SCOPES.settingsRead, async (ctx) => settingsStatus(services, ctx, await readSnapshot(services, ctx))));
  app.post('/api/governance/settings/verify', (c) => route(c, services, SCOPES.settingsRead, async (ctx) => {
    const input = await body(c, settingsVerifySchema);
    return input.action === 'cancel' ? cancelled : readSettingsSave(services, ctx, await readSnapshot(services, ctx), input);
  }));
  app.patch('/api/governance/settings', (c) => route(c, services, SCOPES.settingsWrite, async (ctx) => {
    const input = await body(c, settingsRequestSchema);
    if (input.action === 'cancel') return cancelled;
    requireScope(ctx, SCOPES.settingsRead);
    return changeSettings(services, ctx, await readSnapshot(services, ctx), input);
  }));
  app.get('/api/governance/audit', (c) => route(c, services, SCOPES.auditRead, async (ctx) => auditView(unwrap(await services.audit(ctx)))));
  app.post('/api/governance/demo/preview', (c) => route(c, services, SCOPES.dataExport, async (ctx) => {
    const input = await body(c, demoRequestSchema);
    if (input.action === 'cancel') return cancelled;
    return demoPreview(ctx, await readSnapshot(services, ctx), input, { approvalAvailable: !!services.approveDemoExport && !!services.executeDemoExport && !!services.readDemoExport && !!services.readOperationRecovery });
  }));
}
