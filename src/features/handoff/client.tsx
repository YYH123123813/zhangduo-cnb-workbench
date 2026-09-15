import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Download, FileCheck2, FileText, GitCommitHorizontal, Plus, RefreshCw, Save, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { ApiError, Result } from '../../contracts/api';
import type { HandoffOperationPin, NavigationProps } from '../../contracts/navigation';
import type { KnowledgeApprovalState } from '../../contracts/approval';
import { DispositionPicker } from './DispositionPicker';
import { acceptAI, assessSource, decide, evidenceStatus, isAICandidate, selectCandidate, setKeyCondition, sourceFor, writeStatement } from './model';
import type { Approval, CommitReceipt, KnowledgeSnapshot, SourceRecord } from '../../contracts/domain';
import type { DraftReceipt, DraftState } from '../../contracts/handoff';
import type { HandoffOperationReceipt, HandoffOperationSaveRequest } from '../../contracts/handoff-operation';
import { RelationEditor } from './RelationEditor';
import { toDraft } from './draft';
import { acknowledgeProgress, restoreProgressState, toProgress, verifyProgressReceipt, verifyProgressState } from './progress';
import type { PendingProgress, ProgressSaveResult } from './progress';
import { PreviewPanel } from './PreviewPanel';
import { invalidateSubmission, isSubmissionLocked, isUncertainWrite, newSubmission, settleApproval, settleReceiptRead, settleSubmission } from './submission';
import type { HandoffPreview } from './preview';
import { ResultPanel } from './ResultPanel';
import { ReceiptLookup } from './ReceiptLookup';
import { validateReceipt } from './receipt';
import { validateIssuedApproval } from './commit';
import { safeUrl } from './links';
import { canReplaceReview, hasItemEdits, hasLocalEdits, requestReviewExit, reviseItem, shouldWarnOnExit } from './client-state';
import { loadReviewTarget } from './load-target';
import { RequestGate } from './request-gate';
import { handoffBlockedError, handoffGuard, handoffOperationHash, matchesPinnedOperation } from './navigation';
import { buildHandoffOperationPin } from './operation-pin';
import { recoverApprovalState } from './approval-recovery';
import { makeOperationRequest } from './operation';
import { readSavedOperation, saveOperationSnapshot } from './operation-client';
import { OperationSavePanel, OriginalOperationLookup } from './OperationControls';
import type { Review, ReviewItem } from './model';
import './handoff.css';

