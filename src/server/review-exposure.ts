import { KnowledgeNodeSchema, type VersionRef } from '../contracts/domain';

export function returnedKnowledgeRefs(value: unknown): VersionRef[] {
  const refs = new Map<string, VersionRef>();
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) throw new Error('Knowledge response exceeds observation budget');
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    const parsed = KnowledgeNodeSchema.safeParse(item);
    if (parsed.success) {
      const node = parsed.data, ref = { workspaceId: node.workspaceId, objectId: node.id, revision: node.revision };
      refs.set(JSON.stringify(ref), ref);
    } else pending.push(...Object.values(item));
  }
  return [...refs.values()];
}
