import { describe, expect, it } from 'vitest';
import { DEFAULT_INTELLIGENCE, trainingWeight, type IntelligenceOverview, type MemoryChat, type TrainingRun } from '../contracts/intelligence';
import {
  activationBlockReason, buildTrainingCommand, captureTrainingApproval, chatSendBlockReason,
  intelligenceLeaveState, isTrainingApprovalCurrent, reconcileSettingsDraft, recoverFromChat,
  operationRecovery, operationReceiptMatches, settingsDraft, settingsEqual, settleConversationDraft, uncertainError,
} from './intelligence-ui-state';

const operationId = '11111111-1111-4111-8111-111111111111';
const overview = (): IntelligenceOverview => ({ revision: 2, settings: structuredClone(DEFAULT_INTELLIGENCE),
  providers: [{ id: 'cnb', ready: true, model: 'fixture-only' }], training: { ready: true, pretrainedReady: true, activeRunId: null },
  samples: [{ id: 'a', revision: 'fixture-a', title: 'A', uses: 0, corrected: false, weight: 1 },
    { id: 'b', revision: 'fixture-b', title: 'B', uses: 1, corrected: true, weight: 2 }], runs: [], chats: [] });
const chat = (): MemoryChat => ({ id: 'chat-a', title: 'Synthetic', revision: 1, messages: [], status: 'ready', provider: 'cnb',
  createdAt: '2026-09-16T00:00:00Z', expiresAt: '2026-10-16T00:00:00Z' });
const send = { action: 'send' as const, id: 'chat-a', expectedRevision: 1, text: 'synthetic draft', provider: 'cnb' as const,
  confirmed: true as const, modelConsent: true as const, operationId };

