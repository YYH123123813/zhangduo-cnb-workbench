import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../app/api-client';
import { CONTRACT_VERSION } from '../../contracts/domain';
import { lookupReceipt } from './receipt-lookup';
import { ReceiptLookup } from './ReceiptLookup';
import { ResultPanel } from './ResultPanel';

vi.mock('../../app/api-client', () => ({ apiRequest: vi.fn() }));
beforeEach(() => vi.mocked(apiRequest).mockReset());
const receipt = { changeSetId: 'operation-1', revision: 'fixture-commit-1', commitUrl: 'https://cnb.cool/fixture/commit', indexing: 'failed' as const };
const meta = { mode: 'fixture' as const, requestId: 'receipt-read', contractVersion: CONTRACT_VERSION };
describe('H11 receipt recovery without retained page preview', () => {
  it('needs only the saved operation ID and performs one read, not another commit', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, data: receipt, meta });
    expect(await lookupReceipt('conversation-1', 'operation-1')).toEqual({ ok: true, data: { receipt, mode: 'fixture' } });
    expect(vi.mocked(apiRequest).mock.calls).toEqual([['/api/handoff/conversation-1/receipt?changeSetId=operation-1']]);
  });
  it('does not read with empty IDs or treat missing, foreign or fabricated live receipts as success', async () => {
    expect((await lookupReceipt('', 'operation-1')).ok).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    for (const data of [null, { ...receipt, changeSetId: 'other' }]) {
      vi.mocked(apiRequest).mockResolvedValue({ ok: true, data, meta });
      expect(await lookupReceipt('conversation-1', 'operation-1')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    }
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, data: receipt, meta: { ...meta, mode: 'live' } });
    expect((await lookupReceipt('conversation-1', 'operation-1')).ok).toBe(false);
  });
  it('preserves permission errors without widening the request scope', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'denied', dataState: 'preserved', retryable: false, nextAction: 'request_access' }, meta });
    expect(await lookupReceipt('conversation-1', 'operation-1')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
  it('does not invent a node or source association from a bare receipt', () => {
    const html = renderToStaticMarkup(createElement(ResultPanel, { receipt, mode: 'fixture', titleId: 'receipt-lookup-result' }));
    expect(html).toContain('fixture-commit-1'); expect(html).toContain('索引失败');
    expect(html).not.toContain('#retrieval?nodeId='); expect(html).not.toContain('#capture?');
    expect(html).toContain('id="receipt-lookup-result"');
  });
  it('offers a named native operation input without automatically issuing a request', () => {
    const html = renderToStaticMarkup(createElement(ReceiptLookup, { conversationId: 'conversation-1', initialChangeSetId: 'operation-1' }));
    expect(html).toContain('for="handoff-receipt-operation"'); expect(html).toContain('value="operation-1"');
    expect(html).toContain('核验提交结果'); expect(apiRequest).not.toHaveBeenCalled();
  });
});
