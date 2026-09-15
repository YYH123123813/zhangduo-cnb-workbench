import type { ApiError } from '../contracts/api';
import {
  IntelligenceSettingsSchema, trainingWeight, type IntelligenceCommand, type IntelligenceOverview,
  type IntelligenceSettings, type MemoryChat, type TrainingRun, type IntelligenceOperation, type IntelligenceMutation,
} from '../contracts/intelligence';

export type { IntelligenceMutation } from '../contracts/intelligence';
export type NodeSelection = Record<string, string>;
export interface SettingsDraft { baseRevision: number; baseSettings: IntelligenceSettings; value: IntelligenceSettings }
export interface TrainingApproval {
  fingerprint: string;
  expectedRevision: number;
  mode: 'smoke' | 'lora';
  nodeIds: string[];
  nodeRevisions: NodeSelection;
}
export interface OperationRecovery {
  operationId: string;
  action: IntelligenceMutation['action'];
  targetId: string | null;
  requestHash: string;
  expectedRevision?: number;
}
export interface PendingOperation extends OperationRecovery { command: IntelligenceMutation | null }

export function settingsEqual(a: IntelligenceSettings, b: IntelligenceSettings): boolean {
  const stable = (s: IntelligenceSettings) => JSON.stringify({ ...s, importance: Object.entries(s.importance).sort(([a], [b]) => a.localeCompare(b)) });
  return stable(a) === stable(b);
}

export function settingsDraft(data: Pick<IntelligenceOverview, 'revision' | 'settings'>): SettingsDraft {
  return { baseRevision: data.revision, baseSettings: structuredClone(data.settings), value: structuredClone(data.settings) };
}

export function reconcileSettingsDraft(draft: SettingsDraft | null, data: IntelligenceOverview): SettingsDraft {
  if (!draft || (settingsEqual(draft.value, draft.baseSettings) && draft.baseRevision !== data.revision)) return settingsDraft(data);
  return draft;
}

export function intelligenceLeaveState(busy: boolean, unknown: boolean, drafts: readonly string[]): 'clean' | 'dirty' | 'blocked' {
  return busy || unknown ? 'blocked' : drafts.some((draft) => draft.length > 0) ? 'dirty' : 'clean';
}

export function settleConversationDraft(drafts: Record<string, string>, id: string, submitted: string, saved: boolean): Record<string, string> {
  return saved && drafts[id] === submitted ? { ...drafts, [id]: '' } : drafts;
}

export function uncertainError(error: ApiError): boolean {
  return error.code === 'UNKNOWN_RESULT' || error.dataState === 'unknown' || error.dataState === 'partial'
    || (error.dataState === 'preserved' && ['UPSTREAM', 'INTERNAL'].includes(error.code));
}

export function chatSendBlockReason(chat: MemoryChat, text: string, ready: boolean): string | null {
  if (chat.status !== 'ready') return '原发送结果待核验，不能再次发送。';
  if (!ready) return '所选模型在服务端尚未配置。';
  if (!text.trim()) return '消息不能为空。';
  if (text.trim().length > 12000) return '单条消息最多 12000 字符。';
  if (chat.messages.length >= 98 || chat.messages.reduce((length, entry) => length + entry.text.length, text.trim().length) > 60000)
    return '会话已达到模型范围上限，请新建会话；历史不会被截断。';
  return null;
}

// Validate chat response bodies; settling an unknown write still requires the original operation receipt.
export function recoverFromChat(command: IntelligenceMutation, chat: MemoryChat): boolean {
  if (command.action === 'create_chat') return chat.id === command.operationId;
  if (!('id' in command) || command.id !== chat.id) return false;
  if (command.action === 'send') return chat.status === 'ready' && chat.revision >= command.expectedRevision + 2
    && chat.messages.some((entry) => entry.id === command.operationId && entry.role === 'user' && entry.text === command.text.trim())
    && chat.messages.some((entry) => entry.id === `${command.operationId}:assistant` && entry.role === 'assistant');
  return command.action === 'archive' && chat.revision > command.expectedRevision && chat.archivedConversationId === `chat-${command.operationId}`;
}

export function operationRecovery(command: IntelligenceMutation, requestHash: string): OperationRecovery {
  return { operationId: command.operationId, action: command.action, requestHash,
    targetId: 'id' in command ? command.id : ['create_chat', 'train'].includes(command.action) ? command.operationId : null,
    ...('expectedRevision' in command ? { expectedRevision: command.expectedRevision } : {}) };
}

