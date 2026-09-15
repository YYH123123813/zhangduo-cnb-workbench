import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Page, Workspace, SettingsFields } from './client';
import { editedNode, nextTab, retrievalLink } from './client-model';
import { ctx, node, snapshot } from './fixtures.test-support';
import { DataControls, GovernancePayloadControl, LayerTable } from './views';
import type { DataState } from './data-flow';

describe('governance UI semantics and draft state', () => {
  it('does not start an inspector for mixed original record and operation links', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', routeParams: { useId: 'use-1', approvalId: 'original-approval' } }));
    expect(html).toContain('入口不可混用'); expect(html).not.toContain('读取原操作');
    expect(html).toContain('<fieldset disabled="" aria-label="治理编辑区域">');
  });
  it('reads a governance draft through the shared payload endpoint without turning it into a new editable operation', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', routeParams: { draftId: 'original-draft' } }));
    expect(html).toContain('original-draft'); expect(html).toContain('治理原载荷恢复');
    expect(html).toContain('<fieldset disabled="" aria-label="治理编辑区域">');
  });
  it('keeps a linked original record pending without selecting the first unrelated knowledge node', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', routeParams: { useId: 'use-1', evidenceId: 'outcome-1', taskId: 'task-1' } }));
    expect(html).toContain('原使用与结果'); expect(html).toContain('use-1'); expect(html).toContain('outcome-1');
    expect(html).toContain('<fieldset disabled="" aria-label="治理编辑区域">'); expect(html).not.toContain('预览修订');
  });
  it('keeps deletion unknown layers visible and offers a next operation without claiming erasure', () => {
    const state = { stage: 'succeeded', prepared: { kind: 'delete', workspaceId: 'fixture', preview: { approvalStatus: 'required', plan: { id: 'original-plan', contentHash: 'original-hash' } } }, approval: { id: 'registered-approval' }, error: null,
      result: { kind: 'delete', value: { physicalDeletionComplete: false, retrievalBlocked: true, layers: [{ name: 'application', label: '应用检索阻断', state: 'done' }, { name: 'git_history', label: 'Git历史', state: 'unknown' }] } } } as DataState;
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(DataControls, { state, onApprove: noop, onCommit: noop, onVerify: noop, onRevoke: noop, onCancel: noop, onContinue: noop }));
    expect(html).toContain('继续处理下一项'); expect(html).toContain('original-plan'); expect(html).toContain('registered-approval');
    expect(html).toContain('物理清理尚未核验'); expect(html).toContain('未知'); expect(html).not.toContain('物理删除完成');
  });
  it('keeps the settings original-payload recovery control read-only and tied to one operation ID', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(GovernancePayloadControl, { kind: 'settings', operationId: 'settings-operation-1', state: 'unknown', onSave: noop, onRead: noop }));
    expect(html).toContain('settings-operation-1'); expect(html).not.toContain('保存原载荷（30天）'); expect(html).toContain('按同一操作ID读回');
    expect(html).toContain('不代表批准、提交、删除或公开');
  });
  it('does not offer a second save for a deterministic operation conflict', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(GovernancePayloadControl, { kind: 'change', operationId: 'conflicting-operation-1', state: 'conflict', onSave: noop, onRead: noop }));
    expect(html).toContain('原操作ID已绑定其他载荷'); expect(html).not.toContain('保存原载荷（30天）'); expect(html).toContain('按同一操作ID读回');
  });
  it('labels deletion capabilities independently of knowledge source support', () => {
    const html = renderToStaticMarkup(createElement(LayerTable, { layers: [{ name: 'application', capability: 'supported' }] }));
    expect(html).toContain('支持自动处理'); expect(html).not.toContain('有来源支持');
  });
  it('renders the module heading and honest initial connection state', () => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('版本演进与数据控制');
    expect(html).toContain('role="status"');
  });
  it('renders scoped tabs, labelled fields, long text and inert untrusted content', () => {
    const snap = snapshot({ nodes: [node('node-1', { title: 'LongTitle'.repeat(100), humanStatement: '<script>alert(1)</script>' })] });
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snap, actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture' }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('修改理由');
    expect(html).toContain('预览修订');
    expect(html).toContain('fixture');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('does not preselect an export or delete range', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', initialTab: 'data' }));
    expect(html).toContain('预览导出');
    expect(html).toContain('预览删除');
    expect(html).not.toContain('checked=""');
  });
  it('offers only current authorized relationship targets in a native labelled select', () => {
    const snap = snapshot({ nodes: [node(), node('node-2'), node('blocked-node', { title: 'Blocked target' }), node('draft-node', { title: 'Draft target', confirmation: 'draft', confirmedBy: undefined, confirmedAt: undefined })], excludedIds: ['blocked-node'] });
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snap, actorId: ctx.actorId, scopes: ctx.scopes }, mode: 'fixture', initialTab: 'relations' }));
    expect(html).toContain('关系目标'); expect(html).toContain('证据引用');
    expect(html).not.toContain('value="blocked-node"'); expect(html).not.toContain('value="draft-node"');
  });
  it('disables the complete demo fieldset without export permission', () => {
    const html = renderToStaticMarkup(createElement(Workspace, { status: { snapshot: snapshot(), actorId: ctx.actorId, scopes: ['knowledge:read'] }, mode: 'fixture', initialTab: 'data' }));
    expect(html).toContain('<fieldset class="gov-fields" aria-label="演示副本" disabled="">');
    expect(html).toContain('脱敏陈述');
  });
  it('renders all five independent settings as native checkboxes', () => {
    const html = renderToStaticMarkup(createElement(SettingsFields, { value: { aiExtraction: true, aiAnswer: false, aiReview: true, saveQueryHistory: false, reviewReminders: false }, onChange: () => {} }));
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });
  it('keeps edits local, downgrades unsupported new claims and supports tab-key navigation', () => {
    const original = node();
    const edited = editedNode(original, { humanStatement: 'Changed claim' });
    expect(edited.evidenceStatus).toBe('unverified');
    expect(original.humanStatement).not.toBe(edited.humanStatement);
    expect(nextTab('knowledge', 'ArrowLeft')).toBe('audit');
    expect(nextTab('knowledge', 'End')).toBe('audit');
    expect(nextTab('audit', 'Home')).toBe('knowledge');
    expect(retrievalLink('a & b', 'fixture-r1')).toBe('#retrieval?nodeId=a+%26+b&revision=fixture-r1');
  });
});
