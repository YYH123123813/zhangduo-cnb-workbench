import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseRoute, HashNavigation } from '../../app/routing';
import { historyNotices } from './history';
import { originalHistoryReady, originalRecordLink, OriginalHistoryResult } from './history-origin';
import { snapshot, structuredUse } from './fixtures.test-support';
import { governanceGuard } from './navigation';

describe('governance original record links through shared navigation', () => {
  it('preserves only exact IDs and original revision when moving to revision or back to learning', () => {
    const use = structuredUse(); const ref = use.nodeRefs[0]!;
    const revision = parseRoute(originalRecordLink(use, ref));
    expect(revision).toEqual({ page: 'governance', params: { taskId: use.taskId, evidenceId: use.id, useId: use.id, nodeId: ref.objectId, revision: ref.revision } });
    expect(parseRoute(originalRecordLink(use))).toEqual({ page: 'learning', params: { taskId: use.taskId, evidenceId: use.id, useId: use.id } });
    expect(originalRecordLink(use, ref)).not.toContain(use.answer);
    const navigation = new HashNavigation(originalRecordLink(use, ref), { write: () => {}, confirmDiscard: () => true });
    navigation.registerLeaveGuard(governanceGuard(() => ({ dirty: false, operations: [{ stage: 'unknown', approval: null }] }), () => {}));
    expect(navigation.navigate(originalRecordLink(use))).toBe(false);
  });
  it('does not enable linked edits for missing, deleted, mismatched task, ID or original revision', () => {
    const use = structuredUse(); const data = { ...historyNotices(snapshot(), [use]), historyReadLimitReached: false };
    const selection = { useId: use.id, evidenceId: use.id, taskId: use.taskId, nodeId: use.nodeRefs[0]!.objectId };
    expect(originalHistoryReady(data, selection, use.nodeRefs[0]!.revision)).toBe(true);
    expect(originalHistoryReady(data, { ...selection, taskId: 'other-task' })).toBe(false);
    expect(originalHistoryReady(data, { ...selection, useId: 'other-use' })).toBe(false);
    expect(originalHistoryReady(data, selection, 'b'.repeat(40))).toBe(false);
    expect(originalHistoryReady({ ...data, entries: [] }, selection)).toBe(false);
    const restricted = { ...historyNotices(snapshot({ excludedIds: ['node-1'] }), [use]), historyReadLimitReached: false };
    expect(originalHistoryReady(restricted, selection)).toBe(false);
    const html = renderToStaticMarkup(createElement(OriginalHistoryResult, { data: restricted }));
    expect(html).not.toContain('href='); expect(html).not.toContain(use.answer);
  });
  it('renders original explanations alongside explicit revision and return commands', () => {
    const use = structuredUse(), data = { ...historyNotices(snapshot(), [use]), historyReadLimitReached: false };
    const html = renderToStaticMarkup(createElement(OriginalHistoryResult, { data }));
    expect(html).toContain(use.answer); expect(html).toContain('修订引用知识'); expect(html).toContain('返回原使用记录');
    expect(html).toContain('#governance?'); expect(html).toContain('#learning?');
  });
});
