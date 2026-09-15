import type { ChangeSet, Conversation, EvidenceRecord, Settings, DeletePlan } from './domain';

export function normalizeSourceText(text: string): string { return text.replace(/\r\n?/g, '\n'); }

// Sorted plain JSON only: no coercion of dates, undefined, sparse arrays or non-finite values.
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new Error('Hash payload is too deeply nested');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new Error('Hash payload must contain only JSON values');
    if (active.has(item)) throw new Error('Cyclic hash payload');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Hash payload must contain plain objects');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Symbol keys are not supported');
    active.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      const parts: string[] = [];
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new Error('Sparse arrays are not supported');
        parts.push(encode(item[index], depth + 1));
      }
      encoded = `[${parts.join(',')}]`;
    } else {
      encoded = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    }
    active.delete(item);
    return encoded;
  }
  return encode(value, 0);
}

export async function contentHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function conversationPayload(value: Conversation) {
  return { id: value.id, workspaceId: value.workspaceId, taskId: value.taskId, origin: value.origin,
    segments: value.segments.map(({ id, role, text }) => ({ id, role, text })) };
}
export const hashConversation = (value: Conversation) => contentHash(conversationPayload(value));
export const hashSegment = (conversationId: string, segment: { id: string; text: string }) => contentHash({ conversationId, segmentId: segment.id, text: segment.text });
export const hashModelInput = (value: { purpose: 'extract' | 'answer' | 'review'; text: string; sourceIds: string[] }) => contentHash({ purpose: value.purpose, text: value.text, sourceIds: value.sourceIds });
export function changeSetPayload(value: ChangeSet | Omit<ChangeSet, 'contentHash'>) {
  return { id: value.id, workspaceId: value.workspaceId, baseRevision: value.baseRevision, nodes: value.nodes, relations: value.relations, withdrawnIds: value.withdrawnIds, reason: value.reason };
}
export const hashChangeSet = (value: ChangeSet | Omit<ChangeSet, 'contentHash'>) => contentHash(changeSetPayload(value));
export const hashEvidence = (value: EvidenceRecord) => contentHash(value);
export const hashSettings = (workspaceId: string, baseRevision: string, settings: Settings) => contentHash({ workspaceId, baseRevision, settings });
export const hashExport = (workspaceId: string, baseRevision: string, objectIds: string[]) => contentHash({ workspaceId, baseRevision, objectIds });
export function hashDeletePlan(value: DeletePlan) {
  return contentHash({ id: value.id, workspaceId: value.workspaceId, objectIds: value.objectIds, baseRevision: value.baseRevision, layers: value.layers });
}
