import { z } from 'zod';
import type { RequestContext, Result } from '../../contracts/api';
import { Id, KnowledgeNodeSchema, RelationSchema, Timestamp, type KnowledgeSnapshot } from '../../contracts/domain';
import type { Services } from '../../contracts/ports';
import { SCOPES } from '../../contracts/scopes';
import { failure } from './api';
import { compareId } from './recall';

const SnapshotSchema = z.object({ workspaceId: Id, revision: Id, nodes: z.array(KnowledgeNodeSchema).max(5000),
  relations: z.array(RelationSchema).max(20000), excludedIds: z.array(Id).max(10000), generatedAt: Timestamp }).strict();

export async function readSnapshot(ctx: RequestContext, services: Services, revision?: string): Promise<Result<KnowledgeSnapshot>> {
  if (!ctx.scopes.includes(SCOPES.knowledgeRead)) return failure('FORBIDDEN', '缺少知识读取权限。', 'check_permissions');
  const result = await (revision ? services.snapshot(ctx, revision) : services.snapshot(ctx));
  if (!result.ok) return result;
  if (result.data?.workspaceId !== ctx.workspaceId) return failure('FORBIDDEN', '快照不属于当前工作区。', 'check_permissions');
  const parsed = SnapshotSchema.safeParse(result.data);
  if (!parsed.success) return failure('UPSTREAM', '快照数据未通过契约校验。', 'repair_snapshot');
  if (revision && parsed.data.revision !== revision) return failure('CONFLICT', '平台未返回请求的固定版本，未替换历史引用。', 'refresh_snapshot');
  const { nodes, relations } = parsed.data;
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length || new Set(relations.map((r) => r.id)).size !== relations.length ||
    nodes.some((n) => new Set(n.sources.map((s) => s.id)).size !== n.sources.length || new Set(n.conditions.map((c) => c.id)).size !== n.conditions.length)) {
    return failure('UPSTREAM', '快照存在重复对象标识。', 'repair_snapshot');
  }
  return { ok: true, data: parsed.data };
}

export function authorizedView(snapshot: KnowledgeSnapshot, ctx: RequestContext) {
  const blocked = new Set(snapshot.excludedIds);
  const local = snapshot.nodes.filter((n) => n.workspaceId === ctx.workspaceId);
  const nodes = local.filter((n) => n.confirmation === 'confirmed' && n.lifecycle !== 'withdrawn' && !blocked.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  const excludedIds = [...new Set([...snapshot.excludedIds, ...local.filter((n) => !kept.has(n.id)).map((n) => n.id)])].sort(compareId);
  return { nodes, excludedIds };
}