export function operationReceiptMatches(original: OperationRecovery, receipt: IntelligenceOperation): boolean {
  if (receipt.operationId !== original.operationId || receipt.action !== original.action || receipt.requestHash !== original.requestHash || receipt.targetId !== original.targetId) return false;
  if (receipt.state === 'failed') return true;
  if (receipt.state !== 'completed' || !receipt.result) return false;
  const result = receipt.result;
  switch (original.action) {
    case 'settings': return original.expectedRevision !== undefined && result.revision === original.expectedRevision + 1;
    case 'create_chat': return result.chatId === original.operationId;
    case 'send': return result.chatId === original.targetId;
    case 'archive': return result.conversationId === `chat-${original.operationId}`;
    case 'train': return result.runId === original.operationId;
    case 'activate': return result.activeRunId === original.targetId;
    case 'deactivate': return result.activeRunId === null;
    case 'delete_chat': return result.deleted === true && result.physicalErasure === false && result.cnbArchiveDeleted === false;
    case 'delete_run': return result.deleted === true && result.physicalErasure === false;
  }
}

function trainingFingerprint(data: IntelligenceOverview, mode: TrainingApproval['mode'], selected: NodeSelection): string {
  const entries = Object.entries(selected).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([data.revision, data.settings, mode, data.training, entries, entries.map(([id]) => {
    const node = data.samples.find((sample) => sample.id === id);
    return node ? [id, node.revision, node.uses, node.corrected, trainingWeight(data.settings, node)] : [id, null];
  })]);
}

export function trainingBlockReason(data: IntelligenceOverview, mode: TrainingApproval['mode'], selected: NodeSelection): string | null {
  if (!IntelligenceSettingsSchema.safeParse(data.settings).success) return '设置参数无效。';
  if (!data.training.ready) return '训练环境未配置。';
  if (data.runs.some((run) => run.state === 'running')) return '已有训练正在运行。';
  if (mode === 'smoke') return null;
  if (!data.training.pretrainedReady) return '本地预训练模型未就绪。';
  if (data.samplesStatus?.state === 'unavailable') return data.samplesStatus.message || '节点来源暂不可用，不能开始个人知识训练。';
  const entries = Object.entries(selected);
  if (entries.length < 2 || entries.length > 100) return '请选择 2 至 100 个节点；不同对话来源由服务端核验。';
  if (entries.some(([id, revision]) => !data.samples.some((node) => node.id === id && node.revision === revision))) return '选中节点已变化或不可用，请重新选择版本。';
  if (entries.some(([id]) => trainingWeight(data.settings, data.samples.find((node) => node.id === id)!) <= 0)) return '选中节点含零权重，请调整权重或取消选择。';
  return null;
}

export function captureTrainingApproval(data: IntelligenceOverview, mode: TrainingApproval['mode'], selected: NodeSelection): TrainingApproval | null {
  if (trainingBlockReason(data, mode, selected)) return null;
  return { fingerprint: trainingFingerprint(data, mode, selected), expectedRevision: data.revision, mode,
    nodeIds: mode === 'smoke' ? [] : Object.keys(selected).sort(), nodeRevisions: mode === 'smoke' ? {} : { ...selected } };
}

export function isTrainingApprovalCurrent(approval: TrainingApproval | null, data: IntelligenceOverview, mode: TrainingApproval['mode'], selected: NodeSelection): boolean {
  return Boolean(approval && !trainingBlockReason(data, mode, selected) && approval.fingerprint === trainingFingerprint(data, mode, selected));
}

export function buildTrainingCommand(approval: TrainingApproval | null, data: IntelligenceOverview, mode: TrainingApproval['mode'], selected: NodeSelection, operationId: string): Extract<IntelligenceCommand, { action: 'train' }> | null {
  if (!approval || !isTrainingApprovalCurrent(approval, data, mode, selected)) return null;
  return { action: 'train', operationId, confirmed: true, trainingConsent: true, mode: approval.mode,
    expectedRevision: approval.expectedRevision, nodeIds: [...approval.nodeIds], nodeRevisions: { ...approval.nodeRevisions } };
}

export function activationBlockReason(run: TrainingRun, samples: IntelligenceOverview['samples']): string | null {
  if (run.mode === 'smoke') return '合成结构验证不可启用为生产提取器。';
  if (run.state !== 'completed') return '训练尚未完成，不能启用。';
  const metrics = run.metrics;
  if (!metrics?.reloadVerified || !metrics.validationGroups || metrics.heldOutBefore === null || metrics.heldOutAfter === null
    || metrics.heldOutAfter > metrics.heldOutBefore) return '重载或独立验证未满足试用条件。';
  if (!run.nodeRefs.length || run.nodeRefs.some((ref) => !samples.some((sample) => sample.id === ref.id && sample.revision === ref.revision))) return '训练来源已变化或不可用，不能启用此版本。';
  return null;
}
