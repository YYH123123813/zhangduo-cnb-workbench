import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { CONTRACT_VERSION, RelationSchema, SourceSpanSchema } from '../../src/contracts/domain';

describe('shared application composition', () => {
  it('serves a truthful unconfigured health envelope', async () => {
    const response = await createApp().request('/api/health');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.meta.mode).toBe('unconfigured');
    expect(body.data.cnbConnected).toBe(false);
  });

  for (const feature of ['capture', 'handoff', 'retrieval', 'learning', 'governance']) {
    it(`mounts ${feature} without pretending implementation success`, async () => {
      const response = await createApp().request(`/api/${feature}/status`);
      const body = await response.json();
      expect([501, 503]).toContain(response.status);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(response.status === 501 ? 'NOT_IMPLEMENTED' : 'NOT_CONFIGURED');
      expect(body.error.dataState).toBe('not_written');
      expect(body.meta.mode).toBe('unconfigured');
      expect(body.meta.contractVersion).toBe(CONTRACT_VERSION);
    });
  }

  it('returns a consistent envelope for unknown routes', async () => {
    const response = await createApp().request('/api/no-such-route');
    expect(response.status).toBe(404);
    expect((await response.json()).meta.contractVersion).toBe(CONTRACT_VERSION);
  });

  it('does not establish a trusted identity from arbitrary client headers', async () => {
    const result = await createServices().context(new Request('http://localhost/', { headers: { 'X-Workspace': 'private-other' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_CONFIGURED');
  });
});

describe('frozen domain guardrails', () => {
  const reference = { workspaceId: 'w1', objectId: 'k1', revision: 'fixture-r1' };
  const relation = { id: 'r1', workspaceId: 'w1', source: reference, target: { ...reference, objectId: 'k2' }, type: 'depends_on', rationale: 'K1 requires K2', evidenceIds: [], state: 'confirmed', proposedBy: 'u1', updatedAt: '2026-09-05T12:00:00+08:00' };
  it('rejects confirmed edges without evidence and a confirming actor', () => {
    expect(RelationSchema.safeParse(relation).success).toBe(false);
  });
  it('accepts explicitly confirmed, evidenced edges', () => {
    expect(RelationSchema.safeParse({ ...relation, evidenceIds: ['s1'], confirmedBy: 'u1', confirmedAt: '2026-09-05T12:00:00+08:00' }).success).toBe(true);
  });
  it('rejects cross-workspace edges', () => {
    expect(RelationSchema.safeParse({ ...relation, state: 'proposed', target: { ...reference, workspaceId: 'w2' } }).success).toBe(false);
  });
  it('rejects reversed source ranges', () => {
    expect(SourceSpanSchema.safeParse({ id: 's1', conversationId: 'c1', segmentId: 'm1', start: 5, end: 2, quote: 'x', contentHash: 'hash' }).success).toBe(false);
  });
});
