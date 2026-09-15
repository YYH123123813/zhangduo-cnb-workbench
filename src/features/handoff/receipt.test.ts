import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommitReceipt } from '../../contracts/domain';
import { validateReceipt } from './receipt';
import { ResultPanel } from './ResultPanel';
import { invalidateSubmission, isUncertainWrite, newSubmission, settleSubmission } from './submission';

const receipt: CommitReceipt = { changeSetId: 'operation-1', revision: 'fixture-commit-1', commitUrl: 'https://cnb.cool/fixture/private/-/commit/fixture-commit-1', indexing: 'failed' };
describe('H11 truthful commit result', () => {
  it('shows Git success separately from index failure with exact version links', () => {
    const html = renderToStaticMarkup(createElement(ResultPanel, { receipt, nodeId: 'node-1', conversationId: 'conversation-1', mode: 'fixture' }));
    expect(html).toContain('Git 已保存'); expect(html).toContain('索引失败'); expect(html).toContain('fixture-commit-1');
    expect(html).toContain('#retrieval?nodeId=node-1&amp;revision=fixture-commit-1');
    expect(html).toContain('Fixture');
  });
  it('rejects mismatched operations, unsafe links and fake live revisions', () => {
    expect(validateReceipt(receipt, 'other-operation', 'fixture').ok).toBe(false);
    expect(validateReceipt({ ...receipt, commitUrl: 'javascript:alert(1)' }, receipt.changeSetId, 'fixture').ok).toBe(false);
    expect(validateReceipt(receipt, receipt.changeSetId, 'live').ok).toBe(false);
    expect(validateReceipt(receipt, receipt.changeSetId, 'fixture').ok).toBe(true);
  });
  it('keeps uncertain submissions locked and never invents a receipt', () => {
    const result = settleSubmission({ ...newSubmission(), pending: true }, { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'unknown', retryable: false, dataState: 'unknown', nextAction: 'read_back' } });
    expect(result.receipt).toBeNull(); expect(result.pending).toBe(false); expect(result.unknown).toBe(true);
    expect(invalidateSubmission(result)).toBe(result);
  });
  it('treats partial outcomes and UNKNOWN_RESULT as uncertain even with inconsistent error metadata', () => {
    for (const fields of [{ dataState: 'partial' as const, code: 'UPSTREAM' as const },
      { dataState: 'preserved' as const, code: 'UNKNOWN_RESULT' as const }]) {
      expect(isUncertainWrite({ ...fields, message: 'uncertain', retryable: false, nextAction: 'read_back' })).toBe(true);
    }
    expect(isUncertainWrite({ code: 'FORBIDDEN', message: 'denied', retryable: false, dataState: 'not_written', nextAction: 'request_access' })).toBe(false);
  });
});
