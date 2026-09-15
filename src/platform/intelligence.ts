import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext, Result } from '../contracts/api';
import type { Services } from '../contracts/ports';
import type { Conversation } from '../contracts/domain';
import { canonicalJson, hashConversation } from '../contracts/hash';
import { CandidateOutputSchema } from '../contracts/candidates';
import { ChatSchema, DEFAULT_INTELLIGENCE, IntelligenceCommandSchema, IntelligenceSettingsSchema, IntelligenceMutationSchema, IntelligenceOperationSchema, TrainingRunSchema, trainingWeight,
  type IntelligenceCommand, type IntelligenceOperation, type MemoryChat, type TrainingRun, type TrainingSample } from '../contracts/intelligence';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import type { ChatGateway } from './ai-providers';
import { TrainingFailure, type TrainingExecutor } from './training-runner';
import type { ModelTransport } from './model';
import { failure } from './result';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const now = () => new Date().toISOString();
const secrets = (text: string) => /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKID[A-Za-z0-9]{16,})/.test(text);
const unknown = <T = never>() => failure<T>('UNKNOWN_RESULT', '原操作尚未核验；不会自动重复发送、写入或训练。', 'read_original_operation', 'unknown');
type Mutation = Extract<IntelligenceCommand, { operationId: string }>;
const OperationSchema = z.object({ hash: z.string(), action: IntelligenceMutationSchema.optional(), targetId: z.string().nullable().optional(),
  state: z.enum(['sending', 'done', 'failed']), value: z.unknown() });
const ArchiveSchema = z.object({ operationId: z.string().uuid(), chatId: z.string(), chatRevision: z.number().int(),
  conversationId: z.string(), contentHash: z.string(), state: z.enum(['sending', 'done', 'failed']) });

