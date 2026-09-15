import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceSavePanel } from './evidence-save-panel';
import { EvidenceRecordDetails } from './evidence-details';
import { EvidenceSaveFlow } from './evidence-save-flow';
import { buildUseDraft } from './history';
import { buildOutcomeEvidence, buildUseEvidence } from './application-record';
import { context, snapshot, useInput } from './testing/fixtures';
import { HistoricalKnowledgeDetails } from './historical-knowledge-panel';
import type { HistoricalKnowledgeView } from './history-reader';

const fixed = { ...snapshot, revision: 'a'.repeat(40), nodes: snapshot.nodes.map((node) => ({ ...node, revision: 'a'.repeat(40) })) };
function record() {
  const draft = buildUseDraft({ ...useInput, snapshotRevision: fixed.revision, nodeRefs: [{ ...useInput.nodeRefs[0]!, revision: fixed.revision }] }, fixed, 'use-1', useInput.task.updatedAt);
  if (!draft.ok) throw new Error(draft.error.message);
  const saved = buildUseEvidence(draft.data, fixed); if (!saved.ok) throw new Error(saved.error.message); return saved.data;
}

describe('structured application UI semantics (SSR, not browser acceptance)', () => {
  it('requires an unchecked long-term retention choice and keeps approval separate from saving', () => {
    const transport = vi.fn(), flow = new EvidenceSaveFlow({ operationId: 'operation-1', actorId: context.actorId, record: record(), baseRevision: fixed.revision,
      retention: 'until_deleted', persistence: 'not_saved', indexing: 'excluded' }, transport);
    const html = renderToStaticMarkup(createElement(EvidenceSavePanel, { flow }));
    expect(html).toContain('私有保存直到删除'); expect(html).toContain('登记保存批准');
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked');
    expect(html).toContain('operation-1'); expect(html).not.toContain('已保存到');
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps evidence recovery retention separate from saving the full use record', () => {
    const transport = vi.fn(), flow = new EvidenceSaveFlow({ operationId: 'operation-1', actorId: context.actorId, record: record(), baseRevision: fixed.revision,
      retention: 'until_deleted', persistence: 'not_saved', indexing: 'excluded' }, transport);
    const html = renderToStaticMarkup(createElement(EvidenceSavePanel, { flow, retainOperationRecovery: vi.fn() }));
    expect(html).toContain('evidence-recovery-retention');
    expect(html).toContain('24 小时'); expect(html).not.toContain('checked');
    expect(transport).not.toHaveBeenCalled();
  });

  it('withholds the old preview when only the receipt remains readable', () => {
    const value = record(), transport = vi.fn();
    const flow = new EvidenceSaveFlow({ operationId: 'operation-1', actorId: context.actorId, record: value, baseRevision: fixed.revision,
      retention: 'until_deleted', persistence: 'not_saved', indexing: 'excluded' }, transport);
    vi.spyOn(flow, 'getSnapshot').mockReturnValue({ ...flow.state, phase: 'saved_receipt_only', receipt: {
      operationId: 'operation-1', approvalId: 'approval-1', recordId: value.id, workspaceId: value.workspaceId,
      actorId: context.actorId, contentHash: 'a'.repeat(64), baseRevision: fixed.revision,
      recordedAt: value.recordedAt, storedAt: value.recordedAt, retention: 'until_deleted', outcome: 'saved',
    } });
    const html = renderToStaticMarkup(createElement(EvidenceSavePanel, { flow }));
    expect(html).toContain('原保存回执已核验'); expect(html).toContain('operation-1');
    expect(html).not.toContain(value.useContext!.task.question);
    expect(html).not.toContain(value.useContext!.knowledge[0]!.humanStatement);
    expect(html).not.toContain('learning-evidence-details');
    expect(transport).not.toHaveBeenCalled();
  });

  it('renders saved original task, conditions, coverage, reason and exact version independently of current knowledge', () => {
    const value = record();
    const html = renderToStaticMarkup(createElement(EvidenceRecordDetails, { record: value }));
    expect(html).toContain(value.useContext!.task.question); expect(html).toContain(value.useContext!.reason);
    expect(html).toContain('语义覆盖不可用'); expect(html).toContain(fixed.revision);
    expect(html).toContain('A local copy exists'); expect(html).toContain('Not suitable for live updates');
    expect(html).not.toContain('历史条件未记录'); expect(html).toContain('人的使用情境');
  });

  it('labels an outcome as a self-report with an original-use link, never as near transfer', () => {
    const original = record(), outcome = buildOutcomeEvidence({ useRecordId: original.id, status: 'failed', summary: 'Task failed', failureReason: 'Missing premise' }, original, context, 'outcome-1', '2026-09-05T01:00:00Z');
    if (!outcome.ok) throw new Error(outcome.error.message);
    const html = renderToStaticMarkup(createElement(EvidenceRecordDetails, { record: outcome.data }));
    expect(html).toContain('实际结果'); expect(html).toContain('用户自报'); expect(html).toContain('Missing premise');
    expect(html).toContain('useId=use-1'); expect(html).not.toContain('近迁移');
    expect(html).toContain('#governance?'); expect(html).toContain('evidenceId=outcome-1'); expect(html).toContain('taskId=task-1');
  });

  it('leaves missing legacy context explicitly unrecorded', () => {
    const legacy = record(); delete legacy.useContext;
    const html = renderToStaticMarkup(createElement(EvidenceRecordDetails, { record: legacy }));
    expect(html).toContain('历史条件未记录'); expect(html).not.toContain(useInput.task.question);
  });
  it('does not call saved structured task context missing in the original Git knowledge view', () => {
    const view: HistoricalKnowledgeView = { recordId: 'use-1', nodeRef: { ...useInput.nodeRefs[0]!, revision: fixed.revision }, snapshotRevision: fixed.revision,
      provenance: 'historical_knowledge', contextState: 'recorded', applicability: 'not_assessed', currentState: 'current', knowledge: fixed.nodes[0]! };
    const html = renderToStaticMarkup(createElement(HistoricalKnowledgeDetails, { view }));
    expect(html).not.toContain('任务条件与路径未记录'); expect(html).toContain('原使用记录');
  });
});
