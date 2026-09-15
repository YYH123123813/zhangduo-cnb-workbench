import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, hashExport } from '../../contracts/hash';
import { knowledgeFiles } from '../../platform/cnb/knowledge-document';
import { ctx, fixture, json, ok, snapshot, structuredUse } from './fixtures.test-support';

function bundle() {
  const snap = snapshot();
  return { files: [...Object.entries(knowledgeFiles({ schemaVersion: 1, workspaceId: snap.workspaceId, nodes: [snap.nodes[0]!], relations: [], excludedIds: [] })).map(([path, content]) => ({ path, content })),
    { path: 'manifest.json', content: canonicalJson({ workspaceId: snap.workspaceId, baseRevision: snap.revision, objectIds: ['node-1'], includesPrivateIssues: false }) }], limitations: ['Git history excluded'] };
}

const preview = { action: 'preview', objectIds: ['node-1'], baseRevision: 'fixture-r1' };
async function executeInput() {
  const contentHash = await hashExport(ctx.workspaceId, preview.baseRevision, preview.objectIds);
  return { ...preview, action: 'execute', approval: { id: 'export-consent', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'export', objectIds: preview.objectIds, contentHash, baseRevision: preview.baseRevision, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } };
}
describe('G07 scoped export', () => {
  it('includes explicit selection of task-condition nodes beyond the original use nodeRefs', async () => {
    const use = structuredUse(); use.useContext!.task.conditionChecks = [{ nodeRef: { workspaceId: ctx.workspaceId, objectId: 'checked-node', revision: 'a'.repeat(40) }, conditionId: 'condition-1', status: 'unknown' }];
    const { app, services } = fixture({ listEvidence: vi.fn(async () => ok([use])) });
    expect((await app.request('/api/governance/export', json('POST', { ...preview, objectIds: ['node-1', use.id] }))).status).toBe(422);
    expect(services.exportData).not.toHaveBeenCalled();
  });
  it('requires explicit nested original path selection and refuses a blocked structured use before returning any contents', async () => {
    const use = structuredUse(); use.useContext!.paths[0]!.nodeIds.push('nested-node');
    const selected = { ...preview, objectIds: ['node-1', use.id] };
    const incomplete = fixture({ listEvidence: vi.fn(async () => ok([use])) });
    expect((await incomplete.app.request('/api/governance/export', json('POST', selected))).status).toBe(422);
    const blocked = fixture({ listEvidence: vi.fn(async () => ok([use])), snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['nested-node'] }))) });
    const response = await blocked.app.request('/api/governance/export', json('POST', selected));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('Original task question'); expect(blocked.services.exportData).not.toHaveBeenCalled();
  });
  it.each(['missing_manifest', 'wrong_revision', 'missing_object', 'changed_sources', 'hidden_field', 'duplicate_json', 'extra_file', 'missing_markdown', 'wrong_markdown'] as const)('rejects a nonempty %s bundle without exposing its contents', async (scenario) => {
    const exported = bundle();
    if (scenario === 'missing_manifest') exported.files = exported.files.filter((file) => file.path !== 'manifest.json');
    if (scenario === 'wrong_revision') exported.files.find((file) => file.path === 'manifest.json')!.content = canonicalJson({ workspaceId: ctx.workspaceId, baseRevision: 'other-revision', objectIds: ['node-1'], includesPrivateIssues: false });
    if (['missing_object', 'changed_sources', 'hidden_field'].includes(scenario)) {
      const file = exported.files.find((file) => file.path === 'knowledge/snapshot.json')!;
      const document = JSON.parse(file.content);
      if (scenario === 'missing_object') document.nodes = [];
      if (scenario === 'changed_sources') document.nodes[0].sources[0].excerpt = 'UNAPPROVED_PRIVATE_CONTENT';
      if (scenario === 'hidden_field') document.nodes[0].privateIssue = 'UNAPPROVED_PRIVATE_CONTENT';
      file.content = canonicalJson(document);
    }
    if (scenario === 'duplicate_json') {
      const file = exported.files.find((file) => file.path === 'knowledge/snapshot.json')!;
      file.content = file.content.replace('"humanStatement":', '"humanStatement":"UNAPPROVED_PRIVATE_CONTENT","humanStatement":');
    }
    if (scenario === 'extra_file') exported.files.push({ path: 'knowledge/unselected.html', content: 'UNAPPROVED_PRIVATE_CONTENT' });
    if (scenario === 'missing_markdown') exported.files = exported.files.filter((file) => !file.path.endsWith('.md'));
    if (scenario === 'wrong_markdown') exported.files.find((file) => file.path.endsWith('.md'))!.content = '# UNAPPROVED_PRIVATE_CONTENT';
    const { app } = fixture({ exportData: vi.fn(async () => ok(exported)) });
    const response = await app.request('/api/governance/export', json('POST', await executeInput()));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('UNAPPROVED_PRIVATE_CONTENT');
  });
  it('blocks selected deletion exclusions before reading evidence or generating an export', async () => {
    const { app, services } = fixture({ snapshot: vi.fn(async () => ok(snapshot({ excludedIds: ['node-1'] }))) });
    expect((await app.request('/api/governance/export', json('POST', preview))).status).toBe(403);
    expect(services.exportData).not.toHaveBeenCalled(); expect(services.listEvidence).not.toHaveBeenCalled();
  });
  it('does not offer an empty successful platform bundle for download', async () => {
    const { app } = fixture({ exportData: vi.fn(async () => ok({ files: [], limitations: [] })) });
    const response = await app.request('/api/governance/export', json('POST', await executeInput()));
    expect(response.status).toBe(502); expect((await response.json()).ok).toBe(false);
  });
  it('previews readable knowledge and sources without exporting private Issues or calling a write port', async () => {
    const { app, services } = fixture();
    const data = (await (await app.request('/api/governance/export', json('POST', preview))).json()).data;
    expect(data.objectIds).toEqual(['node-1']);
    expect(data.files.find((file: { path: string }) => file.path.endsWith('.md')).content).toContain('Reuse only when');
    expect(data.excludes).toContain('private_issues');
    expect(data.contentHash).toBe(await hashExport(ctx.workspaceId, preview.baseRevision, preview.objectIds));
    expect(services.exportData).not.toHaveBeenCalled();
  });
  it('validates consent and delegates only the chosen IDs', async () => {
    const exportData = vi.fn(async () => ok(bundle()));
    const { app } = fixture({ exportData });
    const input = await executeInput();
    expect((await app.request('/api/governance/export', json('POST', input))).status).toBe(200);
    expect(exportData).toHaveBeenCalledWith(ctx, ['node-1'], input.approval);
  });
  it('rejects unsafe paths, private original content categories and duplicate paths', async () => {
    for (const files of [[{ path: '../secret.md', content: 'private' }], [{ path: 'issues/1.md', content: 'private' }], [{ path: 'knowledge/%2e%2e/private.md', content: 'private' }], [{ path: 'knowledge/a.md', content: 'one' }, { path: 'knowledge/a.md', content: 'two' }]]) {
      const { app } = fixture({ exportData: vi.fn(async () => ok({ files, limitations: [] })) });
      const response = await app.request('/api/governance/export', json('POST', await executeInput()));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('private');
    }
  });
  it('cancels, denies scope and rejects stale or expanded export ranges', async () => {
    const { app, services } = fixture();
    await app.request('/api/governance/export', json('POST', { action: 'cancel' }));
    expect(services.snapshot).not.toHaveBeenCalled();
    expect((await app.request('/api/governance/export', json('POST', { ...preview, baseRevision: 'old' }))).status).toBe(409);
    const expanded = { ...await executeInput(), objectIds: ['node-1', 'node-2'] };
    expect((await app.request('/api/governance/export', json('POST', expanded))).status).toBe(409);
    const denied = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await denied.app.request('/api/governance/export', json('POST', preview))).status).toBe(403);
    expect(services.exportData).not.toHaveBeenCalled();
  });
});
