import { describe, expect, it } from 'vitest';
import { frameTask, initialTaskDraft } from './task';
import type { RequestContext } from '../../contracts/api';

const context: RequestContext = { requestId: 'req', actorId: 'actor', workspaceId: 'workspace', mode: 'fixture', scopes: [] };
const now = '2026-09-05T04:00:00.000Z';

describe('C01 task framing', () => {
  it('frames one question with optional constraints and stable IDs', () => {
    const draft = { ...initialTaskDraft('task-1'), question: '为什么请求重复？', constraints: [{ id: 'limit-1', text: '不增加依赖' }] };
    expect(frameTask(draft, context, now)).toEqual({ ok: true, data: { id: 'task-1', workspaceId: 'workspace', question: draft.question, constraints: draft.constraints, mode: 'independent', updatedAt: now } });
  });
  it('keeps an empty question as a local draft without fabricating a task', () => {
    expect(frameTask(initialTaskDraft('task-1'), context, now)).toEqual({ ok: true, data: null });
    expect(initialTaskDraft('task-1').intent).toBe('archive');
  });
  it('rejects extra identity fields and too many constraints', () => {
    expect(frameTask({ ...initialTaskDraft('t'), workspaceId: 'other' }, context, now).ok).toBe(false);
    expect(frameTask({ ...initialTaskDraft('t'), constraints: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, text: 'x' })) }, context, now).ok).toBe(false);
  });
  it('rejects an unconfigured identity without network or persistence', () => {
    expect(frameTask({ ...initialTaskDraft('t'), question: 'Q' }, { ...context, mode: 'unconfigured' }, now)).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED', dataState: 'not_written' } });
  });
});
