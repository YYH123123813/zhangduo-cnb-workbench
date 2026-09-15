import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TaskContextSchema, type KnowledgeNode, type KnowledgeSnapshot } from './domain';
import { validateTaskContext } from './task';
import { contentHash } from './hash';

const task = { id: 'task-A', workspaceId: 'workspace-A', question: 'Original task', constraints: [], mode: 'assisted', updatedAt: '2026-09-05T00:00:00Z' };
const ref = { workspaceId: task.workspaceId, objectId: 'node-A', revision: 'a'.repeat(40) };
const check = { nodeRef: ref, conditionId: 'premise-A', status: 'not_satisfied', confirmedBy: 'actor-A' };
const node: KnowledgeNode = { id: ref.objectId, workspaceId: task.workspaceId, schemaVersion: 1, revision: ref.revision, title: 'Claim', question: 'When?', humanStatement: 'Conditional claim',
  authorship: 'human_written', candidateIds: [], conversationId: 'conversation-A', kind: 'claim', conditions: [{ id: check.conditionId, text: 'A required premise', status: 'confirmed', evidenceIds: [] }],
  boundaries: [], sources: [], confirmation: 'confirmed', evidenceStatus: 'unverified', lifecycle: 'active', confirmedBy: 'actor-A', confirmedAt: task.updatedAt, updatedAt: task.updatedAt };
const snapshot: KnowledgeSnapshot = { workspaceId: task.workspaceId, revision: ref.revision, nodes: [node], relations: [], excludedIds: [], generatedAt: task.updatedAt };

describe('W4-REQ-006 version-bound task condition checks', () => {
  it('keeps explicit satisfaction, rejection and unknown distinct without changing formal knowledge', () => {
    for (const status of ['satisfied', 'not_satisfied', 'unknown']) {
      const value = { ...check, status, ...(status === 'unknown' ? { confirmedBy: undefined } : {}) };
      expect(TaskContextSchema.safeParse({ ...task, conditionChecks: [value] }).success).toBe(true);
    }
    expect(TaskContextSchema.parse(task)).toEqual(task);
    expect(TaskContextSchema.parse(task)).not.toHaveProperty('conditionChecks');
  });
  it('rejects missing attribution, attributed unknown, duplicate bindings, foreign workspace and mutable versions', () => {
    const invalid = [
      [{ ...check, confirmedBy: undefined }], [{ ...check, status: 'unknown' }], [check, check],
      [{ ...check, nodeRef: { ...ref, revision: 'HEAD' } }],
      [check, { ...check, nodeRef: { ...ref, revision: 'b'.repeat(40) } }],
    ];
    for (const conditionChecks of invalid) expect(TaskContextSchema.safeParse({ ...task, conditionChecks }).success).toBe(false);
    expect(TaskContextSchema.safeParse({ ...task, conditionChecks: [check, { ...check, nodeRef: { ...ref, objectId: 'node-B' } }] }).success).toBe(true);
  });
  it('checks trusted actor, exact version, condition ID and deletion visibility without matching natural-language text', () => {
    const input = { ...task, conditionChecks: [check] };
    expect(validateTaskContext(input, snapshot, 'actor-A')).toMatchObject({ ok: true, data: input });
    expect(validateTaskContext(input, snapshot, 'actor-B')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(validateTaskContext({ ...task, conditionChecks: [{ ...check, nodeRef: { ...ref, workspaceId: 'another' } }] }, snapshot, 'actor-A')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(validateTaskContext(input, { ...snapshot, nodes: [{ ...node, revision: 'b'.repeat(40) }] }, 'actor-A')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(validateTaskContext(input, { ...snapshot, nodes: [{ ...node, conditions: [{ ...node.conditions[0]!, id: 'same-text-different-condition' }] }] }, 'actor-A')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(validateTaskContext(input, { ...snapshot, excludedIds: [node.id] }, 'actor-A')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(validateTaskContext({ ...task, constraints: [{ id: 'free', text: 'A free-form premise', confirmedBy: 'actor-B' }] }, snapshot, 'actor-A').ok).toBe(false);
  });
  it('keeps each answer in the full task hash and leaves the formal premise unchanged', async () => {
    const before = structuredClone(snapshot);
    const hashes = [];
    for (const status of ['satisfied', 'not_satisfied', 'unknown']) {
      const input = { ...task, conditionChecks: [{ ...check, status, ...(status === 'unknown' ? { confirmedBy: undefined } : {}) }] };
      const result = validateTaskContext(input, snapshot, 'actor-A'); expect(result.ok).toBe(true);
      if (result.ok) hashes.push(await contentHash(JSON.parse(JSON.stringify(result.data))));
    }
    expect(new Set(hashes).size).toBe(3); expect(snapshot).toEqual(before);
  });
  it('preserves existing object extensions used by consumers without dropping the new field', () => {
    const extended = TaskContextSchema.extend({ question: z.string().trim().min(1).max(2000) });
    expect(extended.parse({ ...task, conditionChecks: [check] }).conditionChecks).toEqual([check]);
    expect(extended.safeParse({ ...task, conditionChecks: [check, check] }).success).toBe(false);
  });
});
