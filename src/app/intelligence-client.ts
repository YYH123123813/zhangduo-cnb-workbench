import { useEffect, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { ApiError, ApiResponse, Result } from '../contracts/api';
import {
  ChatSchema, IntelligenceCommandSchema, IntelligenceOverviewSchema, IntelligenceOperationSchema, IntelligenceSettingsSchema, TrainingRunSchema,
  type IntelligenceOverview, type MemoryChat, type IntelligenceOperation,
} from '../contracts/intelligence';
import { contentHash } from '../contracts/hash';
import { apiRequest } from './api-client';
import { operationReceiptMatches, operationRecovery, recoverFromChat, settingsEqual, uncertainError, type IntelligenceMutation, type PendingOperation } from './intelligence-ui-state';

type Request = (path: string, init?: RequestInit) => Promise<ApiResponse<unknown>>;
interface ClientState {
  data: IntelligenceOverview | null;
  message: string;
  error: ApiError | null;
  busy: boolean;
  refreshing: boolean;
  readingChat: boolean;
  readingOperation: boolean;
  verified: boolean;
  denied: boolean;
  accessVersion: number;
  unresolved: PendingOperation | null;
}
const unknownError = (): ApiError => ({ code: 'UNKNOWN_RESULT', message: '操作结果尚未核验。保留原操作，只能只读核验，不能重复提交。',
  retryable: false, dataState: 'unknown', nextAction: 'read_original_operation' });
const errorSchema = z.object({ code: z.enum(['NOT_IMPLEMENTED', 'NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION', 'CONFLICT', 'UNKNOWN_RESULT', 'UPSTREAM', 'INTERNAL']),
  message: z.string(), retryable: z.boolean(), dataState: z.enum(['not_written', 'preserved', 'partial', 'unknown']), nextAction: z.string() });
export const SettingsReceiptSchema = z.object({ revision: z.number().int().positive(), settings: IntelligenceSettingsSchema }).strict();

function mutationValue(command: IntelligenceMutation, value: unknown): unknown {
  switch (command.action) {
    case 'send': case 'create_chat': {
      const chat = ChatSchema.parse(value);
      if (!recoverFromChat(command, chat)) throw Error('Mismatched chat receipt');
      return chat;
    }
    case 'settings': {
      const saved = SettingsReceiptSchema.parse(value);
      if (saved.revision !== command.expectedRevision + 1 || !settingsEqual(saved.settings, command.settings)) throw Error('Mismatched settings receipt');
      return saved;
    }
    case 'train': {
      const run = TrainingRunSchema.parse(value);
      if (run.id !== command.operationId || run.mode !== command.mode || run.settingsRevision !== command.expectedRevision
        || run.nodeRefs.some((ref) => command.nodeRevisions[ref.id] !== ref.revision)) throw Error('Mismatched training receipt');
      return run;
    }
    case 'archive': {
      const receipt = z.object({ conversationId: z.string(), issueNumber: z.number().optional(), taskId: z.string().optional() }).strict().parse(value);
      if (receipt.conversationId !== `chat-${command.operationId}`) throw Error('Mismatched archive receipt');
      return receipt;
    }
    case 'activate': case 'deactivate': {
      const receipt = z.object({ id: z.string().nullable() }).strict().parse(value);
      if (receipt.id !== (command.action === 'activate' ? command.id : null)) throw Error('Mismatched activation receipt');
      return receipt;
    }
    case 'delete_chat': return z.object({ deleted: z.literal(true), physicalErasure: z.literal(false), cnbArchiveDeleted: z.literal(false) }).strict().parse(value);
    case 'delete_run': return z.object({ deleted: z.literal(true), physicalErasure: z.literal(false) }).strict().parse(value);
  }
}

export class IntelligenceClient {
  private state: ClientState = { data: null, message: '', error: null, busy: false, refreshing: false, readingChat: false, readingOperation: false,
    verified: false, denied: false, accessVersion: 0, unresolved: null };
  private listeners = new Set<() => void>();
  private active = true;
  private epoch = 0;
  private overviewSequence = 0;
  private chatSequence = 0;
  private operationSequence = 0;
  private overviewController?: AbortController;
  private chatController?: AbortController;
  private mutationController?: AbortController;
  private operationController?: AbortController;
  constructor(private readonly request: Request = apiRequest<unknown>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<ClientState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private abort() { this.overviewController?.abort(); this.chatController?.abort(); this.mutationController?.abort(); this.operationController?.abort(); }
  activate = () => { this.active = true; };
  dispose = () => { this.active = false; this.epoch++; this.abort(); };
  setMessage = (message: string) => this.patch({ message });
  private current(epoch: number) { return this.active && epoch === this.epoch; }
  private revoked(error: ApiError, pending = this.state.unresolved): boolean {
    if (!['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)) return false;
    this.epoch++; this.abort();
    this.patch({ data: null, message: '工作区授权已失效，已隐藏本页内容。请重新核对工作区身份。', error, busy: false,
      refreshing: false, readingChat: false, readingOperation: false, verified: false, denied: true,
      unresolved: pending ? { ...pending, command: null } : null, accessVersion: this.state.accessVersion + 1 });
    return true;
  }
  private async fetch(path: string, controller: AbortController, init?: RequestInit): Promise<ApiResponse<unknown>> {
    const timeout = setTimeout(() => controller.abort(), init?.method === 'POST' ? 90000 : 15000);
    try { return await this.request(path, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }

  refresh = async (): Promise<IntelligenceOverview | null> => {
    if (!this.active || this.state.busy) return null;
    const epoch = this.epoch, sequence = ++this.overviewSequence;
    this.overviewController?.abort(); const controller = new AbortController(); this.overviewController = controller;
    this.patch({ refreshing: true });
    try {
      const result = await this.fetch('/api/intelligence', controller);
      if (!this.current(epoch)) return null;
      if (!result.ok) {
        const error = errorSchema.parse(result.error);
        if (this.revoked(error) || sequence !== this.overviewSequence) return null;
        this.patch({ error, message: error.message, verified: false }); return null;
      }
      if (sequence !== this.overviewSequence || controller.signal.aborted) return null;
      const data = IntelligenceOverviewSchema.parse(result.data);
      this.patch({ data, verified: true, denied: false });
      return data;
    } catch {
      if (this.current(epoch) && sequence === this.overviewSequence) this.patch({ verified: false, message: '暂时无法核对服务器状态。保留草稿，变更操作已暂停。' });
      return null;
    } finally { if (this.current(epoch) && sequence === this.overviewSequence) this.patch({ refreshing: false }); }
  };

  readChat = async (id: string): Promise<MemoryChat | null> => {
    if (!this.active || this.state.busy || this.state.denied) return null;
    const epoch = this.epoch, sequence = ++this.chatSequence;
    this.chatController?.abort(); const controller = new AbortController(); this.chatController = controller;
    this.patch({ readingChat: true });
    try {
      const result = await this.fetch(`/api/intelligence/chats/${encodeURIComponent(id)}`, controller);
      if (!this.current(epoch)) return null;
      if (!result.ok) {
        const error = errorSchema.parse(result.error);
        if (this.revoked(error) || sequence !== this.chatSequence) return null;
        this.patch({ error, message: error.message }); return null;
      }
      if (sequence !== this.chatSequence || controller.signal.aborted) return null;
      const chat = ChatSchema.parse(result.data);
      if (chat.id !== id) throw Error('Mismatched chat');
      return chat;
    } catch {
      if (this.current(epoch) && sequence === this.chatSequence) this.patch({ message: '会话读取失败，草稿仍保留；未发送任何消息。' });
      return null;
    } finally { if (this.current(epoch) && sequence === this.chatSequence) this.patch({ readingChat: false }); }
  };

  readOperation = async (): Promise<IntelligenceOperation | null> => {
    const command = this.state.unresolved;
    if (!this.active || !command || this.state.busy || this.state.denied) return null;
    const epoch = this.epoch, sequence = ++this.operationSequence;
    this.operationController?.abort(); const controller = new AbortController(); this.operationController = controller;
    this.patch({ readingOperation: true });
    try {
      const result = await this.fetch(`/api/intelligence/operations/${encodeURIComponent(command.operationId)}`, controller);
      if (!this.current(epoch)) return null;
      if (!result.ok) {
        const error = errorSchema.parse(result.error);
        if (this.revoked(error) || sequence !== this.operationSequence) return null;
        this.patch({ error, message: `原操作核验失败：${error.message}。不会重发。` }); return null;
      }
      const receipt = IntelligenceOperationSchema.parse(result.data);
      if (!this.current(epoch) || sequence !== this.operationSequence || controller.signal.aborted) return null;
      if (!operationReceiptMatches(command, receipt)) {
        this.patch({ message: receipt.state === 'not_found' ? '未找到原操作回执，不能据此认定未执行；保持只读核验。'
          : receipt.state === 'pending' ? '原操作仍在处理中，未重复提交。' : '原操作回执尚未完成或绑定不匹配，不能再次提交。' });
        return null;
      }
      this.patch({ unresolved: null, error: null, message: receipt.state === 'completed' ? '原操作完成回执已核验，未重复提交。' : '原操作失败回执已核验，未自动重试。再次操作需要重新确认。' });
      return receipt;
    } catch {
      if (this.current(epoch) && sequence === this.operationSequence) this.patch({ message: '原操作回执暂不可读，保留原操作，不会重复提交。' });
      return null;
    } finally { if (this.current(epoch) && sequence === this.operationSequence) this.patch({ readingOperation: false }); }
  };

  execute = async (input: IntelligenceMutation): Promise<Result<unknown> | null> => {
    if (!this.active || this.state.busy || this.state.refreshing || this.state.readingChat || this.state.readingOperation || this.state.unresolved || !this.state.verified || this.state.denied) return null;
    const parsed = IntelligenceCommandSchema.safeParse(input);
    if (!parsed.success || !('operationId' in parsed.data)) {
      const error: ApiError = { code: 'VALIDATION', message: '参数或独立确认不完整，未提交。', dataState: 'not_written', retryable: false, nextAction: 'review_input' };
      this.patch({ error, message: error.message }); return { ok: false, error };
    }
    const epoch = this.epoch, command = structuredClone(parsed.data);
    const controller = new AbortController(); this.mutationController = controller;
    this.patch({ busy: true, error: null, message: '' });
    let pending: PendingOperation | null = null;
    try {
      // Keep only receipt metadata if the trusted page binding is lost after dispatch.
      pending = { ...operationRecovery(command, await contentHash(command)), command };
      if (!this.current(epoch) || controller.signal.aborted) return null;
      const result = await this.fetch('/api/intelligence', controller, { method: 'POST', body: JSON.stringify(command) });
      if (!this.current(epoch)) return null;
      if (!result.ok) {
        const error = errorSchema.parse(result.error);
        if (this.revoked(error, uncertainError(error) ? pending : null)) return null;
        this.patch({ error, message: error.message, unresolved: uncertainError(error) ? pending : null });
        return { ok: false, error };
      }
      if (controller.signal.aborted) throw Error('Response deadline exceeded');
      const value = mutationValue(command, result.data);
      return { ok: true, data: value };
    } catch {
      if (!this.current(epoch)) return null;
      const error: ApiError = pending ? unknownError() : { code: 'INTERNAL', message: '无法生成原操作摘要，未提交。', dataState: 'not_written', retryable: false, nextAction: 'verify_browser' };
      this.patch({ error, message: error.message, unresolved: pending });
      return { ok: false, error };
    } finally { if (this.current(epoch)) this.patch({ busy: false }); }
  };
}

export function useIntelligence() {
  const [client] = useState(() => new IntelligenceClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    client.activate(); void client.refresh();
    const verify = () => { if (!document.hidden) void client.refresh(); };
    window.addEventListener('focus', verify);
    return () => { window.removeEventListener('focus', verify); client.dispose(); };
  }, [client]);
  return { ...state, refresh: client.refresh, readChat: client.readChat, readOperation: client.readOperation, execute: client.execute, setMessage: client.setMessage };
}