export class IntelligenceStore {
  private readonly running = new Set<string>();
  constructor(private readonly sessions: SessionRegistry, private readonly journal: OperationJournal,
    private readonly gateway: ChatGateway, private readonly executor: TrainingExecutor, private readonly services: () => Services) {}
  private record(ctx: RequestContext, kind: string, id: string) { return this.journal.record(ctx.workspaceId, ctx.actorId, `intelligence_${kind}`, id); }
  private runningKey(ctx: RequestContext, kind: string, id: string) { return canonicalJson([ctx.workspaceId, ctx.actorId, kind, id]); }
  private put(ctx: RequestContext, kind: string, id: string, value: unknown, revision?: number | null) {
    const old = this.record(ctx, kind, id);
    if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, `intelligence_${kind}`, id, value, revision === undefined ? old?.version ?? null : revision)) throw Error('Concurrent intelligence update');
  }
  private putOperation(ctx: RequestContext, command: Mutation, hash: string, state: 'sending' | 'done' | 'failed', value: unknown, revision?: number | null) {
    this.put(ctx, 'operation', command.operationId, { hash, action: command.action, targetId: 'id' in command ? command.id
      : ['create_chat', 'train'].includes(command.action) ? command.operationId : null, state, value }, revision);
  }
  private archiveState(ctx: RequestContext, chatId: string) {
    const value = this.record(ctx, 'archive', chatId)?.value;
    return value ? ArchiveSchema.parse(value) : null;
  }
  private finishArchive(ctx: RequestContext, claim: z.infer<typeof ArchiveSchema>, saved: Conversation): Result<unknown> {
    if (saved.id !== claim.conversationId || saved.workspaceId !== ctx.workspaceId || saved.contentHash !== claim.contentHash || saved.state !== 'saved' || !saved.sourceAlreadyPersisted) return unknown();
    const access = this.sessions.authorize(ctx, 'conversation:read'); if (!access.ok) return access;
    const value = { conversationId: saved.id, ...(saved.issueNumber ? { issueNumber: saved.issueNumber } : {}), taskId: saved.taskId };
    return this.journal.transaction(() => {
      const currentClaim = this.archiveState(ctx, claim.chatId);
      if (currentClaim?.operationId !== claim.operationId || currentClaim.state === 'failed') return unknown();
      const receipt = OperationSchema.parse(this.record(ctx, 'operation', claim.operationId)?.value);
      const chat = this.readChat(ctx, claim.chatId);
      if (chat?.revision === claim.chatRevision) this.put(ctx, 'chat', chat.id, { ...chat, archivedConversationId: saved.id, revision: chat.revision + 1 });
      this.put(ctx, 'archive', claim.chatId, { ...claim, state: 'done' });
      this.put(ctx, 'operation', claim.operationId, { ...receipt, state: 'done', value });
      return { ok: true as const, data: value };
    });
  }
  private async recoverArchive(ctx: RequestContext, claim: z.infer<typeof ArchiveSchema>): Promise<void> {
    if (claim.state !== 'sending' || this.running.has(this.runningKey(ctx, 'archive', claim.operationId))) return;
    // Recovery is restricted to the original write identity; it never calls saveConversation.
    if (!this.journal.conversation(ctx.workspaceId, claim.conversationId)) return;
    const saved = await this.services().readConversation(ctx, claim.conversationId);
    if (saved.ok) this.finishArchive(ctx, claim, saved.data);
  }
  private async readOperation(ctx: RequestContext, id: string): Promise<Result<IntelligenceOperation>> {
    let row = this.record(ctx, 'operation', id);
    const empty = { operationId: id, action: null, requestHash: null, targetId: null, state: 'not_found' as const,
      result: null, updatedAt: null, readOnly: true as const, absenceIsFinal: false as const };
    if (!row) return { ok: true, data: empty };
    let receipt = OperationSchema.parse(row.value);
    const scope = ['create_chat', 'send', 'archive', 'delete_chat'].includes(receipt.action ?? '') ? 'conversation:read' : 'settings:read';
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (receipt.action === 'archive' && receipt.targetId) {
      const claim = this.archiveState(ctx, receipt.targetId);
      if (claim?.operationId === id) await this.recoverArchive(ctx, claim);
      row = this.record(ctx, 'operation', id)!; receipt = OperationSchema.parse(row.value);
    }
    const stillAllowed = this.sessions.authorize(ctx, scope); if (!stillAllowed.ok) return stillAllowed;
    const running = receipt.action === 'send' ? this.runningKey(ctx, 'chat', receipt.targetId ?? '') : this.runningKey(ctx, 'archive', id);
    const state = !receipt.action ? 'unknown' : receipt.state === 'done' ? 'completed' : receipt.state === 'failed' ? 'failed' : this.running.has(running) ? 'pending' : 'unknown';
    let result: IntelligenceOperation['result'] = null;
    if (state === 'completed') {
      const value = receipt.value as Record<string, unknown>;
      if (receipt.action === 'settings') result = { revision: Number(value.revision) };
      else if (receipt.action === 'create_chat' || receipt.action === 'send') result = { chatId: String(value.id) };
      else if (receipt.action === 'train') result = { runId: String(value.id) };
      else if (receipt.action === 'activate' || receipt.action === 'deactivate') result = { activeRunId: value.id === null ? null : String(value.id) };
      else if (receipt.action === 'archive') result = { conversationId: String(value.conversationId), taskId: String(value.taskId), ...(value.issueNumber ? { issueNumber: Number(value.issueNumber) } : {}) };
      else if (receipt.action === 'delete_chat' || receipt.action === 'delete_run') result = { deleted: value.deleted === true, physicalErasure: false, ...(receipt.action === 'delete_chat' ? { cnbArchiveDeleted: false as const } : {}) };
    }
    return { ok: true, data: IntelligenceOperationSchema.parse({ ...empty, action: receipt.action ?? null, requestHash: receipt.hash,
      targetId: receipt.targetId ?? null, state, result, updatedAt: row.updatedAt }) };
  }
  private settings(ctx: RequestContext) {
    const row = this.record(ctx, 'settings', 'current');
    return { revision: row?.version ?? 0, settings: row ? IntelligenceSettingsSchema.parse(row.value) : structuredClone(DEFAULT_INTELLIGENCE) };
  }
  private readChat(ctx: RequestContext, id: string): MemoryChat | null {
    const row = this.record(ctx, 'chat', id); if (!row || row.value === null) return null;
    const chat = ChatSchema.parse(row.value);
    if (Date.parse(chat.expiresAt) <= Date.now()) { this.put(ctx, 'chat', id, null); return null; }
    return chat.status === 'sending' && !this.running.has(this.runningKey(ctx, 'chat', id)) ? { ...chat, status: 'unknown' } : chat;
  }
  private run(ctx: RequestContext, id: string): TrainingRun | null {
    const row = this.record(ctx, 'run', id); if (!row) return null;
    let run = TrainingRunSchema.parse(row.value);
    const process = this.executor.inspect?.(ctx.workspaceId, ctx.mode as 'fixture' | 'live', id);
    if (run.state === 'running' && !this.running.has(this.runningKey(ctx, 'train', run.id))) {
      if (process === 'stopped') {
        run = { ...run, state: 'interrupted', message: '原进程已确认停止，训练结果未接纳；可单独删除本次产物，不会自动重跑。' };
        this.put(ctx, 'run', id, run, row.version);
      } else if (process !== 'running') return { ...run, state: 'interrupted', cleanupReady: false, message: '训练进程状态尚未核验；不会自动重跑或删除，请管理员核对原进程。' };
    }
    return { ...run, cleanupReady: Boolean(this.executor.remove) && ['completed', 'failed', 'interrupted'].includes(run.state)
      && (process === 'stopped' || (!this.executor.inspect && run.state !== 'interrupted')) };
  }
  private runs(ctx: RequestContext) {
    return this.journal.records(ctx.workspaceId, ctx.actorId, 'intelligence_run').map((row) => this.run(ctx, row.id)!)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async overview(ctx: RequestContext): Promise<Result<unknown>> {
    const conversationAccess = this.sessions.authorize(ctx, 'conversation:read'); if (!conversationAccess.ok) return conversationAccess;
    const snapshot = await this.services().snapshot(ctx);
    if (!snapshot.ok && ['UNAUTHORIZED', 'FORBIDDEN'].includes(snapshot.error.code)) return snapshot;
    const evidence = await this.services().listEvidence(ctx);
    if (!evidence.ok && ['UNAUTHORIZED', 'FORBIDDEN'].includes(evidence.error.code)) return evidence;
    const saved = this.settings(ctx);
    const samples = snapshot.ok && evidence.ok ? snapshot.data.nodes.filter((n) => n.confirmation === 'confirmed' && n.lifecycle === 'active' && !snapshot.data.excludedIds.includes(n.id)).map((node) => {
      const uses = evidence.data.filter((e) => e.kind === 'use' && e.decision === 'adopt' && e.nodeRefs.some((ref) => ref.objectId === node.id && ref.revision === node.revision)).length;
      const corrected = node.authorship === 'human_edited';
      return { id: node.id, revision: node.revision, title: node.title, uses, corrected, weight: trainingWeight(saved.settings, { id: node.id, uses, corrected }) };
    }) : [];
    const samplesStatus = snapshot.ok && evidence.ok ? { state: 'ready', message: '' }
      : { state: 'unavailable', message: '正式知识或采用记录暂不可读取，训练节点不可选；对话与模型设置仍可使用。' };
    const access = this.sessions.authorize(ctx, 'settings:read'); if (!access.ok) return access;
    const active = this.record(ctx, 'active', 'current')?.value as { id: string } | null | undefined;
    return { ok: true, data: { ...saved, providers: this.gateway.status(), training: { ready: this.executor.ready(), pretrainedReady: this.executor.pretrainedReady(), activeRunId: active?.id ?? null },
      samples, samplesStatus, runs: this.runs(ctx), chats: this.journal.records(ctx.workspaceId, ctx.actorId, 'intelligence_chat').flatMap((r) => {
        const chat = this.readChat(ctx, r.id); if (!chat) return []; const { messages: _, ...summary } = chat; return [summary];
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } };
  }
  private async samples(ctx: RequestContext, ids: string[]): Promise<Result<{ samples: TrainingSample[]; refs: TrainingRun['nodeRefs'] }>> {
    const snapshot = await this.services().snapshot(ctx); if (!snapshot.ok) return snapshot;
    const evidence = await this.services().listEvidence(ctx); if (!evidence.ok) return evidence;
    const settings = this.settings(ctx).settings, samples: TrainingSample[] = [], refs: TrainingRun['nodeRefs'] = [];
    for (const id of [...new Set(ids)]) {
      const node = snapshot.data.nodes.find((n) => n.id === id && n.confirmation === 'confirmed' && n.lifecycle === 'active' && !snapshot.data.excludedIds.includes(id));
      if (!node) return failure('CONFLICT', '训练范围包含已撤回、删除或未确认的知识。', 'select_current_knowledge');
      const weight = trainingWeight(settings, { id, corrected: node.authorship === 'human_edited', uses: evidence.data.filter((e) => e.kind === 'use' && e.decision === 'adopt' && e.nodeRefs.some((r) => r.objectId === id && r.revision === node.revision)).length });
      if (!weight) continue;
      const conversation = await this.services().readConversation(ctx, node.conversationId); if (!conversation.ok) return conversation;
      const spans = node.sources.flatMap((source) => {
        if (source.support !== 'supports' || !source.excerpt.trim()) return [];
        const segment = conversation.data.segments.find((s) => s.text.includes(source.excerpt)); if (!segment) return [];
        const start = segment.text.indexOf(source.excerpt);
        return [{ segmentId: segment.id, start, end: start + source.excerpt.length, quote: source.excerpt }];
      }).slice(0, 12);
      if (!spans.length) return failure('VALIDATION', '选中知识缺少可核对的对话原句；请先在知识交接中核验来源。', 'verify_sources');
      const input = canonicalJson({ untrustedTask: { question: node.question }, untrustedSegments: conversation.data.segments.filter((s) => spans.some((span) => span.segmentId === s.id)) });
      const target = CandidateOutputSchema.parse({ candidates: [{ title: node.title, question: node.question, claim: node.humanStatement, kind: node.kind,
        whyKeep: '用户已确认的可复用知识', uncertainties: [...node.boundaries, ...node.conditions.map((c) => c.text)].slice(0, 12), spans }] });
      if (secrets(input) || secrets(canonicalJson(target))) return failure('VALIDATION', '训练范围含疑似密钥，未启动。', 'redact_sources');
      samples.push({ id, groupId: node.conversationId, input, target: canonicalJson(target), weight }); refs.push({ id, revision: node.revision });
    }
    return { ok: true, data: { samples, refs } };
  }
  async command(ctx: RequestContext, input: IntelligenceCommand): Promise<Result<unknown>> {
    const parsed = IntelligenceCommandSchema.safeParse(input); if (!parsed.success) return failure('VALIDATION', '操作参数或独立确认不完整。', 'review_input');
    const command = parsed.data;
    const scope = command.action === 'read_operation' ? 'workspace:read' : command.action === 'delete_run' ? 'data:delete' : ['overview', 'read_chat'].includes(command.action) ? command.action === 'read_chat' ? 'conversation:read' : 'settings:read'
      : ['create_chat', 'send', 'archive', 'delete_chat'].includes(command.action) ? command.action === 'delete_chat' ? 'data:delete' : 'conversation:write' : 'settings:write';
    const access = this.sessions.authorize(ctx, scope); if (!access.ok) return access;
    if (ctx.mode === 'live' && this.journal.fixture) return failure('FORBIDDEN', '训练与对话不能混用合成存储。', 'configure_storage');
    try {
      if (command.action === 'overview') return await this.overview(ctx);
      if (command.action === 'read_operation') return await this.readOperation(ctx, command.id);
      if (command.action === 'read_chat') {
        if (this.readChat(ctx, command.id)) { const claim = this.archiveState(ctx, command.id); if (claim) await this.recoverArchive(ctx, claim); }
        const access = this.sessions.authorize(ctx, 'conversation:read'); if (!access.ok) return access;
        const chat = this.readChat(ctx, command.id); return chat ? { ok: true, data: chat } : failure('VALIDATION', '会话不存在、已删除或已到期。', 'select_conversation');
      }
      const hash = digest(command), previous = this.record(ctx, 'operation', command.operationId);
      if (previous) {
        const receipt = OperationSchema.parse(previous.value);
        if (receipt.hash !== hash) return failure('CONFLICT', '原操作编号已绑定另一份内容。', 'use_new_operation');
        if (receipt.state === 'failed') return failure('CONFLICT', '原操作已明确失败；请核对后重新预览。', 'review_original_operation');
        if (receipt.state !== 'done') return unknown();
        if (command.action === 'send' || command.action === 'create_chat') {
          const chat = this.readChat(ctx, command.action === 'create_chat' ? command.operationId : command.id);
          return chat ? { ok: true, data: chat } : failure('VALIDATION', '原会话已删除或到期。', 'select_conversation');
        }
        return { ok: true, data: receipt.value };
      }
      if (command.action === 'settings' || command.action === 'train') {
        if (this.settings(ctx).revision !== command.expectedRevision) return failure('CONFLICT', '权重设置已变化，请重新读取后确认。', 'reload_settings');
      }
      if (command.action === 'settings') {
        return this.journal.transaction(() => {
          if (this.settings(ctx).revision !== command.expectedRevision) return failure('CONFLICT', '设置已在另一个窗口修改。', 'reload_settings');
          this.put(ctx, 'settings', 'current', command.settings, command.expectedRevision || null);
          const value = this.settings(ctx); this.putOperation(ctx, command, hash, 'done', value, null);
          return { ok: true as const, data: value };
        });
      }
      if (command.action === 'create_chat') {
        if (this.journal.records(ctx.workspaceId, ctx.actorId, 'intelligence_chat').filter((r) => this.readChat(ctx, r.id)).length >= 100) return failure('VALIDATION', '最多保留100个会话，请先管理已有会话。', 'manage_conversations');
        const chat: MemoryChat = { id: command.operationId, title: command.title, messages: [], revision: 1, status: 'ready', provider: this.settings(ctx).settings.provider, createdAt: now(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
        this.journal.transaction(() => { this.put(ctx, 'chat', chat.id, chat, null); this.putOperation(ctx, command, hash, 'done', { id: chat.id }, null); });
        return { ok: true, data: chat };
      }
      if (command.action === 'train') return await this.train(ctx, command, hash);
      if (command.action === 'delete_run') {
        const run = this.run(ctx, command.id);
        if (!run || !run.cleanupReady || !this.executor.remove) return failure('CONFLICT', '训练仍在运行、状态未核验或清理能力不可用。', 'verify_training_process');
        this.executor.remove(ctx.workspaceId, ctx.mode as 'fixture' | 'live', run.id);
        this.journal.transaction(() => {
          const active = this.record(ctx, 'active', 'current')?.value as { id: string } | null;
          if (active?.id === run.id) this.put(ctx, 'active', 'current', null);
          this.put(ctx, 'run', run.id, { ...run, state: 'deleted', cleanupReady: false, nodeRefs: [], datasetHash: '', message: '本次训练目录已删除；外部基础模型、备份和磁盘物理残留未删除。' });
          this.putOperation(ctx, command, hash, 'done', { deleted: true, physicalErasure: false }, null);
        });
        return { ok: true, data: { deleted: true, physicalErasure: false } };
      }
      if (command.action === 'activate' || command.action === 'deactivate') {
        if (command.action === 'activate') {
          const run = this.run(ctx, command.id);
          if (!run || run.mode !== 'lora' || run.state !== 'completed' || !run.metrics?.reloadVerified || !run.metrics.validationGroups || run.metrics.heldOutAfter === null || run.metrics.heldOutBefore === null || run.metrics.heldOutAfter > run.metrics.heldOutBefore)
            return failure('VALIDATION', '仅可试用已完成重载验证、独立验证损失未退化的预训练 LoRA；随机模型不能启用。', 'review_training_evaluation');
          const eligible = await this.checkRun(ctx, run); if (!eligible.ok) return eligible;
          const current = this.run(ctx, command.id);
          if (!current || current.state !== 'completed' || digest(current) !== digest(run)) return failure('CONFLICT', '训练记录已变化或删除，未启用。', 'reload_training');
        }
        const currentAccess = this.sessions.authorize(ctx, 'settings:write'); if (!currentAccess.ok) return currentAccess;
        const value = { id: command.action === 'activate' ? command.id : null };
        this.journal.transaction(() => { this.put(ctx, 'active', 'current', value.id ? value : null); this.putOperation(ctx, command, hash, 'done', value, null); });
        return { ok: true, data: value };
      }
      const chat = this.readChat(ctx, command.id);
      if (!chat || chat.revision !== command.expectedRevision) return failure('CONFLICT', '会话已变化、删除或到期，请重新读取。', 'read_conversation');
      if (this.archiveState(ctx, chat.id)?.state === 'sending') return unknown();
      if (command.action === 'delete_chat') {
        if (chat.status === 'sending') return failure('CONFLICT', '模型仍在处理中，暂不能清理。', 'wait_for_operation');
        this.journal.transaction(() => { this.put(ctx, 'chat', chat.id, null); this.putOperation(ctx, command, hash, 'done', { deleted: true, physicalErasure: false, cnbArchiveDeleted: false }, null); });
        return { ok: true, data: { deleted: true, physicalErasure: false, cnbArchiveDeleted: false } };
      }
      if (chat.status !== 'ready') return unknown();
      if (command.action === 'archive') return await this.archive(ctx, chat, command, hash);
      const modelAccess = this.sessions.authorize(ctx, 'model:answer'); if (!modelAccess.ok) return modelAccess;
      if (!this.gateway.status().find((p) => p.id === command.provider)?.ready) return failure('NOT_CONFIGURED', '该模型尚未配置，未保存本条消息或发送。', 'configure_model');
      if (chat.messages.length >= 98 || chat.messages.reduce((n, m) => n + m.text.length, command.text.length) > 60000) return failure('VALIDATION', '会话已达到模型范围上限，未截断历史。', 'start_new_conversation');
      if (secrets(command.text)) return failure('VALIDATION', '消息含疑似密钥，请移除后发送。', 'redact_message');
      const row = this.record(ctx, 'chat', chat.id)!;
      const pending: MemoryChat = { ...chat, provider: command.provider, revision: chat.revision + 1, status: 'sending',
        messages: [...chat.messages, { id: command.operationId, role: 'user', text: command.text, createdAt: now() }] };
      delete pending.archivedConversationId;
      this.journal.transaction(() => { this.put(ctx, 'chat', chat.id, pending, row.version); this.putOperation(ctx, command, hash, 'sending', null, null); });
      const pendingVersion = this.record(ctx, 'chat', chat.id)!.version;
      const runningKey = this.runningKey(ctx, 'chat', chat.id);
      this.running.add(runningKey);
      let result: Awaited<ReturnType<ChatGateway['send']>>;
      try { result = await this.gateway.send(command.provider, pending.messages); }
      catch { result = failure('UNKNOWN_RESULT', '模型结果未知。', 'read_original_operation', 'unknown'); }
      finally { this.running.delete(runningKey); }
      const current = this.readChat(ctx, chat.id), currentRow = this.record(ctx, 'chat', chat.id);
      if (!current || current.revision !== pending.revision || currentRow?.version !== pendingVersion) return unknown();
      const finalAccess = this.sessions.authorize(ctx, 'model:answer');
      if (!result.ok || !finalAccess.ok || !z.string().min(1).max(24000).safeParse(result.data.text).success) {
        this.put(ctx, 'chat', chat.id, { ...pending, status: 'unknown' }, pendingVersion); return unknown();
      }
      const saved: MemoryChat = { ...pending, revision: pending.revision + 1, status: 'ready', messages: [...pending.messages, { id: `${command.operationId}:assistant`, role: 'assistant', text: result.data.text, createdAt: now() }] };
      this.journal.transaction(() => { this.put(ctx, 'chat', chat.id, ChatSchema.parse(saved), pendingVersion); this.putOperation(ctx, command, hash, 'done', { id: chat.id }); });
      return { ok: true, data: saved };
    } catch { return unknown(); }
  }
  private async archive(ctx: RequestContext, chat: MemoryChat, command: Extract<IntelligenceCommand, { action: 'archive' }>, hash: string): Promise<Result<unknown>> {
    if (!chat.messages.length) return failure('VALIDATION', '空会话不能沉淀。', 'continue_conversation');
    if (chat.archivedConversationId) return failure('CONFLICT', '这份会话已归档，请使用原知识交接入口。', 'read_conversation');
    const conversation: Conversation = { id: `chat-${command.operationId}`, workspaceId: ctx.workspaceId, taskId: `task-${chat.id}`, origin: 'manual', sourceAlreadyPersisted: false,
      segments: chat.messages.map((m) => ({ id: m.id, role: m.role, text: m.text })), contentHash: '', createdAt: now(), state: 'preview' };
    conversation.contentHash = await hashConversation(conversation);
    const claim = { operationId: command.operationId, chatId: chat.id, chatRevision: chat.revision,
      conversationId: conversation.id, contentHash: conversation.contentHash, state: 'sending' as const };
    const claimed = this.journal.transaction((): Result<true> => {
      const current = this.readChat(ctx, chat.id);
      if (!current || current.revision !== chat.revision || current.status !== 'ready' || this.archiveState(ctx, chat.id)?.state === 'sending') return unknown();
      const allowed = this.sessions.authorize(ctx, 'conversation:write'); if (!allowed.ok) return allowed;
      this.put(ctx, 'archive', chat.id, claim);
      this.putOperation(ctx, command, hash, 'sending', { conversationId: conversation.id }, null);
      return { ok: true, data: true };
    });
    if (!claimed.ok) return claimed;
    const runningKey = this.runningKey(ctx, 'archive', command.operationId); this.running.add(runningKey);
    const fail = (result: Result<unknown>) => {
      if (!result.ok && result.error.dataState === 'not_written') this.journal.transaction(() => {
        this.put(ctx, 'archive', chat.id, { ...claim, state: 'failed' });
        this.putOperation(ctx, command, hash, 'failed', null);
      });
      return result;
    };
    try {
      const approved = await this.services().approveConversation!(ctx, { conversation, baseRevision: 'new', operationId: command.operationId, confirmed: true });
      if (!approved.ok) return fail(approved);
      const saved = await this.services().saveConversation(ctx, conversation, approved.data);
      return saved.ok ? this.finishArchive(ctx, claim, saved.data) : fail(saved);
    } finally { this.running.delete(runningKey); }
  }
  private async checkRun(ctx: RequestContext, run: TrainingRun): Promise<Result<true>> {
    const snapshot = await this.services().snapshot(ctx); if (!snapshot.ok) return snapshot;
    if (!run.nodeRefs.length || run.nodeRefs.some((ref) => snapshot.data.excludedIds.includes(ref.id) || !snapshot.data.nodes.some((n) => n.id === ref.id && n.revision === ref.revision && n.lifecycle === 'active' && n.confirmation === 'confirmed')))
      return failure('CONFLICT', '训练来源已更新、删除或撤回，适配器已停止使用。', 'retrain_from_current_sources');
    return { ok: true, data: true };
  }
  private async train(ctx: RequestContext, command: Extract<IntelligenceCommand, { action: 'train' }>, hash: string): Promise<Result<unknown>> {
    if (!this.executor.ready() || (command.mode === 'lora' && !this.executor.pretrainedReady())) return failure('NOT_CONFIGURED', '训练环境或本地预训练权重尚未就绪。', 'configure_training');
    if (command.mode === 'smoke' && command.nodeIds.length) return failure('VALIDATION', '结构验证只使用内置合成样本，不读取私人知识。', 'clear_selected_nodes');
    this.runs(ctx);
    if (this.journal.hasActiveIntelligenceTraining(ctx.workspaceId)) return failure('CONFLICT', '当前工作区已有训练任务，或原进程仍待核验。', 'verify_training_process');
    const source = command.mode === 'lora' ? await this.samples(ctx, command.nodeIds) : { ok: true as const, data: { samples: [] as TrainingSample[], refs: [] as TrainingRun['nodeRefs'] } };
    if (!source.ok) return source;
    if (command.mode === 'lora' && source.data.refs.some((ref) => command.nodeRevisions[ref.id] !== ref.revision))
      return failure('CONFLICT', '知识版本与确认范围不一致，请重新读取后选择。', 'select_current_knowledge');
    if (command.mode === 'lora' && new Set(source.data.samples.map((s) => s.groupId)).size < 2) return failure('VALIDATION', '需要至少两段不同对话的已确认知识，才能隔离训练集与验证集。', 'collect_confirmed_examples');
    const settings = this.settings(ctx);
    if (settings.revision !== command.expectedRevision) return failure('CONFLICT', '构建训练集期间权重已变化。', 'reload_settings');
    const access = this.sessions.authorize(ctx, 'settings:write'); if (!access.ok) return access;
    const run: TrainingRun = { id: command.operationId, state: 'running', mode: command.mode, createdAt: now(), datasetHash: digest(source.data.samples), settingsRevision: settings.revision,
      sampleCount: command.mode === 'smoke' ? 16 : source.data.samples.length, nodeRefs: source.data.refs, message: command.mode === 'smoke' ? '合成数据、随机初始化 GPT-2、真实 LoRA 梯度训练。' : '仅训练已确认的授权样本。' };
    if (command.mode === 'lora') { const fresh = await this.checkRun(ctx, run); if (!fresh.ok) return fresh; }
    const claimed = this.journal.transaction((): Result<true> => {
      const currentAccess = this.sessions.authorize(ctx, 'settings:write'); if (!currentAccess.ok) return currentAccess;
      if (this.settings(ctx).revision !== command.expectedRevision) return failure('CONFLICT', '训练启动前权重设置已变化。', 'reload_settings');
      if (this.journal.hasActiveIntelligenceTraining(ctx.workspaceId)) return failure('CONFLICT', '当前工作区已有训练任务，或原进程仍待核验。', 'verify_training_process');
      if (this.journal.hasIntelligenceTrainingIdentity(ctx.workspaceId, run.id)) return failure('CONFLICT', '此训练标识已被工作区中的原操作使用。', 'use_new_operation');
      const blocked = new Set(this.journal.blocked(ctx.workspaceId));
      if (run.nodeRefs.some((ref) => blocked.has(ref.id))) return failure('CONFLICT', '训练来源已删除。', 'select_current_knowledge');
      this.put(ctx, 'run', run.id, run, null); this.putOperation(ctx, command, hash, 'done', run, null);
      return { ok: true, data: true };
    });
    if (!claimed.ok) return claimed;
    const runningKey = this.runningKey(ctx, 'train', run.id);
    this.running.add(runningKey);
    void Promise.resolve().then(() => this.executor.run({ workspace: ctx.workspaceId, mode: ctx.mode as 'fixture' | 'live', run, settings: settings.settings, samples: source.data.samples })).then((supplied) => {
      const metrics = TrainingRunSchema.shape.metrics.unwrap().parse(supplied);
      if (metrics.parameterDelta <= 0 || metrics.weightEffect <= 0 || !metrics.reloadVerified) throw Error('Training verification failed');
      this.put(ctx, 'run', run.id, { ...run, state: 'completed', completedAt: now(), metrics,
        message: run.mode === 'smoke' ? '结构验证完成；不代表中文知识提取能力，不可启用为生产模型。' : '训练完成，尚未启用；验证损失不等于实际知识质量。' });
    }).catch((error) => { try { this.put(ctx, 'run', run.id, { ...run, state: 'failed', completedAt: now(), message: error instanceof TrainingFailure
      ? error.message : '训练失败或输入超过范围；未启用模型。请检查本地模型和训练环境。' }); } catch { /* Closed storage cannot turn a failed job into success. */ } })
      .finally(() => this.running.delete(runningKey));
    return { ok: true, data: run };
  }
  modelTransport(fallback: ModelTransport): ModelTransport {
    return { mode: fallback.mode,
      ready: (ctx) => {
        if (!ctx) return fallback.ready?.() ?? { ok: true, data: true };
        const active = this.record(ctx, 'active', 'current')?.value;
        return active || this.gateway.status().find((p) => p.id === this.settings(ctx).settings.provider)?.ready ? { ok: true, data: true } : failure('NOT_CONFIGURED', '所选 AI 尚未配置。', 'configure_model');
      },
      complete: async (ctx, input) => {
        const active = this.record(ctx, 'active', 'current')?.value as { id: string } | null | undefined;
        if (input.purpose === 'extract' && active) {
          const run = this.run(ctx, active.id); if (!run || run.state !== 'completed') return failure('CONFLICT', '适配器记录不存在或已停用。', 'select_model');
          const valid = await this.checkRun(ctx, run); if (!valid.ok) return valid;
          try {
            const value = CandidateOutputSchema.parse(await this.executor.infer(ctx.workspaceId, ctx.mode as 'fixture' | 'live', run.id, input.text));
            const stillValid = await this.checkRun(ctx, run); if (!stillValid.ok) return stillValid;
            const current = this.record(ctx, 'active', 'current')?.value as { id: string } | null | undefined;
            if (current?.id !== run.id || this.run(ctx, run.id)?.state !== 'completed') return failure('CONFLICT', '推理期间适配器已切换或停用，结果未采用。', 'select_model');
            return { ok: true, data: { value, modelId: `local-lora:${run.id}`, generatedAt: now() } };
          } catch { return failure('UPSTREAM', '本地模型未产生合法候选；未入库，可继续人工交接。', 'continue_manually', 'preserved'); }
        }
        const provider = this.settings(ctx).settings.provider;
        if (provider === 'cnb') return fallback.complete(ctx, input);
        const result = await this.gateway.send(provider, [{ role: 'user', text: input.text }], true); if (!result.ok) return result;
        try { return { ok: true, data: { value: JSON.parse(result.data.text), modelId: result.data.modelId, generatedAt: now() } }; }
        catch { return failure('UPSTREAM', '模型输出不是有效结构化数据。', 'continue_manually', 'preserved'); }
      } };
  }
}
