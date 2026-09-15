import { describe, expect, it, vi } from 'vitest';
import { ctx, fixture, now, ok } from './fixtures.test-support';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuditLog, filterAuditEntries } from './audit-view';

describe('G12 minimal activity audit', () => {
  it('preserves the verified platform vocabulary for models, drafts and candidates', async () => {
    const entries = ['model_extract', 'model_answer', 'model_review'].map((action) => ({ action, outcome: 'discarded', objectIds: ['k1'], occurredAt: now }));
    entries.push({ action: 'candidates_saved', outcome: 'private_temporary_not_indexed', objectIds: ['c1'], occurredAt: now }, { action: 'draft_saved', outcome: 'private_not_indexed', objectIds: ['d1'], occurredAt: now });
    const { app } = fixture({ audit: vi.fn(async () => ok(entries)) });
    expect((await (await app.request('/api/governance/audit')).json()).data.entries).toEqual(entries);
  });
  it('filters by exact action, object ID and outcome without inventing operation links', () => {
    const entries = [{ action: 'settings_saved', outcome: 'done', objectIds: ['w1'], occurredAt: now }, { action: 'model_answer', outcome: 'discarded', objectIds: ['k1'], occurredAt: now }];
    expect(filterAuditEntries(entries, { action: '', objectId: 'k1', outcome: 'discarded' })).toEqual([entries[1]]);
    expect(filterAuditEntries(entries, { action: 'settings_saved', objectId: '', outcome: 'discarded' })).toEqual([]);
    const html = renderToStaticMarkup(createElement(AuditLog, { entries }));
    expect(html).toContain('动作筛选'); expect(html).toContain('对象ID筛选'); expect(html).toContain('结果筛选');
    expect(html).toContain('AI回答'); expect(html).toContain('输出已丢弃'); expect(html).not.toContain('href=');
  });
  it('shows failed and cancelled actions without claiming tamperproof guarantees', async () => {
    const { app } = fixture({ audit: vi.fn(async () => ok([{ action: 'delete', objectIds: ['node-1'], occurredAt: now, outcome: 'failed' }, { action: 'export', objectIds: ['node-2'], occurredAt: now, outcome: 'cancelled' }])) });
    const data = (await (await app.request('/api/governance/audit')).json()).data;
    expect(data.entries.map((entry: { outcome: string }) => entry.outcome)).toEqual(['failed', 'cancelled']);
    expect(data.tamperProof).toBe(false);
    expect(data.entries[0].objectIds).toEqual(['node-1']);
  });
  it('suppresses unstructured actions, secret-like IDs and extra private fields', async () => {
    const { app } = fixture({ audit: vi.fn(async () => ok([{ action: 'PRIVATE BODY Authorization: secret', objectIds: ['node-1', 'sk-secret-value', 'private text'], occurredAt: now, outcome: 'PRIVATE BODY', conversation: 'PRIVATE BODY', token: 'SECRET_TOKEN' }])) });
    const response = await app.request('/api/governance/audit');
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of ['PRIVATE BODY', 'SECRET_TOKEN', 'sk-secret-value', 'private text']) expect(text).not.toContain(secret);
    expect(JSON.parse(text).data.entries[0].action).toBe('unknown');
  });

  it('drops a secret-like original operation ID instead of rendering a misleading readback link', async () => {
    const { app } = fixture({ audit: vi.fn(async () => ok([{ action: 'settings_saved', objectIds: ['workspace-1'], occurredAt: now, outcome: 'saved', operation: { kind: 'settings' as const, id: 'sk-secret-operation' } }])) });
    const response = await app.request('/api/governance/audit');
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.entries[0]).not.toHaveProperty('operation');
    const html = renderToStaticMarkup(createElement(AuditLog, { entries: data.entries }));
    expect(html).toContain('未提供可信原操作关联');
    expect(html).not.toContain('sk-secret-operation');
  });
  it('sanitizes port error text and exception stacks', async () => {
    for (const audit of [vi.fn(async () => { throw new Error('Authorization: Bearer SECRET_TOKEN'); }), vi.fn(async () => ({ ok: false as const, error: { code: 'UPSTREAM' as const, message: 'PRIVATE BODY SECRET_TOKEN', retryable: true, dataState: 'not_written' as const, nextAction: 'PRIVATE BODY' } }))]) {
      const { app } = fixture({ audit });
      const response = await app.request('/api/governance/audit');
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toMatch(/SECRET_TOKEN|PRIVATE BODY|Bearer/);
    }
  });
  it('does not load records without audit permission', async () => {
    const { app, services } = fixture({ context: vi.fn(async () => ok({ ...ctx, scopes: [] })) });
    expect((await app.request('/api/governance/audit')).status).toBe(403);
    expect(services.audit).not.toHaveBeenCalled();
  });

  it('preserves each trusted original operation association without replacing it with object IDs', async () => {
    const entries = [
      { action: 'knowledge.commit', objectIds: ['node-1'], occurredAt: now, outcome: 'done', operation: { kind: 'knowledge' as const, id: 'change-set-1' } },
      { action: 'settings_saved', objectIds: ['workspace-1'], occurredAt: now, outcome: 'saved', operation: { kind: 'settings' as const, id: 'approval-1' } },
      { action: 'delete.execute', objectIds: ['node-1'], occurredAt: now, outcome: 'physical_cleanup_unverified', operation: { kind: 'delete' as const, id: 'plan-1' } },
      { action: 'evidence_saved', objectIds: ['use-1'], occurredAt: now, outcome: 'saved', operation: { kind: 'evidence' as const, id: 'evidence-save-1' } },
    ];
    const { app } = fixture({ audit: vi.fn(async () => ok(entries)) });
    const data = (await (await app.request('/api/governance/audit')).json()).data;
    expect(data.entries.map((entry: { operation?: unknown }) => entry.operation)).toEqual(entries.map((entry) => entry.operation));
    expect(data.entries[0].objectIds).toEqual(['node-1']);
    expect(data.entries[1].operation.id).not.toBe(data.entries[1].objectIds[0]);
  });

  it('offers read-only evidence inspection for the actual private_not_indexed save outcome', () => {
    const entries = [{ action: 'evidence_saved', objectIds: ['use-1'], occurredAt: now, outcome: 'private_not_indexed', operation: { kind: 'evidence' as const, id: 'original-save' } }];
    const html = renderToStaticMarkup(createElement(AuditLog, { entries, onInspectOperation: () => {} }));
    expect(html).toContain('gov-link-button'); expect(html).toContain('original-save');
    expect(html).toContain('私有保存，未索引'); expect(html).not.toContain('未视为成功');
  });

  it('shows read-only links for confirmed associations, keeps evidence operation IDs explicit, and never links unknown results as success', () => {
    const entries = [
      { action: 'knowledge.commit', objectIds: ['node-1'], occurredAt: now, outcome: 'done', operation: { kind: 'knowledge' as const, id: 'change-set-1' } },
      { action: 'settings_saved', objectIds: ['workspace-1'], occurredAt: now, outcome: 'saved', operation: { kind: 'settings' as const, id: 'approval-1' } },
      { action: 'delete.execute', objectIds: ['node-1'], occurredAt: now, outcome: 'physical_cleanup_unverified', operation: { kind: 'delete' as const, id: 'plan-1' } },
      { action: 'evidence_saved', objectIds: ['use-1'], occurredAt: now, outcome: 'saved', operation: { kind: 'evidence' as const, id: 'evidence-save-1' } },
      { action: 'knowledge.commit', objectIds: ['node-2'], occurredAt: now, outcome: 'unknown', operation: { kind: 'knowledge' as const, id: 'unknown-change' } },
    ];
    const html = renderToStaticMarkup(createElement(AuditLog, { entries }));
    expect(html).toContain('#governance?changeSetId=change-set-1');
    expect(html).toContain('#governance?approvalId=approval-1');
    expect(html).toContain('#governance?planId=plan-1');
    expect(html).toContain('原保存操作');
    expect(html).toContain('evidence-save-1');
    expect(html).toContain('结果未知，未视为成功');
    expect(html).not.toContain('changeSetId=unknown-change');
  });
});
