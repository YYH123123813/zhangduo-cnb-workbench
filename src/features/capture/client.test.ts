import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Page, type PageProps } from './client';
import { CandidateList, deliveryMessage } from './record';
import { PrivacyEditor } from './privacy-editor';
import { handoffHref } from './delivery';
import { CandidateSchema } from '../../contracts/domain';
import { parseRoute } from '../../app/routing';
import { ScopeEditor } from './scope-editor';

describe('C12 semantic UI and conservative status', () => {
  it('has labelled native controls, defaults to archive, and accepts the shared routeParams prop', () => {
    const html = renderToStaticMarkup(createElement<PageProps>(Page, { routeParams: { conversationId: 'recover-id' } }));
    expect(html).toContain('对话捕获'); expect(html).toContain('只归档');
    expect(html).toContain('for="capture-question"'); expect(html).toContain('type="radio"');
    expect(html).not.toContain('已掌握'); expect(html).not.toContain('fixture-provider');
    expect(html).toContain('核对任务保存范围'); expect(html).toContain('读取原任务'); expect(html).toContain('for="capture-task-recovery-id"');
    expect(html).not.toContain('本次任务保存内容');
  });
  it('keeps unknown-source/empty-candidate states distinct and encodes links without content', () => {
    expect(renderToStaticMarkup(createElement(CandidateList, { candidates: [] }))).toContain('当前没有待审候选');
    expect(handoffHref('id&other=value')).toBe('#handoff?conversationId=id%26other%3Dvalue');
    expect(parseRoute(handoffHref('source-id', 'candidate-id'))).toEqual({ page: 'handoff', params: { conversationId: 'source-id', candidateId: 'candidate-id', source: 'candidate' } });
    expect(deliveryMessage.empty).toContain('本次提取已完成'); expect(deliveryMessage.missing).not.toContain('已完成');
    expect(new Set(Object.values(deliveryMessage)).size).toBe(6);
  });
  it('renders a long candidate and hostile-looking text as text, without fake confirmation', () => {
    const candidate = CandidateSchema.parse({ id: 'c', conversationId: 'conv', title: 'VeryLongUnbrokenTitle'.repeat(5), question: '问题', claim: '<img src=x onerror=alert(1)>', kind: 'claim', whyKeep: '理由', uncertainties: ['仍待核实'], spans: [{ id: 'span', conversationId: 'conv', segmentId: 's', start: 0, end: 1, quote: '原', contentHash: 'h' }], sources: [], modelId: 'fixture-provider', promptVersion: 'prompt-v1', generatedAt: '2026-09-05T04:00:00Z', state: 'proposed' });
    const html = renderToStaticMarkup(createElement(CandidateList, { candidates: [candidate] }));
    expect(html).toContain('待审'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).toContain('fixture-provider');
  });
  it('does not render complete detected credentials into the privacy comparison', () => {
    const secret = 'sk-fixture_abcdefghijklmnopqrstuvwxyz';
    const html = renderToStaticMarkup(createElement(PrivacyEditor, { segments: [{ id: 's', role: 'source', text: secret }], alreadySaved: true, intent: 'archive', onReady: () => undefined }));
    expect(html).not.toContain(secret); expect(html).toContain('来源原文已经保存在CNB'); expect(html).toContain('不发送模型');
  });
  it('provides native labelled manual masking controls with a bounded, initially empty password input', () => {
    const html = renderToStaticMarkup(createElement(PrivacyEditor, { segments: [{ id: 's', role: 'user', text: '需要核对的来源' }], alreadySaved: false, intent: 'archive', onReady: () => undefined }));
    expect(html).toContain('<summary>手动遮盖</summary>');
    expect(html).toContain('for="capture-mask-segment"'); expect(html).toContain('<select id="capture-mask-segment"');
    expect(html).toContain('for="capture-mask-text"'); expect(html).toMatch(/id="capture-mask-text"[^>]*type="password"[^>]*autoComplete="off"[^>]*maxLength="10000"[^>]*value=""/i);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?遮盖匹配内容/);
  });
  it('declares scoped wrapping and a single-column narrow-screen comparison', () => {
    const css = readFileSync(new URL('./capture.css', import.meta.url), 'utf8');
    expect(css).toContain('overflow-wrap: anywhere'); expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).not.toMatch(/(?:^|\n)(?:body|button|textarea|nav)\s*\{/);
  });
  it('offers explicit select-all and clear controls without preselecting any private segment', () => {
    const html = renderToStaticMarkup(createElement(ScopeEditor, { source: { id: 'fixture', origin: 'paste', createdAt: '2026-09-05T00:00:00Z', sourceAlreadyPersisted: false, segments: [{ id: 's', role: 'source', text: 'fixture' }] }, onChange: () => {} }));
    expect(html).toContain('全选片段'); expect(html).toContain('取消全部选择'); expect(html).toContain('已选 0 / 1 段'); expect(html).not.toContain('checked=""');
  });
});
