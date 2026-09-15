import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Page, type PageProps } from './client';
import { contentReads, latestRead, modelFailure, queryTask, sameTaskIdentity } from './client-state';
import { request } from './test-support';
import { AnswerPanel } from './answer-view';
import { emptyAnswerState } from './answer-client';

describe('R11 query UI contracts', () => {
  it('hands off the edited question and treats original-text retrieval as assisted exposure', () => {
    const parentTask = { ...request.task, question: 'Earlier question', sourceIssueNumber: 12 };
    const constraints = [{ id: 'c1', text: '  immutable input  ', confirmedBy: 'u1' }, { id: 'empty', text: ' ' }];
    const current = queryTask(parentTask, 'fallback-id', 'w1', '  Revised question  ', constraints, request.task.updatedAt);
    expect(current).toEqual({ ...parentTask, question: 'Revised question', mode: 'assisted', constraints: [
      { id: 'c1', text: 'immutable input', confirmedBy: 'u1' },
    ] });
    constraints[0]!.text = 'changed after search';
    expect(current.constraints[0]!.text).toBe('immutable input');
    expect(parentTask.question).toBe('Earlier question');
    expect(parentTask.mode).toBe('independent');
  });
  it('creates an assisted task without changing the trusted workspace or implying AI permission', () => {
    expect(queryTask(undefined, 'new-task', 'w1', 'cache', [], request.task.updatedAt)).toEqual({
      id: 'new-task', workspaceId: 'w1', question: 'cache', constraints: [], mode: 'assisted', updatedAt: request.task.updatedAt,
    });
    expect(queryTask({ ...request.task, workspaceId: 'w2' }, 'new-task', 'w1', 'cache', [], request.task.updatedAt).workspaceId).toBe('w2');
  });
  it('recognizes first-query parent feedback as the same task but resets for a different identity', () => {
    const sent = queryTask(undefined, 'local-task', 'w1', 'cache', [], request.task.updatedAt);
    const parent = structuredClone(sent);
    expect(sameTaskIdentity(sent, parent)).toBe(true);
    expect(sameTaskIdentity(sent, { ...parent, question: 'Parent feedback', updatedAt: '2026-09-05T08:00:00Z' })).toBe(true);
    expect(sameTaskIdentity(sent, { ...parent, id: 'another-task' })).toBe(false);
    expect(sameTaskIdentity(sent, { ...parent, workspaceId: 'another-workspace' })).toBe(false);
    expect(sameTaskIdentity({ id: 'local-task', workspaceId: undefined }, parent)).toBe(false);
  });
  it('uses labeled native controls, tabs, and no implicit AI consent', () => {
    const html = renderToStaticMarkup(createElement<PageProps>(Page, { task: { ...request.task, question: 'VeryLongQuestion'.repeat(80), constraints: [{ id: 'c1', text: 'Private condition', confirmedBy: 'u1' }] } }));
    expect(html).toContain('for="retrieval-question"'); expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="取消读取"'); expect(html).toContain('AI 回答未配置');
    expect(html).toContain('Private condition'); expect(html).not.toContain('localStorage');
  });
  it('discards late responses after cancellation or a newer request', () => {
    const reads = latestRead(); const first = reads.start(); const second = reads.start();
    expect(first.aborted).toBe(true); expect(reads.active(first)).toBe(false);
    expect(reads.active(second)).toBe(true); reads.cancel(); expect(reads.active(second)).toBe(false);
  });
  it('revokes every content reader when any pane loses access', () => {
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_CONFIGURED'] as const) {
      const reads = contentReads();
      const query = reads.query.start(); const detail = reads.detail.start(); const graph = reads.graph.start(); const answer = reads.answer.start();
      expect(reads.reject({ code, message: 'Access unavailable', nextAction: 'sign_in', dataState: 'not_written', retryable: false })).toBe(true);
      expect(reads.query.active(query)).toBe(false); expect(reads.detail.active(detail)).toBe(false); expect(reads.graph.active(graph)).toBe(false);
      expect([query, detail, graph, answer].every((signal) => signal.aborted)).toBe(true);
    }
  });
  it('keeps independent panes for transient failures and cancels the graph with the rest of the page', () => {
    const reads = contentReads(); const query = reads.query.start(); const graph = reads.graph.start();
    expect(reads.reject({ code: 'UPSTREAM', message: 'Temporary failure', nextAction: 'retry_read', dataState: 'not_written', retryable: true })).toBe(false);
    expect(reads.query.active(query)).toBe(true); expect(reads.graph.active(graph)).toBe(true);
    reads.cancel(); expect(reads.query.active(query)).toBe(false); expect(reads.graph.active(graph)).toBe(false);
  });
  it('keeps styles module-scoped with explicit narrow-screen and long-text constraints', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 320px)'); expect(css).toContain('minmax(0, 1fr)');
    expect(css).toContain('overflow-wrap: anywhere'); expect(css).toContain('letter-spacing: 0');
    expect(css).not.toMatch(/\dvw|letter-spacing:\s*-|:root|^body\s*\{/m);
  });
  it('renders an escaped exact model preview with unchecked consent and no implicit send button', () => {
    const state = { ...emptyAnswerState(), phase: 'preview' as const, preview: {
      input: { purpose: 'answer' as const, text: '<script>UNTRUSTED</script>\n' + 'LongInput'.repeat(500), sourceIds: ['s-n1'] },
      objectIds: ['n1'], baseRevision: 'a'.repeat(40), contentHash: 'b'.repeat(64),
    } };
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state, confirmed: false, onConfirm: () => {}, onPreview: () => {}, onApprove: () => {}, onSend: () => {}, onCancel: () => {} }));
    expect(html).toContain('for="retrieval-model-input"'); expect(html).toContain('readOnly=""');
    expect(html).toContain('&lt;script&gt;UNTRUSTED&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('checked');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?批准本次范围/);
    expect(html).not.toContain('生成回答'); expect(html).toContain('取消本次流程');
  });
  it('shows unknown operation status without offering send or preview as a recovery shortcut', () => {
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state: { ...emptyAnswerState(), phase: 'done', uncertain: true }, confirmed: false,
      onConfirm: () => {}, onPreview: () => {}, onApprove: () => {}, onSend: () => {}, onCancel: () => {} }));
    expect(html).toContain('原操作结果待核验'); expect(html).not.toContain('生成回答'); expect(html).not.toContain('重新预览范围');
  });
  it('shows the original operation metadata and a read-only recovery action after its approval was revoked', () => {
    const operation = { id: 'original-approval', actorId: 'u1', workspaceId: 'w1', purpose: 'model_input' as const, objectIds: ['n1'], contentHash: 'b'.repeat(64),
      baseRevision: 'a'.repeat(40), approvedAt: request.task.updatedAt, expiresAt: request.task.updatedAt };
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state: { ...emptyAnswerState(), phase: 'done', uncertain: true, operation }, confirmed: false,
      onConfirm: () => {}, onPreview: () => {}, onApprove: () => {}, onSend: () => {}, onCancel: () => {}, onInspect: () => {} }));
    expect(html).toContain('核验原操作'); expect(html).toContain(operation.id); expect(html).toContain(operation.baseRevision); expect(html).toContain(operation.contentHash);
    expect(html).not.toContain('生成回答'); expect(html).not.toContain('重新预览范围'); expect(html).not.toContain('retrieval-model-input');
  });
  it('does not offer a new preview for an invalidated previous query scope', () => {
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state: { ...emptyAnswerState(), phase: 'idle', invalidated: true }, confirmed: false,
      onConfirm: () => {}, onPreview: () => {}, onApprove: () => {}, onSend: () => {}, onCancel: () => {} }));
    expect(html).toContain('范围已失效'); expect(html).not.toContain('重新预览范围'); expect(html).not.toContain('生成回答');
  });
  it('provides a separate read-only registration recovery action without restoring the private preview', () => {
    const registration = { operationId: 'original-registration', requestHash: 'r'.repeat(64), contentHash: 'h'.repeat(64), baseRevision: 'a'.repeat(40), objectIds: ['n1'] };
    const html = renderToStaticMarkup(createElement(AnswerPanel, { state: { ...emptyAnswerState(), phase: 'done', uncertain: true, invalidated: true,
      registration, registrationStatus: 'not_registered' }, confirmed: false, onConfirm: () => {}, onPreview: () => {}, onApprove: () => {}, onSend: () => {}, onCancel: () => {}, onInspectRegistration: () => {} }));
    expect(html).toContain('核验原批准登记'); expect(html).toContain(registration.operationId); expect(html).toContain(registration.requestHash);
    expect(html).toContain('尚未查到'); expect(html).not.toContain('生成回答'); expect(html).not.toContain('retrieval-model-input');
    expect(html).not.toContain('尚无可核验的原操作 ID');
  });
  it('rechecks knowledge after a model-policy failure instead of assuming knowledge access was lost', async () => {
    const recheck = vi.fn(async () => {}); const readFailure = vi.fn();
    for (const code of ['FORBIDDEN', 'NOT_CONFIGURED'] as const) {
      await modelFailure({ code, message: 'Model unavailable', retryable: false, dataState: 'not_written', nextAction: 'keep_originals' }, recheck, readFailure);
    }
    expect(recheck).toHaveBeenCalledTimes(2); expect(readFailure).not.toHaveBeenCalled();
    for (const code of ['UNAUTHORIZED', 'CONFLICT', 'UNKNOWN_RESULT'] as const) {
      await modelFailure({ code, message: 'Read state needs handling', retryable: false, dataState: 'unknown', nextAction: 'review' }, recheck, readFailure);
    }
    expect(recheck).toHaveBeenCalledTimes(2); expect(readFailure).toHaveBeenCalledTimes(3);
  });
});
