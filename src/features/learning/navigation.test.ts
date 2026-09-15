import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PageOutlet } from '../../app/App';
import { HashNavigation, parseRoute } from '../../app/routing';
import { TransientRetrieval } from '../../app/transient-retrieval';
import type { RetrievalResult } from '../../contracts/domain';
import type { WorkspaceSession } from '../../contracts/session';
import { AttemptRequestGate } from './attempt-request';
import { publicAttempt } from './attempt';
import { Page, type LearningPageProps } from './client';
import { LearningLeaveGroup } from './leave-guard';
import { startFixture } from './testing/attempt';
import { context, snapshot, task, useInput } from './testing/fixtures';

const session: WorkspaceSession = { actorId: context.actorId, scopes: [...context.scopes],
  workspace: { id: context.workspaceId, slug: 'synthetic-learning', visibility: 'private', mode: 'fixture' },
};
const retrieval: RetrievalResult = { queryId: 'query-1', snapshotRevision: snapshot.revision,
  groups: { eligible: [], conditional: snapshot.nodes, conflicts: [], excludedIds: [] },
  paths: [{ seedId: 'node-1', nodeIds: ['node-1'], relationIds: [], reason: 'Synthetic Git match' }],
  missingConditions: ['A local copy exists'], warnings: ['Semantic retrieval unavailable'], coverage: 'unavailable',
  answer: { text: 'PRIVATE GENERATED ANSWER', citations: [] },
};

describe('W12 shared routing composition (fixture, not browser acceptance)', () => {
  it('injects the actual learning page props without rebuilding the task or changing fallback coverage', () => {
    const exchange = new TransientRetrieval(); exchange.bind(session);
    expect(exchange.accept(task, retrieval)).toBe(true);
    const registerLeaveGuard = vi.fn(() => () => {});
    const element = PageOutlet({ route: parseRoute('#learning?taskId=task-1&nodeId=node-1&queryId=query-1'), exchange,
      registerLeaveGuard, onResult: () => {}, onInvalidateResult: () => {},
    });
    expect(element?.type).toBe(Page);
    expect(element?.props.registerLeaveGuard).toBe(registerLeaveGuard);
    expect(element?.props.retrieved).toEqual({ task, result: retrieval });
    const html = renderToStaticMarkup(element!);
    expect(html).toContain(task.question); expect(html).toContain(task.constraints[0]!.text);
    expect(html).not.toContain(retrieval.answer!.text);
    expect(html).toContain('未保存');
    expect(registerLeaveGuard).not.toHaveBeenCalled(); // SSR cannot attest effect registration.
  });

  it('asks before discarding learning drafts for both same-page parameters and task exit', () => {
    const host = { write: vi.fn(), confirmDiscard: vi.fn(() => false) };
    const router = new HashNavigation('#learning?taskId=task-1', host);
    const group = new LearningLeaveGroup(); let draft = 'unsubmitted outcome';
    group.register({ owner: 'learning', getState: () => draft ? 'dirty' : 'clean' });
    router.registerLeaveGuard({ owner: 'learning', getState: group.getState, onBlocked: group.onBlocked });
    expect(router.navigate('#learning?taskId=task-2')).toBe(false);
    expect(router.navigate('#retrieval?taskId=task-1')).toBe(false);
    expect(host.confirmDiscard).toHaveBeenCalledTimes(2); expect(host.write).not.toHaveBeenCalled();
    expect(router.shouldWarnBeforeUnload()).toBe(true);
    draft = ''; expect(router.navigate('#retrieval?taskId=task-1')).toBe(true);
  });

  it('blocks navigation and changed-history hashes until the original attempt is read back', () => {
    const host = { write: vi.fn(), confirmDiscard: vi.fn(() => true) };
    const router = new HashNavigation('#learning?taskId=task-1', host);
    const group = new LearningLeaveGroup(); const gate = new AttemptRequestGate(); const notice = vi.fn();
    group.register({ owner: 'learning', getState: () => gate.blocked ? 'blocked' : 'dirty', onBlocked: notice });
    router.registerLeaveGuard({ owner: 'learning', getState: group.getState, onBlocked: group.onBlocked });
    expect(gate.begin({ action: 'start', operationId: 'attempt-1', taskId: task.id,
      taskRevision: 1, taskContentHash: 'a'.repeat(64),
      questionId: 'question-1', questionRevision: 'fixture:q1', nodeRef: useInput.nodeRefs[0]!,
    }).ok).toBe(true);
    expect(router.navigate('#retrieval?taskId=task-1')).toBe(false);
    gate.interrupt(); expect(gate.recoveryId).toBe('attempt-1');
    expect(router.navigate('#learning?taskId=task-2', true)).toBe(false);
    expect(host.write).toHaveBeenLastCalledWith('#learning?taskId=task-1', true);
    expect(host.confirmDiscard).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledTimes(2);
    expect(router.shouldWarnBeforeUnload()).toBe(true);
    const readBack = gate.beginReadBack(); if (!readBack.ok) throw new Error('Expected original read-back');
    expect(gate.accept(readBack.data, { view: publicAttempt(startFixture()), feedback: null }).ok).toBe(true);
    expect(router.navigate('#retrieval?taskId=task-1')).toBe(true);
    expect(host.confirmDiscard).toHaveBeenCalledTimes(1);
  });

  it('does not reconstruct private upstream text after expiry, identity changes or reload', () => {
    let now = 0; const exchange = new TransientRetrieval(() => now); exchange.bind(session);
    const route = parseRoute('#learning?taskId=task-1&nodeId=node-1&queryId=query-1');
    for (const invalidate of [() => { now += 30 * 60_000; },
      () => exchange.bind({ ...session, actorId: 'another-actor' }), () => exchange.invalidate()]) {
      exchange.bind(session); expect(exchange.accept(task, retrieval)).toBe(true); invalidate();
      const element = PageOutlet({ route, exchange, onResult: () => {}, onInvalidateResult: () => {} });
      expect(element?.props.retrieved).toBeUndefined();
      expect(renderToStaticMarkup(element!)).not.toContain(task.question);
    }
    expect(renderToStaticMarkup(createElement<LearningPageProps>(Page, { routeParams: route.params }))).not.toContain(task.question);
  });
});
