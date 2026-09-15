import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { createServices } from '../../src/platform/services';
import { ApprovalAuthority } from '../../src/platform/approvals';
import type { ApiResponse } from '../../src/contracts/api';
import type { Approval, EvidenceRecord, KnowledgeNode, Relation, RetrievalResult, TaskContext } from '../../src/contracts/domain';
import { CONTRACT_VERSION } from '../../src/contracts/domain';
import type { ReviewQuestion } from '../../src/contracts/review-session';
import { platformFixture } from './platform-fixture';

type EvidencePreview = {
  operationId: string;
  baseRevision: string;
  record: EvidenceRecord;
  retention: 'until_deleted';
  persistence: 'not_saved';
  indexing: 'excluded';
};

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });

async function setup() {
  const base = await platformFixture();
  closers.push(() => base.journal.close());

  const first: KnowledgeNode = { ...base.node, id: 'k1', revision: base.base, title: '方案A', question: '方案A何时适用？',
    humanStatement: '允许短暂旧数据时可选方案A', evidenceStatus: 'supported' };
  const premise: KnowledgeNode = { ...base.node, id: 'k2', revision: base.base, title: '页面时效要求', question: '当前页面的前提',
    humanStatement: '当前页面允许短暂旧数据', conditions: [{ id: 'stale-allowed', text: '当前页面允许短暂旧数据', status: 'unknown', evidenceIds: [] }] };
  const edge: Relation = { id: 'requires-k2', workspaceId: base.ctx.workspaceId,
    source: { workspaceId: base.ctx.workspaceId, objectId: first.id, revision: base.base },
    target: { workspaceId: base.ctx.workspaceId, objectId: premise.id, revision: base.base }, type: 'depends_on',
    rationale: '方案A依赖页面时效要求', evidenceIds: ['s-k1'], state: 'confirmed', proposedBy: base.ctx.actorId,
    confirmedBy: base.ctx.actorId, confirmedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
  base.documents.set(base.base, { ...base.initial, nodes: [first, premise], relations: [edge] });

  const task: TaskContext = { id: 'g3-task', workspaceId: base.ctx.workspaceId, question: first.question, constraints: [], mode: 'assisted', updatedAt: '2026-09-12T00:00:00Z' };
  const question: ReviewQuestion = { id: 'g3-review-question', workspaceId: base.ctx.workspaceId, revision: 'g3-review:q1',
    nodeRef: { workspaceId: base.ctx.workspaceId, objectId: first.id, revision: base.base }, kind: 'recall', prompt: '什么前提必须先确认？',
    standardAnswer: '当前页面允许短暂旧数据。', hints: ['先找依赖条件。', '再检查页面时效。', '当前页面允许短暂旧数据。'],
    rubric: { version: 'g3-review:rubric-1', criteria: [{ id: 'condition', description: '说出关键前提。', expectedEvidence: '当前页面允许短暂旧数据。', required: true }], necessaryConditions: [] },
    review: { status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: task.updatedAt } };
  const services = createServices({ ...base.options, reviewQuestions: [question], reviewExposure: { initial: async () => 'unexposed' } });
  const app = createApp(services);
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => app.request(`http://localhost${path}`, {
    method, headers: base.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function ok<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await request(path, body, method);
    const result = await response.json() as ApiResponse<T>;
    expect(result.ok, `${method ?? 'GET'} ${path}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.meta.contractVersion).toBe(CONTRACT_VERSION);
    return result.data;
  }
  async function failed(path: string, body?: unknown, method?: string) {
    const response = await request(path, body, method);
    const result = await response.json() as ApiResponse<unknown>;
    expect(result.ok).toBe(false);
    return { response, result } as { response: Response; result: Exclude<ApiResponse<unknown>, { ok: true }> };
  }
  return { ...base, first, premise, edge, task, question, services, request, ok, failed };
}

describe('G3/G4 shared vertical composition (fixture evidence, not live CNB)', () => {
  it('keeps application evidence independent from review, then reruns the same task after a revision and blocks deleted context', async () => {
    const f = await setup();
    const savedTask = await f.ok<{ revision: number; contentHash: string }>('/api/workspace/tasks', { operationId: 'g3-task-save', task: f.task, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true });
    expect(savedTask).toMatchObject({ state: 'available', task: f.task });

    const before = await f.ok<RetrievalResult>('/api/retrieval/query', { task: f.task, query: f.task.question, confirmedOnly: true });
    const beforeNodes = [...before.groups.eligible, ...before.groups.conditional, ...before.groups.conflicts];
    expect(beforeNodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.first.id, humanStatement: f.first.humanStatement })]));
    expect(before.paths.some((path) => path.nodeIds.includes(f.premise.id))).toBe(true);
    expect(before.missingConditions.join(' ')).toContain('当前页面允许短暂旧数据');

    const usePreview = await f.ok<{ storage: EvidencePreview }>('/api/learning/use', { action: 'preview_retrieved', task: f.task,
      retrieval: before, nodeId: f.first.id, decision: 'adopt', reason: '只在页面允许短暂旧数据时采用方案A' });
    const useStorage = usePreview.storage;
    const useRequest = { operationId: useStorage.operationId, record: useStorage.record, baseRevision: useStorage.baseRevision,
      retention: 'until_deleted' as const, confirmed: true };
    const useApproval = await f.ok<Approval>('/api/workspace/approvals/evidence', useRequest);
    const savedUse = await f.ok<{ receipt: { recordId: string }; persistence: 'saved'; indexing: 'excluded' }>('/api/learning/use', { action: 'execute', request: useRequest, approval: useApproval });
    expect(savedUse).toMatchObject({ persistence: 'saved', indexing: 'excluded', receipt: { recordId: useStorage.record.id } });

    const outcomePreview = await f.ok<{ storage: EvidencePreview }>('/api/learning/outcomes', { action: 'preview', outcome: {
      useRecordId: useStorage.record.id, status: 'failed', summary: '新任务不再允许旧数据。', failureReason: '关键页面前提已变化',
    } });
    const outcomeStorage = outcomePreview.storage;
    const outcomeRequest = { operationId: outcomeStorage.operationId, record: outcomeStorage.record, baseRevision: outcomeStorage.baseRevision,
      retention: 'until_deleted' as const, confirmed: true };
    const outcomeApproval = await f.ok<Approval>('/api/workspace/approvals/evidence', outcomeRequest);
    await f.ok('/api/learning/outcomes', { action: 'execute', request: outcomeRequest, approval: outcomeApproval });
    const linked = await f.ok<{ records: { record: { id: string; kind: string; outcome?: { useRecordId: string } } }[] }>(`/api/learning/records?taskId=${f.task.id}&useId=${useStorage.record.id}&evidenceId=${outcomeStorage.record.id}`);
    expect(linked.records.map((entry) => entry.record.id)).toEqual(expect.arrayContaining([useStorage.record.id, outcomeStorage.record.id]));
    expect(linked.records.find((entry) => entry.record.kind === 'outcome')?.record.outcome?.useRecordId).toBe(useStorage.record.id);

    const catalog = await f.ok<{ questions: { id: string; prompt: string; standardAnswer?: string }[] }>(`/api/learning/reviews?nodeId=${f.first.id}&revision=${f.base}`);
    expect(catalog.questions).toHaveLength(1);
    expect(catalog.questions[0]).not.toHaveProperty('standardAnswer');
    const start = await f.ok<{ view: { phase: string; id: string; standardAnswer?: string }; receipt: { operationId: string } }>('/api/learning/attempts', {
      action: 'start', operationId: 'g3-review-start', taskId: f.task.id, questionId: f.question.id, questionRevision: f.question.revision,
      taskRevision: savedTask.revision, taskContentHash: savedTask.contentHash,
      nodeRef: f.question.nodeRef, retentionDays: 30, confirmed: true,
    });
    expect(start.view).toMatchObject({ id: 'g3-review-start', phase: 'confidence' });
    expect(start.view).not.toHaveProperty('standardAnswer');
    const confidence = await f.ok<{ view: { phase: string; version: number } }>('/api/learning/attempts', { action: 'event', operationId: 'g3-review-confidence',
      attemptId: start.view.id, expectedVersion: 0, event: { type: 'confidence', value: 'skipped' } });
    const began = await f.ok<{ view: { phase: string; version: number } }>('/api/learning/attempts', { action: 'event', operationId: 'g3-review-begin',
      attemptId: start.view.id, expectedVersion: confidence.view.version, event: { type: 'begin' } });
    const submitted = await f.ok<{ view: { phase: string; standardAnswer?: string; submission: { answer: string } | null } }>('/api/learning/attempts', {
      action: 'event', operationId: 'g3-review-submit', attemptId: start.view.id, expectedVersion: began.view.version,
      event: { type: 'submit', answer: '当前页面允许短暂旧数据。' },
    });
    expect(submitted.view).toMatchObject({ phase: 'submitted', standardAnswer: f.question.standardAnswer, submission: { answer: '当前页面允许短暂旧数据。' } });

    const revised = await f.ok<{ changes: Record<string, unknown> }>('/api/governance/nodes/k1', { action: 'preview', operationId: 'g4-revision', baseRevision: f.base,
      nodeRevision: f.base, reason: '结果显示旧数据前提已失效', patch: { humanStatement: '页面必须先完成更新后才能采用方案A' } }, 'PATCH');
    const prepared = await f.ok<{ changes: Record<string, unknown> }>('/api/governance/changes/prepare', { action: 'prepare', changes: revised.changes });
    const knowledgeApproval = await f.ok<Approval>('/api/workspace/approvals/knowledge', { changes: prepared.changes, confirmed: true });
    const committed = await f.ok<{ receipt: { revision: string; indexing: string } }>('/api/governance/changes/commit', { action: 'commit', changes: prepared.changes, approval: knowledgeApproval });
    expect(committed.receipt.revision).not.toBe(f.base);
    expect(committed.receipt.indexing).toBe('pending');

    const after = await f.ok<RetrievalResult>('/api/retrieval/query', { task: f.task, query: f.task.question, confirmedOnly: true });
    expect(after.snapshotRevision).toBe(committed.receipt.revision);
    expect([...after.groups.eligible, ...after.groups.conditional, ...after.groups.conflicts].find((node) => node.id === f.first.id)?.humanStatement)
      .toBe('页面必须先完成更新后才能采用方案A');
    expect(after.snapshotRevision).not.toBe(before.snapshotRevision);
    expect(await f.ok<{ record: EvidenceRecord }>(`/api/learning/records/${useStorage.record.id}`)).toMatchObject({ record: { id: useStorage.record.id, kind: 'use' } });

    const plan = await f.ok<{ plan: { id: string; objectIds: string[] } }>('/api/governance/delete/preview', { action: 'preview', objectIds: [f.first.id], baseRevision: after.snapshotRevision });
    const deleteApproval = await f.ok<Approval>('/api/workspace/approvals/governance', { purpose: 'delete', planId: plan.plan.id, confirmed: true });
    const deletion = await f.ok<{ report: { retrievalBlocked: boolean }; physicalDeletionComplete: boolean }>('/api/governance/delete/execute', { action: 'execute', plan: plan.plan, approval: deleteApproval });
    expect(deletion).toMatchObject({ report: { retrievalBlocked: true }, physicalDeletionComplete: false });
    const blocked = await f.ok<RetrievalResult>('/api/retrieval/query', { task: f.task, query: f.task.question, confirmedOnly: true });
    expect(blocked.groups.eligible).toEqual([]);
    expect(blocked.groups.conditional).toEqual([]);
    expect(blocked.groups.conflicts).toEqual([]);
    expect(blocked.groups.excludedIds).toContain(f.first.id);
    const recordBlocked = await f.failed(`/api/learning/records/${useStorage.record.id}`);
    expect(recordBlocked.result.error).toMatchObject({ code: 'FORBIDDEN', dataState: 'preserved' });
  });

  it('keeps an unknown review operation non-final and refuses to treat an absent receipt as a completed attempt', async () => {
    const f = await setup();
    const missing = await f.failed('/api/learning/attempts/missing-review-operation');
    expect(missing.response.status).toBe(409);
    expect(missing.result.error).toMatchObject({ code: 'UNKNOWN_RESULT', dataState: 'unknown', nextAction: 'read_review_operation' });
  });
});
