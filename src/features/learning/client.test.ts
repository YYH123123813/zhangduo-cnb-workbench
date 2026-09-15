import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfidenceFields } from './confidence-fields';
import { DecisionFields, Page, type LearningPageProps } from './client';
import { AttemptPanel } from './attempt-panel';
import { ReviewPanel } from './review-panel';
import { publicAttempt } from './attempt';
import { startFixture, submittedFixture } from './testing/attempt';
import { questionFixture } from './testing/question';
import { HistoricalKnowledgeDetails, HistoricalKnowledgePanel } from './historical-knowledge-panel';
import { snapshot, useInput } from './testing/fixtures';

describe('learning native control semantics (not a browser layout test)', () => {
  it('renders an unselected native radio group for application choices', () => {
    const html = renderToStaticMarkup(createElement(DecisionFields, { decision: '', onChange: () => {} }));
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('<legend>本次决定</legend>'); expect(html).not.toContain('checked');
  });
  it('renders four accessible confidence choices with explicit skip and locked state', () => {
    const html = renderToStaticMarkup(createElement(ConfidenceFields, { value: null, onChange: () => {} }));
    expect(html.match(/type="radio"/g)).toHaveLength(4); expect(html).toContain('跳过'); expect(html).not.toContain('checked');
    const locked = renderToStaticMarkup(createElement(ConfidenceFields, { value: 'skipped', disabled: true, onChange: () => {} }));
    expect(locked).toContain('<fieldset disabled="">'); expect(locked.match(/checked/g)).toHaveLength(1);
  });
  it('keeps a task exit available and safely escapes route identifiers', () => {
    const html = renderToStaticMarkup(createElement<LearningPageProps>(Page, { routeParams: { taskId: '<img src=x onerror=alert(1)>' } }));
    expect(html).toContain('不记录，返回任务'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('掌握率');
  });
  it('prefills a transient upstream task without rendering the retrieved answer or selecting an adoption', () => {
    const task = { ...useInput.task, sourceIssueNumber: 17, mode: 'independent' as const };
    const html = renderToStaticMarkup(createElement<LearningPageProps>(Page, {
      routeParams: { nodeId: 'node-1', revision: snapshot.revision },
      retrieved: { task, result: {
        queryId: 'query-1', snapshotRevision: snapshot.revision,
        groups: { eligible: [], conditional: snapshot.nodes, conflicts: [], excludedIds: [] },
        paths: [], answer: { text: 'PRIVATE GENERATED ANSWER', citations: [] },
        missingConditions: ['A local copy exists'], warnings: [], coverage: 'partial',
      } },
    }));
    expect(html).toContain(task.question);
    expect(html).toContain(task.constraints[0]!.text);
    expect(html).toContain('value="task-1"');
    expect(html).toMatch(/readonly=""/i);
    expect(html).not.toContain('PRIVATE GENERATED ANSWER');
    expect(html.match(/<input[^>]*name="use-decision"[^>]*>/g)?.join('')).not.toContain('checked');
  });
  it('explicitly stops an expired query handoff instead of rebinding manually entered text to the old query', () => {
    const html = renderToStaticMarkup(createElement<LearningPageProps>(Page, { routeParams: {
      taskId: 'task-1', nodeId: 'node-1', queryId: 'expired-query',
    } }));
    expect(html).toContain('原检索上下文已失效或未随页面恢复');
    expect(html).toContain('href="#retrieval?taskId=task-1"');
    expect(html).toMatch(/<textarea[^>]*readonly=""/i);
    expect(html).not.toContain(useInput.task.question);
  });
  it('renders no standard answer before submission, including in hidden markup', () => {
    const props = { busy: false, onAction: () => {}, returnHref: '#retrieval?taskId=task-1' };
    const before = renderToStaticMarkup(createElement(AttemptPanel, { ...props, view: publicAttempt(startFixture()) }));
    expect(before).not.toContain(questionFixture.standardAnswer);
    const after = renderToStaticMarkup(createElement(AttemptPanel, { ...props, view: publicAttempt(submittedFixture()) }));
    expect(after).toContain(questionFixture.standardAnswer); expect(after).toContain('本次无提示回忆');
  });
  it('offers a queue return only for settled attempts and disables it during unresolved operations', () => {
    const props = { busy: false, onAction: () => {}, onReturnToQueue: () => {}, returnHref: '#retrieval?taskId=task-1' };
    const initial = publicAttempt(startFixture());
    const submitted = publicAttempt(submittedFixture());
    const cancelled = { ...initial, phase: 'cancelled' as const };
    const render = (view: typeof initial, busy = false) => renderToStaticMarkup(createElement(AttemptPanel, { ...props, view, busy }));
    expect(render(initial)).not.toContain('返回回顾队列');
    for (const view of [submitted, cancelled]) {
      expect(render(view)).toContain('返回回顾队列');
      expect(render(view, true)).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?返回回顾队列<\/button>/);
    }
  });
  it('renders the original-task retention consent and recovery controls before any review attempt', () => {
    const html = renderToStaticMarkup(createElement(ReviewPanel, {
      actorId: 'actor-1', workspaceId: useInput.task.workspaceId, taskId: useInput.task.id, task: useInput.task,
      nodeRef: useInput.nodeRefs[0], title: 'A knowledge node',
    }));
    expect(html.match(/name="review-task-retention"/g)).toHaveLength(1);
    expect(html).toContain('确认上述原任务私有保存 30 天');
    expect(html).toContain('保存原任务');
    expect(html).toContain('读取原任务');
    expect(html).not.toContain(questionFixture.standardAnswer);
  });
  it('offers separate unchecked 24-hour recovery consent for task and each review event', () => {
    const html = renderToStaticMarkup(createElement(ReviewPanel, {
      actorId: 'actor-1', workspaceId: useInput.task.workspaceId, taskId: useInput.task.id, task: useInput.task,
      retainOperationRecovery: async () => { throw Error('No retention during render'); },
    }));
    expect(html).toContain('task-recovery-retention');
    expect(html).toContain('review-recovery-retention');
    expect(html).toContain('24 小时');
    expect(html).not.toContain('checked');
  });
  it('loads historical knowledge only on request and distinguishes it from saved task conditions', () => {
    const pending = renderToStaticMarkup(createElement(HistoricalKnowledgePanel, { recordId: 'record-1', nodeRef: useInput.nodeRefs[0]! }));
    expect(pending).toContain('查看原版本知识');
    expect(pending).not.toContain(snapshot.nodes[0]!.humanStatement);
    const html = renderToStaticMarkup(createElement(HistoricalKnowledgeDetails, { view: {
      recordId: 'record-1', nodeRef: useInput.nodeRefs[0]!, snapshotRevision: snapshot.revision,
      provenance: 'historical_knowledge', contextState: 'not_recorded', applicability: 'not_assessed', currentState: 'withdrawn',
      knowledge: { ...snapshot.nodes[0]!, title: '<script>unsafe title</script>' },
    } }));
    expect(html).toContain('当前已撤回');
    expect(html).toContain('当时的任务条件与路径未记录');
    expect(html).toContain(snapshot.nodes[0]!.humanStatement);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