describe('intelligence unknown operations and drafts', () => {
  it('never treats an unchanged ready chat or a different reply as recovery', () => {
    expect(recoverFromChat(send, chat())).toBe(false);
    const pending = { ...chat(), revision: 2, status: 'unknown' as const,
      messages: [{ id: operationId, role: 'user' as const, text: send.text, createdAt: chat().createdAt }] };
    expect(recoverFromChat(send, pending)).toBe(false);
    expect(recoverFromChat(send, { ...pending, status: 'ready', revision: 3,
      messages: [...pending.messages, { id: `${operationId}:assistant`, role: 'assistant', text: 'fixture reply', createdAt: chat().createdAt }] })).toBe(true);
    expect(recoverFromChat(send, { ...pending, id: 'another' })).toBe(false);
  });
  it('requires the exact archive operation reference, not any archive', () => {
    const command = { action: 'archive' as const, id: 'chat-a', expectedRevision: 1, operationId, confirmed: true as const };
    expect(recoverFromChat(command, { ...chat(), revision: 2, archivedConversationId: 'other' })).toBe(false);
    expect(recoverFromChat(command, { ...chat(), revision: 2, archivedConversationId: `chat-${operationId}` })).toBe(true);
  });
  it('keeps only non-body metadata for recovery and requires its exact receipt', () => {
    const recovery = operationRecovery(send, 'a'.repeat(64));
    expect(recovery).toEqual({ operationId, action: 'send', targetId: 'chat-a', expectedRevision: 1, requestHash: 'a'.repeat(64) });
    const receipt = { operationId, action: 'send' as const, targetId: 'chat-a', requestHash: 'a'.repeat(64), state: 'completed' as const,
      result: { chatId: 'chat-a' }, updatedAt: chat().createdAt, readOnly: true as const, absenceIsFinal: false as const };
    expect(operationReceiptMatches(recovery, receipt)).toBe(true);
    expect(operationReceiptMatches(recovery, { ...receipt, requestHash: 'b'.repeat(64) })).toBe(false);
    expect(operationReceiptMatches(recovery, { ...receipt, state: 'not_found', result: null })).toBe(false);
    expect(operationReceiptMatches(recovery, { ...receipt, result: { chatId: 'other' } })).toBe(false);
  });
  it('blocks leaving for unknown or in-flight operations; all unsent drafts are dirty', () => {
    expect(intelligenceLeaveState(false, false, ['other chat draft', ''])).toBe('dirty');
    expect(intelligenceLeaveState(false, false, [' '])).toBe('dirty');
    expect(intelligenceLeaveState(false, true, [])).toBe('blocked');
    expect(intelligenceLeaveState(true, false, [])).toBe('blocked');
    expect(intelligenceLeaveState(false, false, [])).toBe('clean');
  });
  it('retains all drafts on failure/unknown and never clears edits made after submission', () => {
    const drafts = { a: 'submitted', b: 'another chat draft' };
    expect(settleConversationDraft(drafts, 'a', 'submitted', false)).toBe(drafts);
    expect(settleConversationDraft(drafts, 'a', 'submitted', true)).toEqual({ a: '', b: 'another chat draft' });
    const edited = { ...drafts, a: 'new local text' };
    expect(settleConversationDraft(edited, 'a', 'submitted', true)).toBe(edited);
  });
  it('distinguishes not-written errors from uncertain or partial results', () => {
    expect(uncertainError({ code: 'NOT_CONFIGURED', message: '', retryable: false, dataState: 'not_written', nextAction: '' })).toBe(false);
    expect(uncertainError({ code: 'UPSTREAM', message: '', retryable: false, dataState: 'partial', nextAction: '' })).toBe(true);
    expect(uncertainError({ code: 'UNKNOWN_RESULT', message: '', retryable: false, dataState: 'not_written', nextAction: '' })).toBe(true);
  });
  it('respects history and per-message limits without truncating history', () => {
    expect(chatSendBlockReason(chat(), 'x', true)).toBeNull();
    expect(chatSendBlockReason(chat(), 'x', false)).toContain('配置');
    expect(chatSendBlockReason(chat(), 'x'.repeat(12001), true)).not.toBeNull();
    expect(chatSendBlockReason({ ...chat(), status: 'unknown' }, 'x', true)).not.toBeNull();
    expect(chatSendBlockReason({ ...chat(), messages: Array.from({ length: 98 }, (_, n) => ({ id: `m${n}`, role: 'user', text: 'x', createdAt: chat().createdAt })) }, 'x', true)).not.toBeNull();
  });
});