export interface PageProps extends NavigationProps { params?: Record<string, string | undefined> }
function newOriginalSave(): { request: HandoffOperationSaveRequest | null; receipt: HandoffOperationReceipt | null; unknown: boolean } {
  return { request: null, receipt: null, unknown: false };
}
export function Page({ params, registerLeaveGuard, pinHandoffOperation }: PageProps = {}) {
  const [id, setId] = useState(params?.conversationId ?? '');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('unconfigured');
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [saveConsent, setSaveConsent] = useState(false);
  const [overwriteConsent, setOverwriteConsent] = useState(false);
  const [saveNotes, setSaveNotes] = useState<Record<string, string>>({});
  const [unknownDrafts, setUnknownDrafts] = useState<Record<string, PendingProgress>>({});
  const [savedComparisons, setSavedComparisons] = useState<Record<string, DraftState>>({});
  const [submission, setSubmission] = useState(newSubmission);
  const [commitConsent, setCommitConsent] = useState(false);
  const [originalConsent, setOriginalConsent] = useState(false);
  const [originalSave, setOriginalSave] = useState(newOriginalSave);
  const [pinning, setPinning] = useState(false);
  const [pinnedOperationHash, setPinnedOperationHash] = useState<string | null>(null);
  const [replaceConsent, setReplaceConsent] = useState(false);
  const [manualSelection, setManualSelection] = useState<string[]>([]);
  const requests = useRef(new RequestGate());
  const retainedOperation = useRef<HandoffOperationPin | null>(null);
  const locallyPinned = matchesPinnedOperation(params, retainedOperation.current);
  const originalRecovery = Boolean(params?.changeSetId || params?.operationHash) && !locallyPinned;
  const navigationState = useRef({ review, submission, unknownDrafts, busy, unknownOperation: originalSave.unknown });
  navigationState.current = { review, submission, unknownDrafts, busy, unknownOperation: originalSave.unknown };
  const loadedDraftId = useRef<string | undefined>(undefined);
  const item = review?.items.find((entry) => entry.subject.id === review.activeId);
  const locked = isSubmissionLocked(submission) || originalSave.unknown;
  function beginRequest(replaceableRead = false) {
    const ticket = replaceableRead ? requests.current.beginReplacingRead() : requests.current.begin();
    if (ticket !== null) { setBusy(true); setError(null); }
    return ticket;
  }
  function endRequest(ticket: number) {
    const ended = requests.current.finish(ticket);
    if (ended) setBusy(false);
    return ended;
  }
  function apply(result: Result<Review>) {
    if (result.ok) { setReview(result.data); setError(null); setSaveConsent(false); setOverwriteConsent(false); setCommitConsent(false); setSubmission(invalidateSubmission);
      setOriginalSave(newOriginalSave()); setOriginalConsent(false); setPinnedOperationHash(null); } else setError(result.error);
  }
  function updateItem(next: ReviewItem) {
    if (requests.current.pending || locked) return;
    if (review) setReview({ ...review, items: review.items.map((entry) => entry.subject.id === next.subject.id ? reviseItem(entry, next) : entry) });
    setError(null); setSaveConsent(false); setOverwriteConsent(false);
    setSubmission(invalidateSubmission);
    setOriginalSave(newOriginalSave()); setOriginalConsent(false); setPinnedOperationHash(null);
    setCommitConsent(false);
    setSaveNotes((notes) => ({ ...notes, [next.subject.id]: '本地编辑尚未保存' }));
  }
  function applyItem(result: Result<ReviewItem>) { if (result.ok) updateItem(result.data); else setError(result.error); }
  function editReview(result: Result<Review>) { if (!requests.current.pending && !locked) apply(result); }
  function permitExit() {
    if (originalSave.unknown) { setError(handoffBlockedError(navigationState.current)); return false; }
    if (registerLeaveGuard) return true;
    const result = requestReviewExit(review, submission, unknownDrafts, requests.current.pending,
      () => window.confirm('离开会清除本页审阅内容，包括尚未保存的候选分流和关系输入。确认所需内容已保存或导出，并继续离开？'));
    if (!result.ok) setError(result.error);
    return result.ok;
  }
  async function load(conversationId: string, consent = replaceConsent) {
    if (originalRecovery) return;
    if (originalSave.unknown) { setError(handoffBlockedError(navigationState.current)); return; }
    const allowed = canReplaceReview(review, submission, consent, unknownDrafts);
    if (!allowed.ok) { setError(allowed.error); return; }
    const ticket = beginRequest(true);
    if (ticket === null) {
      setError({ code: 'CONFLICT', message: '当前请求尚未结束，现场未被替换。', retryable: false, dataState: 'preserved', nextAction: 'resolve_operation' });
      return;
    }
    try {
      const target = { conversationId, ...(conversationId === params?.conversationId ? {
        draftId: params.draftId, candidateId: params.candidateId, changeSetId: params.changeSetId, source: params.source,
      } : {}) };
      const result = await loadReviewTarget(target);
      if (!requests.current.isCurrent(ticket)) return;
      setMode(result.meta.mode);
      if (result.ok) { setId(conversationId); setSnapshot(null); setSaveNotes({}); setSavedComparisons({}); setManualSelection([]); setReplaceConsent(false); loadedDraftId.current = target.draftId; }
      apply(result);
    } catch {
      if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '读取失败，当前页面内容未改变。', retryable: true, dataState: 'preserved', nextAction: 'retry_read' });
    } finally { endRequest(ticket); }
  }
  async function startManual() {
    if (!review || !manualSelection.length || locked || Object.keys(unknownDrafts).length) return;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const result = await apiRequest<Review>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/manual`, { method: 'POST', body: JSON.stringify({
        segmentIds: manualSelection, expectedConversationHash: review.conversation.contentHash, confirmed: true }) });
      if (!requests.current.isCurrent(ticket)) return;
      if (!result.ok) { setError(result.error); return; }
      if (result.data.conversation.contentHash !== review.conversation.contentHash || result.data.actorId !== review.actorId || result.data.items.length !== 1 ||
        isAICandidate(result.data.items[0]!.subject)) {
        setError({ code: 'CONFLICT', message: '手动来源返回与当前现场不一致，本页未替换。', retryable: false, dataState: 'preserved', nextAction: 'reload_source' }); return;
      }
      apply({ ok: true, data: { ...review, items: [...review.items, result.data.items[0]!], activeId: result.data.activeId } });
      setManualSelection([]);
      requestAnimationFrame(() => document.getElementById('handoff-manual-title')?.focus());
    } catch { if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '手动来源读取失败，没有保存或提交。', retryable: true, dataState: 'preserved', nextAction: 'retry_read' }); }
    finally { endRequest(ticket); }
  }
  async function readSnapshot() {
    if (!review || locked) return;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const result = await apiRequest<KnowledgeSnapshot>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/snapshot`);
      if (!requests.current.isCurrent(ticket)) return;
      if (result.ok) {
        setSnapshot(result.data); setError(null);
        setReview((current) => current ? { ...current, items: current.items.map((entry) => entry.subject.id === review.activeId && !entry.baseRevision ? { ...entry, baseRevision: result.data.revision } : entry) } : current);
      } else setError(result.error);
    } catch { if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '知识版本读取失败，编辑内容仍在本页。', retryable: true, dataState: 'preserved', nextAction: 'retry_read' }); }
    finally { endRequest(ticket); }
  }
  async function saveDraft() {
    if (!review || !item || !snapshot || !item.draftVersion || !saveConsent || unknownDrafts[item.subject.id] || locked) return;
    const progress = toProgress(review, item, snapshot.revision);
    if (!progress.ok) { setError(progress.error); return; }
    const ticket = beginRequest(); if (ticket === null) return;
    const pending: PendingProgress = { progress: progress.data, options: { operationId: crypto.randomUUID(),
      source: sourceFor(item), expectedConversationHash: review.conversation.contentHash,
      expectedRevision: item.draftVersion.revision, expectedContentHash: item.draftVersion.contentHash, retentionDays: 30, confirmed: true } };
    try {
      const result = await apiRequest<ProgressSaveResult>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/progress`, { method: 'PUT', body: JSON.stringify(pending) });
      if (!requests.current.isCurrent(ticket)) return;
      const state = result.ok ? await verifyProgressState(pending, result.data.state) : result;
      const checked: Result<DraftReceipt> = !result.ok ? result : !state.ok ? state : await verifyProgressReceipt(pending, result.data.receipt,
        { actorId: review.actorId, workspaceId: review.conversation.workspaceId });
      if (!requests.current.isCurrent(ticket)) return;
      if (checked.ok) {
        setReview((current) => current ? acknowledgeProgress(current, pending, checked.data) : current);
        setSavedComparisons((states) => { const next = { ...states }; delete next[item.subject.id]; return next; });
        setSaveNotes((notes) => ({ ...notes, [item.subject.id]: `已保存本条完整审阅进度并核验原操作；私有版本 ${checked.data.revision}，保留30天` }));
      } else { setError(checked.error); if (isUncertainWrite(checked.error)) setUnknownDrafts((state) => ({ ...state, [item.subject.id]: pending })); }
    } catch {
      if (!requests.current.isCurrent(ticket)) return;
      setUnknownDrafts((state) => ({ ...state, [item.subject.id]: pending }));
      setError({ code: 'UNKNOWN_RESULT', message: '进度保存响应中断；请先核验原保存操作，勿直接重试。', retryable: false, dataState: 'unknown', nextAction: 'read_back' });
    } finally { if (endRequest(ticket)) setSaveConsent(false); }
  }
  async function readDraft() {
    if (!review || !item || locked) return;
    const pendingDraft = unknownDrafts[item.subject.id];
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const root = `/api/handoff/${encodeURIComponent(review.conversation.id)}`;
      if (pendingDraft) {
        const result = await apiRequest<DraftReceipt>(`${root}/draft-receipt?draftId=${encodeURIComponent(item.draftId)}&operationId=${encodeURIComponent(pendingDraft.options.operationId)}`);
        const verified = result.ok ? await verifyProgressReceipt(pendingDraft, result.data,
          { actorId: review.actorId, workspaceId: review.conversation.workspaceId }) : result;
        if (!requests.current.isCurrent(ticket)) return;
        if (!verified.ok) { setError(verified.error); return; }
        setUnknownDrafts((state) => { const next = { ...state }; delete next[item.subject.id]; return next; });
        setReview((current) => current ? acknowledgeProgress(current, pendingDraft, verified.data) : current);
        setSaveNotes((notes) => ({ ...notes, [item.subject.id]: `已核验原保存操作，私有版本 ${verified.data.revision}；本页后续编辑未被替换` }));
        return;
      }
      const result = await apiRequest<DraftState>(`${root}/draft-state?draftId=${encodeURIComponent(item.draftId)}`);
      if (!requests.current.isCurrent(ticket)) return;
      if (!result.ok) { setError(result.error); return; }
      const restored = await restoreProgressState(review, result.data);
      if (!requests.current.isCurrent(ticket)) return;
      if (!restored.ok) { setError(restored.error); return; }
      if (result.data.state === 'available' && hasItemEdits(item)) {
        setSavedComparisons((states) => ({ ...states, [item.subject.id]: result.data })); setOverwriteConsent(false);
        setSaveNotes((notes) => ({ ...notes, [item.subject.id]: '已读到平台进度；本页编辑未替换，请核对版本差异' }));
      } else {
        apply(restored);
        setSaveNotes((notes) => ({ ...notes, [item.subject.id]: result.data.state === 'available' ? '已恢复平台保存的完整审阅进度' :
          result.data.state === 'missing' ? '本条尚无已存进度；已取得首次保存版本' : '旧进度已到期；本地编辑保留，可明确保存新版本' }));
      }
    } catch { if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '草稿读取失败，本地编辑仍保留。', retryable: true, dataState: 'preserved', nextAction: 'retry_read' }); }
    finally { endRequest(ticket); }
  }
  async function useComparedProgress(keepLocal: boolean) {
    if (!review || !item || !overwriteConsent || requests.current.pending || locked || unknownDrafts[item.subject.id]) return;
    const state = savedComparisons[item.subject.id]; if (!state) return;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const restored = await restoreProgressState(review, state);
      if (!requests.current.isCurrent(ticket)) return;
      if (!restored.ok) { setError(restored.error); return; }
      const saved = restored.data.items.find((entry) => entry.draftId === item.draftId)!;
      apply(keepLocal ? { ok: true, data: { ...review, items: review.items.map((entry) => entry !== item ? entry :
        { ...entry, draftVersion: saved.draftVersion, savedFingerprint: saved.savedFingerprint }) } } : restored);
      setSavedComparisons((states) => { const next = { ...states }; delete next[item.subject.id]; return next; });
      setSaveNotes((notes) => ({ ...notes, [item.subject.id]: keepLocal ? '保留本地编辑；再次明确保存将以对照版本执行 CAS' : '已按明确选择恢复平台进度' }));
    } finally { endRequest(ticket); }
  }
  function exportLocal() {
    if (!review || !item) return;
    const blob = new Blob([JSON.stringify({ format: 'handoff-local-review-v1', conversationId: review.conversation.id, review: item,
      gitState: submission.receipt ? 'confirmed_saved' : submission.pending ? 'pending' : submission.unknown ? 'unknown' : 'not_submitted',
      pendingDraft: unknownDrafts[item.subject.id] ?? null,
      originalPreviewSave: originalSave,
      approvalState: submission.approvalUnknown ? 'unknown' : submission.approval ? 'registered' : 'none',
      changeSet: submission.preview?.changes ?? null, approval: submission.approval, receipt: submission.receipt }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${item.draftId}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function previewChanges() {
    if (!review || !item || !snapshot || locked || Object.keys(unknownDrafts).length) return;
    const draft = toDraft(review, item, snapshot.revision, new Date().toISOString());
    if (!draft.ok) { setError(draft.error); return; }
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const result = await apiRequest<HandoffPreview>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/preview`, { method: 'POST', body: JSON.stringify({ draft: draft.data, reason: '人工确认知识交接' }) });
      if (!requests.current.isCurrent(ticket)) return;
      if (result.ok) { setSubmission({ ...newSubmission(), preview: result.data }); setOriginalSave(newOriginalSave()); setOriginalConsent(false); setPinnedOperationHash(null);
        requestAnimationFrame(() => document.getElementById('handoff-preview-title')?.focus()); }
      else setError(result.error);
    } catch { if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '预览失败，未执行提交。', retryable: true, dataState: 'preserved', nextAction: 'retry_preview' }); }
    finally { endRequest(ticket); }
  }
  async function saveOriginal(readOnly = false) {
    if (!review || !item || !submission.preview || isSubmissionLocked(submission) || (!readOnly && originalSave.unknown)) return;
    const prepared = readOnly && originalSave.request ? { ok: true as const, data: originalSave.request }
      : makeOperationRequest(submission.preview, review, item, originalConsent);
    if (!prepared.ok) { setError(prepared.error); return; }
    const ticket = beginRequest(); if (ticket === null) return;
    const pending = prepared.data;
    setOriginalSave((current) => ({ ...current, request: pending }));
    try {
      const result = await (readOnly ? readSavedOperation : saveOperationSnapshot)(pending,
        { actorId: review.actorId, workspaceId: review.conversation.workspaceId });
      if (!requests.current.isCurrent(ticket)) return;
      if (result.ok) setOriginalSave({ request: pending, receipt: result.data, unknown: false });
      else { setError(result.error); setOriginalSave({ request: pending, receipt: null, unknown: readOnly || isUncertainWrite(result.error) }); }
    } finally { if (endRequest(ticket)) setOriginalConsent(false); }
  }
  async function pinOriginalOperation() {
    if (requests.current.pending) return;
    if (!review || !item || !submission.preview || !originalSave.request || !originalSave.receipt) {
      setError({ code: 'CONFLICT', message: '当前原预览尚未取得可核验保存回执，未修改地址。', retryable: false, dataState: 'preserved', nextAction: 'read_original_operation' });
      return;
    }
    if (!pinHandoffOperation) {
      setError({ code: 'NOT_CONFIGURED', message: '当前统一导航尚未提供原操作固定能力，未修改地址。', retryable: false, dataState: 'preserved', nextAction: 'retry_read' });
      return;
    }
    if (params?.candidateId) {
      setError({ code: 'NOT_CONFIGURED', message: '当前候选入口仍带 candidateId；统一导航尚未提供仅五字段的固定地址。当前预览保留，可打开原预览只读链接。', retryable: false, dataState: 'preserved', nextAction: 'read_original_operation' });
      return;
    }
    const ticket = beginRequest(); if (ticket === null) return;
    setPinning(true);
    const previousAddress = retainedOperation.current;
    try {
      const prepared = await buildHandoffOperationPin({ review, item, preview: submission.preview, request: originalSave.request, receipt: originalSave.receipt });
      if (!requests.current.isCurrent(ticket)) return;
      if (!prepared.ok) { setError(prepared.error); return; }
      // Shared subscribers can rerender synchronously during the pin call.
      retainedOperation.current = prepared.data;
      const result = pinHandoffOperation(prepared.data);
      if (!result.ok) {
        retainedOperation.current = previousAddress;
        const messages = {
          wrong_page: '当前不在知识交接页面，未修改地址。',
          conversation_mismatch: '当前地址现场与原操作不一致，未修改地址。',
          operation_mismatch: '当前地址操作身份与原操作不一致，未修改地址。',
          invalid_address: '原操作地址参数不合法，未修改地址。',
        } as const;
        setError({ code: 'CONFLICT', message: messages[result.reason], retryable: false, dataState: 'preserved', nextAction: 'keep_operation' });
        return;
      }
      const routeMatches = result.route.page === 'handoff' &&
        result.route.params.conversationId === prepared.data.conversationId &&
        result.route.params.draftId === prepared.data.draftId &&
        result.route.params.changeSetId === prepared.data.changeSetId &&
        result.route.params.source === prepared.data.source &&
        result.route.params.operationHash === prepared.data.operationHash;
      if (result.history !== 'replace' || !result.preservedPage || !routeMatches) {
        setError({ code: 'CONFLICT', message: '统一导航未确认原操作地址已固定，当前页面状态保留。', retryable: false, dataState: 'preserved', nextAction: 'retry_read' });
        return;
      }
      setPinnedOperationHash(prepared.data.operationHash); setError(null);
    } catch {
      if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '原操作地址固定未确认，当前预览与状态保留。', retryable: true, dataState: 'preserved', nextAction: 'retry_read' });
    } finally { if (endRequest(ticket)) setPinning(false); }
  }
  async function registerApproval() {
    if (!review || !submission.preview || !commitConsent || locked) return;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const response = await apiRequest<Approval>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/approval`, { method: 'POST',
        body: JSON.stringify({ draft: submission.preview.draft, changes: submission.preview.changes, confirmed: true }) });
      if (!requests.current.isCurrent(ticket)) return;
      const result = response.ok ? await validateIssuedApproval(submission.preview.changes, response.data,
        { actorId: review.actorId, workspaceId: review.conversation.workspaceId }, Date.now()) : response;
      if (!requests.current.isCurrent(ticket)) return;
      setSubmission((state) => settleApproval(state, result));
      if (!result.ok) setError(result.error);
    } catch {
      if (!requests.current.isCurrent(ticket)) return;
      const error: ApiError = { code: 'UNKNOWN_RESULT', message: '批准登记响应中断，登记状态待核验；未发出 Git 提交。', retryable: false, dataState: 'unknown', nextAction: 'check_approval' };
      setError(error); setSubmission((state) => settleApproval(state, { ok: false, error }));
    } finally { if (endRequest(ticket)) setCommitConsent(false); }
  }
  async function returnToEditing() {
    if (!review || submission.unknown || submission.pending || submission.approvalUnknown || originalSave.unknown || requests.current.pending) return;
    if (submission.approval) {
      const ticket = beginRequest(); if (ticket === null) return;
      try {
        const result = await apiRequest<{ revoked: boolean }>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/approval/${encodeURIComponent(submission.approval.id)}/revoke`, { method: 'POST' });
        if (!requests.current.isCurrent(ticket)) return;
        if (!result.ok) { setError(result.error); setSubmission((state) => ({ ...state, approvalUnknown: true })); return; }
        if (result.data.revoked !== true) { setSubmission((state) => ({ ...state, approvalUnknown: true })); setError({ code: 'UNKNOWN_RESULT', message: '批准尚未确认撤回，未发出新的提交。', retryable: false, dataState: 'unknown', nextAction: 'check_approval' }); return; }
      } catch {
        if (requests.current.isCurrent(ticket)) {
          setSubmission((state) => ({ ...state, approvalUnknown: true }));
          setError({ code: 'UNKNOWN_RESULT', message: '批准撤回尚未确认，当前预览仍保留。', retryable: false, dataState: 'unknown', nextAction: 'check_approval' });
        }
        return;
      }
      finally { endRequest(ticket); }
    }
    setSubmission(newSubmission()); setCommitConsent(false); setOriginalSave(newOriginalSave()); setOriginalConsent(false); setPinnedOperationHash(null);
    requestAnimationFrame(() => document.getElementById('handoff-statement')?.focus());
  }
  async function readApproval() {
    if (!review || !submission.preview || submission.pending || submission.unknown) return;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const result = await apiRequest<KnowledgeApprovalState>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/approval?changeSetId=${encodeURIComponent(submission.preview.changes.id)}`);
      if (!requests.current.isCurrent(ticket)) return;
      const recovered = result.ok ? await recoverApprovalState(submission, result.data,
        { actorId: review.actorId, workspaceId: review.conversation.workspaceId }, Date.now()) : result;
      if (!requests.current.isCurrent(ticket)) return;
      if (!recovered.ok) { setError(recovered.error); setSubmission((state) => ({ ...state, approvalUnknown: true })); return; }
      setSubmission(recovered.data); setCommitConsent(false);
      if (!recovered.data.preview) requestAnimationFrame(() => document.getElementById('handoff-statement')?.focus());
    } catch {
      if (requests.current.isCurrent(ticket)) {
        setSubmission((state) => ({ ...state, approvalUnknown: true }));
        setError({ code: 'UNKNOWN_RESULT', message: '批准状态仍未核验，保留原操作；没有重发登记或 Git 提交。', retryable: false, dataState: 'unknown', nextAction: 'check_approval' });
      }
    } finally { endRequest(ticket); }
  }
  async function commitKnowledge() {
    const { preview, approval } = submission;
    if (!review || !preview || !approval || submission.pending || submission.unknown || submission.approvalUnknown || submission.rejected || submission.receipt) return;
    const ticket = beginRequest(); if (ticket === null) return;
    setSubmission((state) => ({ ...state, pending: true }));
    try {
      const response = await apiRequest<CommitReceipt>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/commit`, { method: 'POST', body: JSON.stringify({
        draft: preview.draft, changes: preview.changes, approval, confirmed: true }) });
      if (!requests.current.isCurrent(ticket)) return;
      const result = response.ok ? validateReceipt(response.data, preview.changes.id, response.meta.mode) : response;
      setSubmission((state) => settleSubmission(state, result));
      if (!result.ok) setError(result.error);
      else requestAnimationFrame(() => document.getElementById('handoff-result-title')?.focus());
    } catch {
      if (!requests.current.isCurrent(ticket)) return;
      const error: ApiError = { code: 'UNKNOWN_RESULT', message: '提交响应中断，结果未知；保留本次操作并先核验。', retryable: false, dataState: 'unknown', nextAction: 'read_back' };
      setError(error); setSubmission((state) => settleSubmission(state, { ok: false, error }));
    } finally { if (endRequest(ticket)) setCommitConsent(false); }
  }
  async function readReceipt() {
    if (!review || !submission.preview) return;
    const operationId = submission.preview.changes.id;
    const ticket = beginRequest(); if (ticket === null) return;
    try {
      const response = await apiRequest<CommitReceipt>(`/api/handoff/${encodeURIComponent(review.conversation.id)}/receipt?changeSetId=${encodeURIComponent(operationId)}`);
      if (!requests.current.isCurrent(ticket)) return;
      const result = response.ok ? validateReceipt(response.data, operationId, response.meta.mode) : response;
      setSubmission((state) => settleReceiptRead(state, result));
      if (result.ok) setError(null); else setError(result.error);
    } catch { if (requests.current.isCurrent(ticket)) setError({ code: 'UPSTREAM', message: '暂未读回提交结果，本次操作仍保留。', retryable: true, dataState: 'unknown', nextAction: 'read_back' }); }
    finally { endRequest(ticket); }
  }
  useEffect(() => {
    if (!registerLeaveGuard) return;
    const readState = () => ({ ...navigationState.current, busy: navigationState.current.busy || requests.current.pending });
    return registerLeaveGuard(handoffGuard(readState, () => {
      setError(handoffBlockedError(readState()));
      requestAnimationFrame(() => document.getElementById('handoff-operation-error')?.focus());
    }));
  }, [registerLeaveGuard]);
  useEffect(() => {
    // A pin changes the address, not the loaded review or the in-flight operation.
    if (locallyPinned) return;
    retainedOperation.current = null;
    const canceledRead = requests.current.cancelReplacingRead();
    if (canceledRead) setBusy(false);
    if (originalRecovery) return;
    if (!params?.conversationId) return;
    setId(params.conversationId);
    setReplaceConsent(false);
    if (review?.conversation.id === params.conversationId && params.draftId === loadedDraftId.current) {
      if (params.candidateId && params.candidateId !== review.activeId) {
        if (requests.current.pending || locked) {
          setError({ code: 'CONFLICT', message: '当前操作尚未结束，尚未切换候选。', retryable: false, dataState: 'preserved', nextAction: 'resolve_operation' });
        } else editReview(selectCandidate(review, params.candidateId));
      }
      return;
    }
    void load(params.conversationId, false);
  }, [params?.conversationId, params?.draftId, params?.candidateId, params?.source, params?.changeSetId, params?.operationHash]);
  useEffect(() => () => requests.current.invalidate(), []);
  useEffect(() => {
    if (registerLeaveGuard) return;
    if (!shouldWarnOnExit(review, submission, unknownDrafts, busy || originalSave.unknown)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [registerLeaveGuard, review, submission, unknownDrafts, busy, originalSave.unknown]);

  if (originalRecovery) return <div className="handoff">
    <header className="handoff-heading"><h1>原提交核验</h1></header>
    <OriginalOperationLookup conversationId={params?.conversationId ?? ''} initialChangeSetId={params?.changeSetId}
      draftId={params?.draftId} source={params?.source} operationHash={params?.operationHash} />
    <ReceiptLookup conversationId={params?.conversationId ?? ''} initialChangeSetId={params?.changeSetId} />
    <a className="handoff-back" href="#handoff">返回人工交接</a>
  </div>;

  return <div className="handoff" aria-busy={busy}>
    <header className="handoff-heading"><div><p className="handoff-eyebrow">知识交接</p><h1>人工交接与知识入库</h1></div>
      <span className="handoff-status">{mode === 'fixture' ? 'Fixture 测试数据' : mode === 'live' ? '已连接工作区' : '工作区未连接'}</span></header>
    <form className="handoff-load" onSubmit={(event) => { event.preventDefault(); void load(id.trim()); }}>
      <label htmlFor="handoff-conversation">现场 ID</label><input id="handoff-conversation" value={id} maxLength={160} disabled={busy || locked} onChange={(event) => { setId(event.target.value); setReplaceConsent(false); }} required />
      <button type="submit" disabled={busy || !id.trim() || locked || Object.keys(unknownDrafts).length > 0 || (hasLocalEdits(review) && !replaceConsent)}><RefreshCw size={17} />读取现场</button>
      {hasLocalEdits(review) && <label className="handoff-check handoff-replace"><input type="checkbox" checked={replaceConsent} disabled={busy || locked} onChange={(event) => setReplaceConsent(event.target.checked)} />放弃本页未保存的编辑，读取所选现场</label>}
    </form>
    {error && <div id="handoff-operation-error" className="handoff-error" role="alert" tabIndex={-1}><strong>{error.code}</strong><p>{error.message}</p><p>数据状态：{({ not_written: '未写入', preserved: '原数据保留', partial: '部分完成', unknown: '结果未知' })[error.dataState]}</p></div>}
    {!review && !busy && <p className="handoff-empty"><FileText size={24} />尚未载入交接现场。没有执行保存或提交。</p>}
    {review && <>
      <div className="handoff-origin"><span>原始现场：{review.conversation.id}</span><span>{review.conversation.sourceAlreadyPersisted ? '已在平台保存' : '未确认在平台保存'}</span>
        {review.conversation.issueUrl && <a href={safeUrl(review.conversation.issueUrl)} target="_blank" rel="noreferrer">Issue #{review.conversation.issueNumber}</a>}</div>
      {!submission.preview && <details open={params?.source === 'manual'}><summary>手动新建审阅</summary>
        <fieldset className="handoff-disposition" disabled={busy || locked || Object.keys(unknownDrafts).length > 0}><legend>本次来源范围</legend>
          {review.conversation.segments.filter((segment) => segment.text).map((segment) => <label key={segment.id} className="handoff-check">
            <input type="checkbox" checked={manualSelection.includes(segment.id)} onChange={(event) => setManualSelection((ids) => event.target.checked ? [...ids, segment.id] : ids.filter((id) => id !== segment.id))} />
            <span>{segment.id}<br />{segment.text}</span></label>)}
          <button type="button" disabled={!manualSelection.length || manualSelection.length > 50} onClick={() => void startManual()}><Plus size={17} />从所选原句开始空白审阅</button>
        </fieldset></details>}
      {review.items.length === 0 ? <p>此现场暂无待审项；原始内容保持不变。</p> : <>
        <label className="handoff-select">当前审阅<select disabled={busy || locked} value={review.activeId ?? ''} onChange={(event) => editReview(selectCandidate(review, event.target.value))}>
          {review.items.map((entry, index) => <option key={entry.subject.id} value={entry.subject.id}>{index + 1}. {entry.subject.title || '未命名手动审阅'}</option>)}
        </select></label>
        {item && <fieldset className="handoff-work" aria-label="单项审阅" disabled={busy} hidden={Boolean(submission.preview)}><article className="handoff-review">
          <h2>{item.subject.title || '手动审阅'}</h2><p>{item.subject.question}</p>
          <DispositionPicker id={item.subject.id} value={item.disposition} onChange={(value) => editReview(decide(review, item.subject.id, value))} />
          {!isAICandidate(item.subject) && <section className="handoff-fields" aria-label="手动来源表达">
            <label htmlFor="handoff-manual-title">知识标题</label><input id="handoff-manual-title" value={item.subject.title} maxLength={1000} onChange={(event) => updateItem({ ...item, subject: { ...item.subject, title: event.target.value } })} />
            <label htmlFor="handoff-manual-question">对应的问题</label><textarea id="handoff-manual-question" value={item.subject.question} maxLength={8000} onChange={(event) => updateItem({ ...item, subject: { ...item.subject, question: event.target.value } })} />
            <label htmlFor="handoff-manual-kind">知识类型</label><select id="handoff-manual-kind" value={item.subject.kind} onChange={(event) => updateItem({ ...item, subject: { ...item.subject, kind: event.target.value as ReviewItem['subject']['kind'] } })}>
              {Object.entries({ concept: '概念', fact: '事实', claim: '主张', principle: '原则', method: '方法', decision: '决策', question: '问题' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </section>}
          <section aria-label="原文证据"><h3>原文证据</h3>{item.subject.spans.map((span) => <figure key={span.id}>
            <blockquote>{span.quote}</blockquote><figcaption>{span.segmentId} · {span.start}:{span.end}</figcaption>
          </figure>)}</section>
          {isAICandidate(item.subject) && <details><summary>AI 候选原文</summary><p>{item.subject.claim}</p><p>{item.subject.whyKeep}</p>
            <ul>{item.subject.uncertainties.map((text, index) => <li key={index}>{text}</li>)}</ul>
            {item.disposition === 'handoff' && !item.statement && <button type="button" onClick={() => updateItem(acceptAI(item))}><Check size={17} />原样接受 AI 文本</button>}</details>}
          {item.disposition === 'handoff' && <section className="handoff-fields" aria-label="人的表达">
            <label htmlFor="handoff-statement">我的核心陈述</label>
            <textarea id="handoff-statement" value={item.statement} maxLength={20000} onChange={(event) => updateItem(writeStatement(item, event.target.value))} />
            <p className="handoff-attribution">作者身份：{({ human_written: '人撰写', human_edited: '人编辑 AI 文本', ai_accepted: '接受 AI 原文' })[item.authorship]} · 尚未确认入库</p>
            <label htmlFor="handoff-condition">{['fact', 'claim'].includes(item.subject.kind) ? '关键来源条件' : item.subject.kind === 'concept' ? '关键适用边界' : '关键适用前提'}</label>
            <input id="handoff-condition" value={item.conditions[0]?.text ?? ''} maxLength={4000} onChange={(event) => updateItem({ ...item,
              conditions: [{ id: 'key-condition', text: event.target.value, status: 'unknown', evidenceIds: [] }, ...item.conditions.slice(1)] })} />
            <label htmlFor="handoff-condition-status">条件判断</label>
            <select id="handoff-condition-status" value={item.conditions[0]?.status ?? 'unknown'} onChange={(event) => applyItem(setKeyCondition(item, item.conditions[0]?.text ?? '', event.target.value as 'unknown' | 'confirmed' | 'rejected'))}>
              <option value="unknown">未核验</option><option value="confirmed">已确认条件成立</option><option value="rejected">条件不成立</option>
            </select>
            <details><summary>补充适用边界</summary><label htmlFor="handoff-boundary">不适用的范围</label><textarea id="handoff-boundary" value={item.boundaries.join('\n')} maxLength={12000} onChange={(event) => updateItem({ ...item, boundaries: event.target.value.split('\n') })} /></details>
            <h3>来源支持核验</h3><p>当前来源状态：{({ unverified: '未核验', partial: '部分支持', supported: '支持', disputed: '存在不支持的来源' })[evidenceStatus(item.sources)]}</p>
            {item.sources.length === 0 && <p>暂无外部来源，来源支持保持未核验。</p>}
            {item.sources.map((source, index) => <section className="handoff-source" key={source.id} aria-label={`来源 ${index + 1}`}>
              <h4>{source.title}</h4><div className="handoff-comparison"><div><strong>当前陈述</strong><p>{item.statement || '尚未填写'}</p></div>
                <div><strong>来源原句</strong><blockquote>{source.excerpt || '没有原句'}</blockquote>
                  {source.url && <a href={safeUrl(source.url)} rel="noreferrer" target="_blank">打开来源</a>}</div></div>
              <label htmlFor={`limitation-${index}`}>支持范围与限制</label><input id={`limitation-${index}`} value={source.limitation} maxLength={4000} onChange={(event) => updateItem({ ...item,
                sources: item.sources.map((entry) => entry.id === source.id ? { ...entry, limitation: event.target.value } : entry) })} />
              <label htmlFor={`support-${index}`}>人的来源判断</label><select id={`support-${index}`} value={source.support} onChange={(event) => applyItem(assessSource(item, source.id, event.target.value as SourceRecord['support'], source.limitation))}>
                <option value="unverified">未核验</option><option value="supports">支持</option><option value="partial">部分支持</option><option value="does_not_support">不支持</option>
              </select>
            </section>)}
            {snapshot &&
              <RelationEditor subject={{ id: item.nodeId, workspaceId: review.conversation.workspaceId, revision: item.baseRevision ?? snapshot.revision, sources: item.sources }}
                snapshot={snapshot} actorId={review.actorId} value={item.relations} input={item.relationInput} onInputChange={(relationInput) => updateItem({ ...item, relationInput })}
                onChange={(relations, relationInput) => updateItem({ ...item, relations, relationInput: relationInput ?? item.relationInput })} onError={setError} />}
            {item.baseRevision && <p>草稿基准版本：<code>{item.baseRevision}</code>{snapshot && item.baseRevision !== snapshot.revision && ' · 版本已变化，需重新预览'}</p>}
            {snapshot && item.baseRevision && item.baseRevision !== snapshot.revision && <button type="button" onClick={() => updateItem({ ...item, baseRevision: snapshot.revision, relations: [] })}>保留文字，清除本次关系并按新版本重审</button>}
            <button type="button" disabled={!snapshot || !item.statement.trim() || submission.unknown || Object.keys(unknownDrafts).length > 0} onClick={() => void previewChanges()}><FileCheck2 size={17} />预览入库差异</button>
          </section>}
          <section className="handoff-fields" aria-label="恢复与导出草稿">
            <h3>私人审阅进度</h3>
            <button type="button" onClick={() => void readSnapshot()}><RefreshCw size={17} />{snapshot ? '核对当前知识版本' : '读取知识版本'}</button>
            {unknownDrafts[item.subject.id] && <p role="status">上次进度写入结果未知；当前编辑仍保留，尚未允许再次保存或正式提交。原操作：<code>{unknownDrafts[item.subject.id]!.options.operationId}</code></p>}
            <button type="button" onClick={() => void readDraft()}><RefreshCw size={17} />{unknownDrafts[item.subject.id] ? '核验上次进度写入' : '读取已存进度与版本'}</button>
            {savedComparisons[item.subject.id] && <section aria-label="已存进度对照">
              <h4>平台私有版本 {savedComparisons[item.subject.id]!.revision}</h4>
              <details><summary>已存版本内容</summary><pre>{JSON.stringify(savedComparisons[item.subject.id]!.document, null, 2)}</pre></details>
              <details><summary>本条当前编辑</summary><pre>{JSON.stringify(toProgress(review, item, item.baseRevision ?? snapshot?.revision ?? 'unread'), null, 2)}</pre></details>
              <label className="handoff-check"><input type="checkbox" checked={overwriteConsent} onChange={(event) => setOverwriteConsent(event.target.checked)} />我已核对本条编辑与平台版本的差异</label>
              <div className="handoff-actions"><button type="button" disabled={!overwriteConsent} onClick={() => void useComparedProgress(false)}>采用平台进度</button>
                <button type="button" disabled={!overwriteConsent} onClick={() => void useComparedProgress(true)}>保留本地内容待另存新版本</button></div>
            </section>}
            <p>私有版本：{item.draftVersion?.revision ?? '尚未读取'} · {hasItemEdits(item) ? '有未保存编辑' : item.savedFingerprint ? '与已存进度一致' : '尚未编辑'}</p>
            <label className="handoff-check"><input type="checkbox" checked={saveConsent} onChange={(event) => setSaveConsent(event.target.checked)} />同意将本条分流、陈述、条件、来源判断与关系输入在本工作区私有保存30天，不入 Git 或索引</label>
            <button type="button" disabled={!saveConsent || !snapshot || !item.draftVersion || Boolean(unknownDrafts[item.subject.id]) || Boolean(savedComparisons[item.subject.id])}
              onClick={() => void saveDraft()}><Save size={17} />保存审阅进度</button>
            {saveNotes[item.subject.id] && <p role="status">{saveNotes[item.subject.id]}</p>}
            <button type="button" onClick={exportLocal}><Download size={17} />导出本条草稿（含原句）</button>
            {item.draftVersion?.state === 'available' && <a href={`#handoff?conversationId=${encodeURIComponent(review.conversation.id)}&draftId=${encodeURIComponent(item.draftId)}`}
              onClick={(event) => { if (!permitExit()) event.preventDefault(); }}>重新打开已存审阅</a>}
          </section>
        </article></fieldset>}
        {submission.preview && !submission.receipt && <PreviewPanel preview={submission.preview} onEdit={() => void returnToEditing()} locked={busy || submission.unknown || submission.approvalUnknown || originalSave.unknown}
          gitState={submission.pending ? 'pending' : submission.unknown ? 'unknown' : 'not_submitted'}>
          <OperationSavePanel consent={originalConsent} busy={busy} unknown={originalSave.unknown} saved={originalSave.receipt}
            onConsent={setOriginalConsent} onSave={() => void saveOriginal()} onRead={() => void saveOriginal(true)}
            onPin={() => void pinOriginalOperation()} pinning={pinning} pinned={pinnedOperationHash === originalSave.receipt?.changeSetHash}
            href={originalSave.receipt ? handoffOperationHash({ conversationId: review.conversation.id, draftId: submission.preview.draft.id,
              changeSetId: submission.preview.changes.id, source: submission.preview.draft.candidateId ? 'candidate' : 'manual', operationHash: originalSave.receipt.changeSetHash }) : '#handoff'} />
          <button type="button" onClick={exportLocal}><Download size={17} />导出本条草稿与操作 ID（含原句）</button>
          {submission.approvalUnknown ? <div role="status"><p>批准状态未知，未发出新的 Git 提交；本次预览与操作 ID 仍保留。</p>
            <button type="button" disabled={busy} onClick={() => void readApproval()}><RefreshCw size={17} />核验原批准登记</button></div> :
            submission.unknown ? <div role="status"><p>提交结果未知，草稿与操作 ID 仍保留。</p><button type="button" disabled={busy} onClick={() => void readReceipt()}><RefreshCw size={17} />核验提交结果</button></div> : <>
            {!submission.approval ? <><label className="handoff-check"><input type="checkbox" checked={commitConsent} disabled={busy} onChange={(event) => setCommitConsent(event.target.checked)} />确认将本页预览中的知识与关系写入 Git</label>
              <button type="button" disabled={busy || !commitConsent || originalSave.unknown} onClick={() => void registerApproval()}><Check size={17} />登记本次提交批准</button></> :
              <div><p>{submission.pending ? 'Git 提交已发出，等待回执。' : submission.rejected ? '本次提交未成功，批准仍保留。' : '批准已登记，尚未提交 Git。'}有效期至 {new Date(submission.approval.expiresAt).toLocaleString()}</p><div className="handoff-actions">
                <button type="button" disabled={busy || submission.rejected} onClick={() => void commitKnowledge()}><GitCommitHorizontal size={17} />提交到 Git</button>
                <button type="button" disabled={busy} onClick={() => void readApproval()}><RefreshCw size={17} />核验批准状态</button>
                <button type="button" disabled={busy} onClick={() => void returnToEditing()}><X size={17} />撤回批准并修改</button></div></div>}
          </>}
        </PreviewPanel>}
        {submission.receipt && submission.preview && <ResultPanel receipt={submission.receipt} nodeId={submission.preview.changes.nodes[0]!.id} conversationId={review.conversation.id} mode={mode} onNavigate={permitExit} />}
      </>}
      <a className="handoff-back" href={`#capture?conversationId=${encodeURIComponent(review.conversation.id)}`}
        onClick={(event) => { if (!permitExit()) event.preventDefault(); }}><ArrowRight size={16} />返回原始现场</a>
    </>}
    {!submission.preview && <><OriginalOperationLookup conversationId={review?.conversation.id ?? id.trim()} actorId={review?.actorId}
      workspaceId={review?.conversation.workspaceId} disabled={busy || locked} />
      <ReceiptLookup conversationId={review?.conversation.id ?? id.trim()} disabled={busy || locked} /></>}
  </div>;
}
