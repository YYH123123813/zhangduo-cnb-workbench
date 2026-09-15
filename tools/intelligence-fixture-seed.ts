import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { Approval, Candidate, ChangeSet, Conversation, HandoffDraft, KnowledgeNode, KnowledgeSnapshot } from '../src/contracts/domain';
import type { IntelligenceOverview, MemoryChat } from '../src/contracts/intelligence';
import { LOCAL_DEMO_KEY } from '../src/contracts/runtime';
import { SESSION_BINDING_HEADER, workspaceSessionBinding, WorkspaceSessionSchema } from '../src/contracts/session';

export async function seedIntelligenceFixture(app: Hono) {
  const connection = await app.request('/api/workspace/connect', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionKey: LOCAL_DEMO_KEY, confirmed: true }) });
  const envelope = await connection.json();
  if (!envelope.ok || envelope.meta.mode !== 'fixture') throw Error('Seed requires a connected synthetic runtime');
  const session = WorkspaceSessionSchema.parse(envelope.data);
  const headers = { Cookie: connection.headers.get('set-cookie')!.split(';')[0]!, Origin: 'http://localhost', 'Content-Type': 'application/json',
    [SESSION_BINDING_HEADER]: await workspaceSessionBinding(session) };
  async function request<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
    const response = await app.request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), result = await response.json();
    if (!response.ok || !result.ok || result.meta.mode !== 'fixture') throw Error(`Synthetic seed failed at ${path}: ${response.status} ${result.error?.code}`);
    return result.data;
  }
  const overview = await request<IntelligenceOverview>('/api/intelligence');
  if (overview.revision === 0) await request('/api/intelligence', { action: 'settings', operationId: randomUUID(), expectedRevision: 0,
    settings: { ...overview.settings, provider: 'local', steps: 5 }, confirmed: true });
  for (const [index, text] of ['合成来源甲：允许短暂旧数据时，可以复用缓存；实时一致场景需要重新读取。',
    '合成来源乙：正式知识需人工核对原句和条件，模型候选不自动成为知识。'].entries()) {
    const title = `[合成验收] 来源${index + 1}`;
    if (overview.samples.some((node) => node.title === title)) continue;
    const chat = await request<MemoryChat>('/api/intelligence', { action: 'create_chat', operationId: randomUUID(), title, retentionDays: 30, confirmed: true });
    const sent = await request<MemoryChat>('/api/intelligence', { action: 'send', operationId: randomUUID(), id: chat.id, expectedRevision: chat.revision,
      text, provider: 'local', confirmed: true, modelConsent: true });
    const archive = await request<{ conversationId: string }>('/api/intelligence', { action: 'archive', operationId: randomUUID(), id: chat.id, expectedRevision: sent.revision, confirmed: true });
    const path = `/api/handoff/${archive.conversationId}`;
    const review = await request<{ conversation: Conversation }>(`${path}?source=manual`), saved = review.conversation;
    const manual = await request<{ items: { subject: Pick<Candidate, 'spans' | 'sources'>; draftId: string; nodeId: string }[] }>(`${path}/manual`,
      { segmentIds: [saved.segments[0]!.id], expectedConversationHash: saved.contentHash, confirmed: true });
    const item = manual.items[0]!, snapshot = await request<KnowledgeSnapshot>(`${path}/snapshot`);
    const node: KnowledgeNode = { id: item.nodeId, workspaceId: session.workspace.id, schemaVersion: 1, revision: snapshot.revision, title, question: title,
      humanStatement: text, authorship: 'human_written', candidateIds: [], conversationId: saved.id, kind: 'method',
      conditions: [{ id: 'synthetic-only', text: '仅限合成验收，不是事实结论。', status: 'confirmed', evidenceIds: [], confirmedBy: session.actorId }],
      boundaries: ['自动化合成 seed，非用户真实知识。'], sources: item.subject.sources.map((source) => ({ ...source, support: 'supports', supportedClaim: text })),
      confirmation: 'draft', evidenceStatus: 'supported', lifecycle: 'active', updatedAt: new Date().toISOString() };
    const draft: HandoffDraft = { id: item.draftId, conversationId: saved.id, candidateId: null, baseRevision: snapshot.revision, node, relations: [] };
    await request(`${path}/draft`, { draft, consent: true, options: { operationId: randomUUID(), source: { kind: 'manual', spans: item.subject.spans },
      expectedConversationHash: saved.contentHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true } }, 'PUT');
    const prepared = await request<{ draft: HandoffDraft; changes: ChangeSet }>(`${path}/preview`, { draft, reason: 'Explicit synthetic final acceptance seed' });
    const confirmation = { draft: prepared.draft, changes: prepared.changes, confirmed: true };
    const approval = await request<Approval>(`${path}/approval`, confirmation);
    await request(`${path}/commit`, { ...confirmation, approval });
  }
  return (await request<IntelligenceOverview>('/api/intelligence')).samples.filter((node) => node.title.startsWith('[合成验收]'));
}
