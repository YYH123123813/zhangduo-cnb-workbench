import { z } from 'zod';
import { Id, type EvidenceRecord } from '../../contracts/domain';
import type { RequestContext } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { checkedEvidence, evidenceObjectIds } from './evidence-scope';
import { fail, parse, readSnapshot, unwrap } from './http';
import { readHistoryNotices } from './history';

export const historySelectionSchema = z.object({ nodeId: Id.optional(), taskId: Id.optional(), useId: Id.optional(), evidenceId: Id.optional() }).strict();
export type HistorySelection = z.infer<typeof historySelectionSchema>;
export function historySelectionQuery(query: Record<string, string[]>): HistorySelection {
  if (Object.values(query).some((values) => values.length !== 1)) fail('VALIDATION', '历史记录参数不可重复。');
  return parse(historySelectionSchema, Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0]])));
}

export async function readSelectedHistory(services: Services, ctx: RequestContext, selection: HistorySelection) {
  const snapshot = await readSnapshot(services, ctx);
  const exact = !!(selection.useId || selection.evidenceId);
  let records: EvidenceRecord[];
  if (!exact) {
    records = checkedEvidence(unwrap(await (selection.taskId ? services.listEvidence(ctx, selection.taskId) : services.listEvidence(ctx))), ctx.workspaceId);
  } else {
    if (!services.readEvidence) fail('NOT_IMPLEMENTED', '原记录读取能力尚未接入，未读取其他历史记录。');
    const cache = new Map<string, EvidenceRecord>();
    const read = async (id: string): Promise<EvidenceRecord> => {
      if (cache.has(id)) return cache.get(id)!;
      const value = unwrap(await services.readEvidence!(ctx, id));
      if (value === null) fail('UNKNOWN_RESULT', '未读到指定原记录，未恢复内容或重新保存。', 'read_original_record', 'preserved');
      const record = checkedEvidence([value], ctx.workspaceId)[0]!;
      if (record.id !== id) fail('FORBIDDEN', '返回的历史记录与指定ID不一致。');
      cache.set(id, record); return record;
    };
    let use = selection.useId ? await read(selection.useId) : undefined;
    if (use && use.kind !== 'use') fail('VALIDATION', 'useId必须指向原使用记录。');
    const evidence = selection.evidenceId ? await read(selection.evidenceId) : undefined;
    if (evidence?.outcome) {
      if (use && evidence.outcome.useRecordId !== use.id) fail('FORBIDDEN', '结果不属于指定的原使用记录。');
      use ??= await read(evidence.outcome.useRecordId);
      if (use.kind !== 'use') fail('FORBIDDEN', '结果关联的原记录不是使用记录。');
    }
    if (use && evidence && (evidence.taskId !== use.taskId || evidence.id !== use.id && evidence.outcome?.useRecordId !== use.id)) fail('FORBIDDEN', '证据与原使用记录的任务或关联不一致。');
    records = [use, evidence].filter((record): record is EvidenceRecord => !!record).filter((record, index, list) => list.findIndex((item) => item.id === record.id) === index);
  }
  if (selection.taskId && records.some((record) => record.taskId !== selection.taskId)) fail('FORBIDDEN', '历史记录不属于指定任务。');
  if (exact && selection.nodeId && !records.some((record) => evidenceObjectIds(record).includes(selection.nodeId!))) fail('FORBIDDEN', '指定知识不在原记录引用范围内。');
  return readHistoryNotices(services, ctx, snapshot, records, exact ? undefined : selection.nodeId);
}
