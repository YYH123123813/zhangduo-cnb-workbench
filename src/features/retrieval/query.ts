import type { RequestContext, Result } from '../../contracts/api';
import type { RetrievalRequest, RetrievalResult } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { validateTaskContext } from '../../contracts/task';
import { cancelled, failure } from './api';
import { applicability } from './conditions';
import { recallSeeds } from './recall';
import { readSemantic, semanticView } from './semantic';
import { authorizedView, readSnapshot } from './snapshot';
import { expandGraph } from './graph';
import { riskGates } from './gates';
import { evidenceLabels, nodeOrder, orderSeeds, sourceGaps } from './ranking';

export async function runQuery(ctx: RequestContext, request: RetrievalRequest, services: Services, signal?: AbortSignal): Promise<Result<RetrievalResult>> {
  if (signal?.aborted) return cancelled();
  const saved = await readSnapshot(ctx, services);
  if (signal?.aborted) return cancelled();
  if (!saved.ok) return saved;
  const task = validateTaskContext(request.task, saved.data, ctx.actorId);
  if (!task.ok) return task;
  const semantic = await readSemantic(ctx, request.query, services);
  if (signal?.aborted) return cancelled();
  if (!semantic.ok && ['FORBIDDEN', 'UNAUTHORIZED', 'CONFLICT'].includes(semantic.error.code)) return semantic;
  // Re-reading also reapplies the platform's current ACL and deletion exclusions.
  const current = await readSnapshot(ctx, services);
  if (signal?.aborted) return cancelled();
  if (!current.ok) return current;
  if (current.data.revision !== saved.data.revision) return failure('CONFLICT', '检索期间知识版本已变化。', 'refresh_snapshot');
  const checked = validateTaskContext(task.data, current.data, ctx.actorId);
  if (!checked.ok) return checked;
  const snapshot = current.data;
  const { nodes, excludedIds } = authorizedView(snapshot, ctx);
  const recalled = semanticView(semantic, snapshot.revision);
  if (!recalled.ok) return recalled;
  const seeds = orderSeeds(recallSeeds(nodes, request.query, recalled.data.hits), checked.data);
  const expanded = expandGraph(nodes, snapshot.relations, seeds, { excludedIds: snapshot.excludedIds });
  const hits = expanded.nodes;
  const warnings = [recalled.data.warning];
  const reasons = applicability(hits, expanded.relations, checked.data);
  for (const n of hits) reasons.get(n.id)!.push(...sourceGaps(n));
  const gates = riskGates(expanded, nodes, snapshot.relations, reasons, snapshot.excludedIds);
  warnings.push(...gates.warnings);
  const order = nodeOrder(seeds);
  const conflicts = hits.filter((n) => gates.conflicts.has(n.id)).sort(order);
  const conditional = hits.filter((n) => !gates.conflicts.has(n.id) && reasons.get(n.id)?.length).sort(order);
  const eligible = hits.filter((n) => !gates.conflicts.has(n.id) && !reasons.get(n.id)?.length).sort(order);
  const byId = new Map(hits.map((n) => [n.id, n]));
  const paths = expanded.paths.map((p) => {
    const n = byId.get(p.nodeIds.at(-1)!)!;
    const group = gates.conflicts.has(n.id) ? '存在冲突' : reasons.get(n.id)?.length ? '有条件参考' : '通过当前检查';
    return { ...p, reason: `${p.reason} 排序：${group} / ${evidenceLabels[n.evidenceStatus]} / 相关性 / 稳定对象ID。${(reasons.get(n.id) ?? []).join(' ')}` };
  });
  return { ok: true, data: { queryId: crypto.randomUUID(), snapshotRevision: snapshot.revision,
    groups: { eligible, conditional, conflicts, excludedIds },
    paths,
    answer: null, missingConditions: [...new Set([...conditional, ...conflicts].flatMap((n) => reasons.get(n.id) ?? []))], warnings, coverage: recalled.data.coverage } };
}
