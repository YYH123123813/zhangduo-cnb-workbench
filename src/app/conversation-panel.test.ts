import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemoryChat } from '../contracts/intelligence';
import { ConversationHistory } from './conversation-panel';

const base: MemoryChat = { id: 'fixture-chat', title: 'Synthetic', revision: 1, status: 'ready', provider: 'cnb',
  createdAt: '2026-09-16T00:00:00Z', expiresAt: '2026-10-16T00:00:00Z', messages: [] };
describe('conversation history markup (not browser evidence)', () => {
  it('renders every message in order with roles, timestamps and the complete long text', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: `message-${index} ${'long-url-without-spaces'.repeat(index === 50 ? 500 : 1)}`, createdAt: base.createdAt }));
    const html = renderToStaticMarkup(createElement(ConversationHistory, { chat: { ...base, messages } }));
    expect(html.match(/<article/g)).toHaveLength(100);
    expect(html).toContain(messages[50]!.text);
    expect(html.indexOf('message-0 ')).toBeLessThan(html.indexOf('message-99 '));
    expect(html).toContain('aria-label="完整对话"'); expect(html).toContain('<time dateTime=');
  });
  it('treats model content as text, never HTML or executable links', () => {
    const html = renderToStaticMarkup(createElement(ConversationHistory, { chat: { ...base, messages: [
      { id: 'm1', role: 'assistant', text: '<script>alert(1)</script>\n[unsafe](javascript:alert(1))', createdAt: base.createdAt },
    ] } }));
    expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:'); expect(html).toContain('&lt;script&gt;');
  });
  it('shows an explicit empty history without inventing an assistant response', () => {
    const html = renderToStaticMarkup(createElement(ConversationHistory, { chat: base }));
    expect(html).toContain('此会话还没有消息'); expect(html).not.toContain('<article');
  });
});
