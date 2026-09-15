import { z } from 'zod';
import type { KnowledgeNode } from '../../contracts/domain';

export const SemanticHitsSchema = z.array(z.object({ objectId: z.string().min(1).max(160), score: z.number().finite(), text: z.string() })).max(1000);
export interface Seed { node: KnowledgeNode; score: number; reason: string }
export const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalize = (text: string) => text.normalize('NFC').toLowerCase();

export function recallSeeds(nodes: KnowledgeNode[], query: string, semantic: z.infer<typeof SemanticHitsSchema>): Seed[] {
  const segments = new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...segments.segment(normalize(query))].filter((s) => s.isWordLike).map((s) => s.segment);
  const terms = [...new Set([normalize(query), ...words])];
  const vectors = new Map<string, number>();
  for (const hit of semantic) vectors.set(hit.objectId, Math.max(vectors.get(hit.objectId) ?? 0, Math.max(0, Math.min(1, hit.score))));
  return nodes.flatMap((node) => {
    const text = normalize(`${node.title}\n${node.question}\n${node.humanStatement}`);
    const textScore = terms.filter((term) => text.includes(term)).length / terms.length;
    const semanticScore = vectors.get(node.id);
    if (!textScore && semanticScore === undefined) return [];
    const reason = [textScore > 0 ? 'Git 正文匹配' : '', semanticScore !== undefined ? 'CNB 语义定位' : ''].filter(Boolean).join(' + ');
    return [{ node, score: Math.max(textScore, semanticScore ?? 0), reason: `${reason}；相似不等于来源支持。` }];
  }).sort((a, b) => b.score - a.score || compareId(a.node.id, b.node.id));
}
