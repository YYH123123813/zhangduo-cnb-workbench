import { describe, expect, it } from 'vitest';
import type { RetrievalResult, TaskContext } from '../contracts/domain';
import type { WorkspaceSession } from '../contracts/session';
import { TransientRetrieval } from './transient-retrieval';

const session: WorkspaceSession = { actorId: 'u1', workspace: { id: 'w1', slug: 'fixture/app', visibility: 'private', mode: 'fixture' }, scopes: ['knowledge:read'] };
const task: TaskContext = { id: 't1', workspaceId: 'w1', question: 'PRIVATE SYNTHETIC TASK', constraints: [{ id: 'condition1', text: 'same condition', confirmedBy: 'u1' }], mode: 'assisted', sourceIssueNumber: 7, updatedAt: '2026-09-05T00:00:00Z' };
const result: RetrievalResult = { queryId: 'q1', snapshotRevision: 'a'.repeat(40), groups: { eligible: [], conditional: [], conflicts: [], excludedIds: [] }, paths: [], answer: null, missingConditions: [], warnings: ['Partial coverage'], coverage: 'partial' };
describe('W12 in-memory retrieval handoff, not a trusted stored receipt', () => {
  it('preserves task conditions and result provenance without serializing them into a URL or browser storage', () => {
    const store = new TransientRetrieval(); store.bind(session); expect(store.accept(task, result)).toBe(true);
    const first = store.forLearning({ taskId: 't1', queryId: 'q1' }); expect(first).toEqual({ task, result });
    first!.task.constraints[0]!.text = 'client changed copy'; expect(store.forLearning({})!.task).toEqual(task);
    expect(store.forLearning({ taskId: 'other' })).toBeUndefined(); expect(store.forLearning({ queryId: 'other' })).toBeUndefined();
    store.invalidate(); expect(store.forLearning({})).toBeUndefined(); expect(store.taskFor('t1')).toEqual(task);
  });
  it('drops all prior identity data on actor, workspace or permission changes and on reload', () => {
    const store = new TransientRetrieval(); store.bind(session); store.accept(task, result);
    store.bind({ ...session, actorId: 'u2' }); expect(store.forLearning({})).toBeUndefined(); expect(store.taskFor('t1')).toBeUndefined();
    store.bind(session); store.accept(task, result); store.bind({ ...session, scopes: [] }); expect(store.taskFor('t1')).toBeUndefined();
    store.bind(session); expect(store.accept({ ...task, workspaceId: 'w2' }, result)).toBe(false);
    store.accept(task, result); store.bind(null); expect(store.taskFor()).toBeUndefined();
    const reloaded = new TransientRetrieval(); reloaded.bind(session); expect(reloaded.forLearning({})).toBeUndefined();
  });
  it('expires transient content and never fabricates a missing task from route identifiers', () => {
    let now = 1; const store = new TransientRetrieval(() => now); store.bind(session); store.accept(task, result);
    expect(store.taskFor('missing')).toBeUndefined(); expect(store.forLearning({ nodeId: 'missing' })).toBeUndefined();
    now += 30 * 60_000 + 1; expect(store.forLearning({})).toBeUndefined(); expect(store.taskFor('t1')).toBeUndefined();
  });
});
