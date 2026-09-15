import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '../../contracts/api';
import type { KnowledgeSnapshot } from '../../contracts/domain';
import { registerRoutes } from './server';
import { context, fixtureServices, node, relation, request, snapshot } from './test-support';

const revision = 'a'.repeat(40);
const foreignText = 'FOREIGN_RELATION_PRIVATE_RATIONALE';
function setup(foreignEndpoint: 'source' | 'target') {
  const nodes = [node('n1', { revision }), node('n2', { revision })];
  const valid = relation('local-edge', 'n1', 'n2', 'depends_on', {
    source: { workspaceId: context.workspaceId, objectId: 'n1', revision },
    target: { workspaceId: context.workspaceId, objectId: 'n2', revision },
  });
  const invalid = (['depends_on', 'contradicts', 'supersedes'] as const).map((type) => ({
    ...valid, id: `foreign-${type}`, type, rationale: foreignText, evidenceIds: ['FOREIGN_EVIDENCE'],
    [foreignEndpoint]: { ...valid[foreignEndpoint], workspaceId: 'other-workspace' },
  }));
  const data: KnowledgeSnapshot = snapshot(nodes, { revision, relations: [valid, ...invalid] });
  const services = fixtureServices({ context: async () => ({ ok: true, data: { ...context, scopes: [...context.scopes, 'model:answer', 'settings:read'] } }),
    snapshot: async () => ({ ok: true, data }),
    settings: async () => ({ ok: true, data: { aiExtraction: false, aiAnswer: true, aiReview: false, saveQueryHistory: false, reviewReminders: false } }),
    approveModel: async () => { throw new Error('No approval requested'); },
    revokeApproval: async () => ({ ok: true, data: { revoked: true } }),
  });
  const app = new Hono(); registerRoutes(app, services);
  return { app, services };
}

describe('R04/R07/R11 workspace-qualified relationship endpoints', () => {
  it.each(['source', 'target'] as const)('rejects a foreign %s ID collision before query or model preview can use it', async (endpoint) => {
    const { app, services } = setup(endpoint);
    const query = await app.request('/api/retrieval/query', { method: 'POST', body: JSON.stringify(request) });
    const body = await query.json() as ApiResponse<unknown>;
    expect(query.status).toBe(502); expect(body).toMatchObject({ ok: false, error: { code: 'UPSTREAM', dataState: 'not_written' } });
    expect(JSON.stringify(body)).not.toMatch(/foreign-|FOREIGN_|other-workspace|Cache immutable data/);
    expect(services.semanticQuery).not.toHaveBeenCalled();
    const preview = await app.request('/api/retrieval/answer/preview', { method: 'POST',
      body: JSON.stringify({ request: { ...request, task: { ...request.task, mode: 'assisted' } } }),
    });
    expect(preview.status).toBe(502); expect(services.complete).not.toHaveBeenCalled();
    expect(await preview.text()).not.toMatch(/foreign-|FOREIGN_|other-workspace|Cache immutable data/);
  });
  it.each(['source', 'target'] as const)('does not reintroduce a foreign %s endpoint through detail, graph filling or history', async (endpoint) => {
    const { app } = setup(endpoint);
    for (const path of ['/api/retrieval/nodes/n1', '/api/retrieval/graph/n1', `/api/retrieval/nodes/n1/history?revision=${revision}`]) {
      const response = await app.request(path);
      expect(response.status).toBe(502);
      const body = await response.json() as ApiResponse<unknown>;
      expect(body).toMatchObject({ ok: false, error: { code: 'UPSTREAM', dataState: 'not_written' } });
      expect(JSON.stringify(body)).not.toMatch(/foreign-|FOREIGN_|other-workspace|Cache immutable data/);
    }
  });
});
