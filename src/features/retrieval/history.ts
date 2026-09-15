import type { RequestContext, Result } from '../../contracts/api';
import type { Services } from '../../contracts/ports';
import { cancelled, failure, HistoryQuerySchema, type NodeDetail } from './api';
import { authorizedView, readSnapshot } from './snapshot';
import { describeNodeDetail } from './details';

export async function readHistoricalDetail(ctx: RequestContext, services: Services, id: string, revision: string,
  { signal, snapshotRevision = revision }: { signal?: AbortSignal; snapshotRevision?: string } = {}): Promise<Result<NodeDetail>> {
  if (signal?.aborted) return cancelled();
  if (!HistoryQuerySchema.safeParse({ revision, snapshotRevision }).success) return failure('VALIDATION', '历史读取需要完整Git版本。', 'review_input');
  const before = await readSnapshot(ctx, services);
  if (signal?.aborted) return cancelled();
  if (!before.ok) return before;
  const unavailable = () => failure('FORBIDDEN', '当前范围内没有可读取的正式知识。', 'check_permissions');
  if (!authorizedView(before.data, ctx).nodes.some((n) => n.id === id)) return unavailable();

  const historical = await readSnapshot(ctx, services, snapshotRevision);
  if (signal?.aborted) return cancelled();
  if (!historical.ok) return historical;
  const after = await readSnapshot(ctx, services);
  if (signal?.aborted) return cancelled();
  if (!after.ok) return after;
  const current = new Map(authorizedView(after.data, ctx).nodes.map((n) => [n.id, n]));
  const currentNode = current.get(id);
  if (!currentNode) return unavailable();
  if (after.data.revision !== before.data.revision) return failure('CONFLICT', '历史读取期间当前快照已变化，请重新核对。', 'refresh_snapshot');

  // Historical authorization never widens the latest readable node/exclusion scope.
  const detail = describeNodeDetail(ctx, { ...historical.data,
    nodes: historical.data.nodes.filter((n) => current.has(n.id)),
    excludedIds: [...new Set([...historical.data.excludedIds, ...after.data.excludedIds])],
  }, id, revision, snapshotRevision);
  if (!detail.ok) return detail;
  return { ok: true, data: { ...detail.data,
    history: { currentSnapshotRevision: after.data.revision, currentNodeRevision: currentNode.revision },
    relations: detail.data.relations.map((entry) => ({ ...entry, usable: false, reason: `仅供历史核对，不参与当前检索。${entry.reason}` })),
    warnings: [...detail.data.warnings, '这是显式读取的引用版本，仅供历史核对，不用于当前采用或回答。'],
  } };
}