describe('settings CAS and training consent', () => {
  it('preserves dirty values and the original revision on a newer server snapshot', () => {
    const data = overview(), draft = settingsDraft(data);
    draft.value.steps = 40;
    const newer = { ...data, revision: 3, settings: { ...data.settings, steps: 50 } };
    expect(reconcileSettingsDraft(draft, newer)).toBe(draft);
    expect(reconcileSettingsDraft(settingsDraft(data), newer)?.baseRevision).toBe(3);
  });
  it('compares importance maps independent of key ordering without masking NaN', () => {
    expect(settingsEqual({ ...DEFAULT_INTELLIGENCE, importance: { a: 1, b: 2 } }, { ...DEFAULT_INTELLIGENCE, importance: { b: 2, a: 1 } })).toBe(true);
    expect(settingsEqual({ ...DEFAULT_INTELLIGENCE, steps: NaN }, DEFAULT_INTELLIGENCE)).toBe(false);
  });
  it('sends only the exact approved settings and node revisions', () => {
    const data = overview(), selected = { a: 'fixture-a', b: 'fixture-b' };
    const approval = captureTrainingApproval(data, 'lora', selected)!;
    expect(approval).not.toBeNull();
    const command = buildTrainingCommand(approval, data, 'lora', selected, operationId)!;
    expect(command.expectedRevision).toBe(2);
    expect(command.nodeRevisions).toEqual(selected);
    data.samples[0]!.revision = 'fixture-a-new';
    expect(isTrainingApprovalCurrent(approval, data, 'lora', selected)).toBe(false);
    expect(buildTrainingCommand(approval, data, 'lora', selected, operationId)).toBeNull();
    expect(captureTrainingApproval(data, 'lora', selected)).toBeNull();
  });
  it('invalidates approval on runtime, weight evidence, settings, mode or selection change', () => {
    const data = overview(), selected = { a: 'fixture-a', b: 'fixture-b' };
    const approval = captureTrainingApproval(data, 'lora', selected)!;
    const changed = structuredClone(data); changed.samples[0]!.uses++;
    expect(isTrainingApprovalCurrent(approval, changed, 'lora', selected)).toBe(false);
    expect(isTrainingApprovalCurrent(approval, { ...data, revision: 3 }, 'lora', selected)).toBe(false);
    expect(isTrainingApprovalCurrent(approval, data, 'smoke', selected)).toBe(false);
    expect(isTrainingApprovalCurrent(approval, data, 'lora', { a: 'fixture-a' })).toBe(false);
    expect(isTrainingApprovalCurrent(approval, { ...data, training: { ...data.training, pretrainedReady: false } }, 'lora', selected)).toBe(false);
  });
  it('keeps smoke synthetic and refuses invalid or oversized lora selections', () => {
    const data = overview();
    const smoke = captureTrainingApproval(data, 'smoke', { a: 'fixture-a' })!;
    expect(buildTrainingCommand(smoke, data, 'smoke', { a: 'fixture-a' }, operationId)?.nodeRevisions).toEqual({});
    expect(captureTrainingApproval(data, 'lora', {})).toBeNull();
    expect(captureTrainingApproval(data, 'lora', { a: 'old', b: 'fixture-b' })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`n${i}`, 'r']));
    expect(captureTrainingApproval(data, 'lora', many)).toBeNull();
    data.settings.importance.a = 0;
    expect(trainingWeight(data.settings, data.samples[0]!)).toBe(0);
    expect(captureTrainingApproval(data, 'lora', { a: 'fixture-a', b: 'fixture-b' })).toBeNull();
  });
  it('does not interpret an unavailable knowledge catalog as ready training data', () => {
    const data = overview(); data.samplesStatus = { state: 'unavailable', message: 'Synthetic catalog failure' };
    expect(captureTrainingApproval(data, 'lora', { a: 'fixture-a', b: 'fixture-b' })).toBeNull();
    expect(captureTrainingApproval(data, 'smoke', {})).not.toBeNull();
  });
});

describe('training trial gates', () => {
  const run = (): TrainingRun => ({ id: operationId, mode: 'lora', state: 'completed', createdAt: chat().createdAt,
    datasetHash: 'fixture-hash', settingsRevision: 2, sampleCount: 2, nodeRefs: [{ id: 'a', revision: 'fixture-a' }], message: 'Synthetic',
    metrics: { beforeLoss: 2, afterLoss: 1, heldOutBefore: 2, heldOutAfter: 1, parameterDelta: 0.1, trainableParameters: 4,
      totalParameters: 10, steps: 5, weightEffect: 0.1, reloadVerified: true, validationGroups: 1 } });
  it('never offers production activation to smoke or unfinished runs', () => {
    expect(activationBlockReason({ ...run(), mode: 'smoke' }, overview().samples)).not.toBeNull();
    for (const state of ['running', 'failed', 'interrupted', 'deleted'] as const) expect(activationBlockReason({ ...run(), state }, overview().samples)).not.toBeNull();
  });
  it('requires reload, held-out evaluation and unchanged sources', () => {
    expect(activationBlockReason(run(), overview().samples)).toBeNull();
    expect(activationBlockReason({ ...run(), metrics: { ...run().metrics!, heldOutAfter: 3 } }, overview().samples)).not.toBeNull();
    expect(activationBlockReason({ ...run(), metrics: { ...run().metrics!, heldOutAfter: null } }, overview().samples)).not.toBeNull();
    expect(activationBlockReason(run(), [])).not.toBeNull();
  });
});
