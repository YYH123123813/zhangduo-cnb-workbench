import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeftRight, CheckCheck, Download, Eye, FileText, GitBranch, History, ListChecks, RefreshCw, Save, Settings2, ShieldCheck, Trash2, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { ApiError, ApiResponse, RequestContext } from '../../contracts/api';
import type { KnowledgeNode, Relation, Settings } from '../../contracts/domain';
import type { NavigationProps } from '../../contracts/navigation';
import type { ChangePreview } from './revisions';
import type { prepareChanges } from './commit';
import type { inspectImpact } from './impact';
import type { readHistoryNotices } from './history';
import type { exportPreview } from './export';
import type { previewDeletion } from './deletion';
import type { settingsStatus } from './settings';
import type { auditView } from './audit';
import type { demoPreview } from './demo';
import { editedNode, label, nextTab, nodePatch, operationFromRoute, retrievalLink, tabs, type GovernanceStatus, type Tab } from './client-model';
import { ChangeControls, DataControls, ChangesView, ErrorNotice, FileList, GovernancePayloadControl, HistoryList, LayerTable, NodeFields, SettingsFields, type GovernancePayloadSaveState } from './views';
import { ChangeFlow } from './change-flow';
import { DataFlow, type SettingsPreview, type DeleteVerification } from './data-flow';
import { governanceGuard } from './navigation';
import { OperationInspector } from './operation-view';
import type { OperationLookup } from './operation-readback';
import { VersionComparisonPanel } from './version-view';
import { AuditLog } from './audit-view';
import { HistoryOriginPanel } from './history-origin';
import { governanceOperationRequest, governancePayloadLocked, governancePayloadSaveState, hasRestorablePayload, readGovernancePayload, saveGovernancePayload } from './governance-operation';
import type { GovernanceOperationKind, GovernanceOperationSaveRequest, GovernanceOperationState } from '../../contracts/governance-operation';
import './governance.css';

export { SettingsFields } from './views';
type Prepared = Awaited<ReturnType<typeof prepareChanges>>;
type HistoryData = Awaited<ReturnType<typeof readHistoryNotices>>;
type SettingsData = Awaited<ReturnType<typeof settingsStatus>>;
type ExportData = Awaited<ReturnType<typeof exportPreview>>;
type DeleteData = Awaited<ReturnType<typeof previewDeletion>>;
type DemoData = Awaited<ReturnType<typeof demoPreview>>;
type DataPreview = { kind: 'export'; value: ExportData } | { kind: 'delete'; value: DeleteData } | { kind: 'verify'; value: DeleteVerification } | { kind: 'demo'; value: DemoData };
const icons = [FileText, GitBranch, History, ShieldCheck, Settings2, ListChecks];
const networkError: ApiError = { code: 'UPSTREAM', message: '连接中断，当前输入保留。', dataState: 'preserved', nextAction: 'retry_read', retryable: true };
export interface PageProps extends NavigationProps { nodeId?: string; revision?: string; routeParams?: Readonly<Record<string, string>> }

export function Page(props: PageProps = {}) {
  const routeProps = { ...props, nodeId: props.nodeId ?? props.routeParams?.nodeId, revision: props.revision ?? props.routeParams?.revision };
  const [response, setResponse] = useState<ApiResponse<GovernanceStatus> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError(null); setRefreshing(true);
    void apiRequest<GovernanceStatus>('/api/governance/status', { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) {
        if (value.ok) setResponse(value);
        else { setError(value.error); if (['UNAUTHORIZED', 'FORBIDDEN', 'NOT_CONFIGURED'].includes(value.error.code)) setResponse(value); }
      }
    }).catch(() => { if (!controller.signal.aborted) setError(networkError); }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [refresh]);
  if (response?.ok) return <Workspace key={`${response.data.actorId}:${response.data.snapshot.workspaceId}:${routeProps.nodeId ?? ''}:${routeProps.revision ?? ''}:${JSON.stringify(props.routeParams ?? {})}`} status={response.data} mode={response.meta.mode} {...routeProps} refreshError={error} refreshing={refreshing} onReload={() => setRefresh((v) => v + 1)}/>;
  return <div className="governance"><header className="gov-heading"><h1>版本演进与数据控制</h1><span className="gov-mode">未连接工作区</span></header>
    {error || (response && !response.ok) ? <ErrorNotice error={error ?? (response && !response.ok ? response.error : networkError)}/> : <p role="status" className="gov-empty">正在读取工作区状态…</p>}
    <button type="button" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={16} aria-hidden="true"/>重新读取</button></div>;
}

export function Workspace({ status, mode, nodeId, revision, routeParams, registerLeaveGuard, initialTab = 'knowledge', onReload, refreshError, refreshing = false }: {
  status: GovernanceStatus; mode: RequestContext['mode']; initialTab?: Tab; onReload?: () => void; refreshError?: ApiError | null; refreshing?: boolean;
} & PageProps) {
  const [snapshot, setSnapshot] = useState(status.snapshot);
  const [flow] = useState(() => new ChangeFlow(apiRequest));
  const submission = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const [dataFlow] = useState(() => new DataFlow(apiRequest));
  const dataAction = useSyncExternalStore(dataFlow.subscribe, dataFlow.getSnapshot, dataFlow.getSnapshot);
  const prepared = submission.prepared;
  const routeOperation = operationFromRoute(routeParams);
  const operationRoute = !!(routeParams?.changeSetId || routeParams?.planId || routeParams?.approvalId);
  const originRoute = !!(routeParams?.useId || routeParams?.evidenceId || routeParams?.taskId);
  const draftRoute = !!routeParams?.draftId;
  const mixedRoute = Number(operationRoute) + Number(originRoute) + Number(draftRoute) > 1;
  const [originReady, setOriginReady] = useState(!originRoute);
  useEffect(() => { setSnapshot(status.snapshot); }, [status.snapshot]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selectedId, setSelectedId] = useState(nodeId ?? (originRoute || draftRoute ? '' : snapshot.nodes[0]?.id ?? ''));
  const selected = snapshot.nodes.find((n) => n.id === selectedId);
  const [basis, setBasis] = useState<KnowledgeNode | undefined>(selected);
  const [draft, setDraft] = useState<KnowledgeNode | undefined>(selected);
  const [baseRevision, setBaseRevision] = useState(snapshot.revision);
  const [referenceRevision, setReferenceRevision] = useState(revision);
  const [reason, setReason] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [impact, setImpact] = useState<ReturnType<typeof inspectImpact> | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [audit, setAudit] = useState<ReturnType<typeof auditView> | null>(null);
  const [auditOperation, setAuditOperation] = useState<OperationLookup | null>(null);
  const [payloadSave, setPayloadSave] = useState<{ operationId: string; state: GovernancePayloadSaveState }>({ operationId: '', state: 'idle' });
  const payloadSaveRef = useRef(payloadSave);
  payloadSaveRef.current = payloadSave;
  const payloadRequest = useRef<GovernanceOperationSaveRequest | null>(null);
  const payloadLocked = governancePayloadLocked(payloadSave.state);
  const controlsLocked = operationRoute || draftRoute || !originReady || payloadLocked || flow.locked || dataFlow.locked || submission.stage === 'succeeded' || dataAction.stage === 'succeeded' || refreshing || !!refreshError;
  const [demoOperationId, setDemoOperationId] = useState('');
  const [demoPayload, setDemoPayload] = useState<Record<string, unknown> | null>(null);
  const [restoredOperation, setRestoredOperation] = useState<GovernanceOperationState | null>(null);
  const [restoreState, setRestoreState] = useState<'idle' | 'loading' | 'ready' | 'expired' | 'unknown'>('idle');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [settingsPreview, setSettingsPreview] = useState<SettingsPreview | null>(null);
  const [relationId, setRelationId] = useState(snapshot.relations[0]?.id ?? '');
  const relation = snapshot.relations.find((r) => r.id === relationId);
  const [relationDraft, setRelationDraft] = useState<Relation | undefined>(relation);
  const [relationTargetId, setRelationTargetId] = useState(relation?.target.objectId ?? '');
  const [relationBaseRevision, setRelationBaseRevision] = useState(snapshot.revision);
  const [reverse, setReverse] = useState(false);
  const [replacementId, setReplacementId] = useState('');
  const [restoreRevision, setRestoreRevision] = useState(revision ?? '');
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [records, setRecords] = useState<HistoryData | null>(null);
  const [dataPreview, setDataPreview] = useState<DataPreview | null>(null);
  const [publicTitle, setPublicTitle] = useState('');
  const [publicStatement, setPublicStatement] = useState('');
  const [publicConditions, setPublicConditions] = useState('');
  const [publicSources, setPublicSources] = useState('');
  const [modelDeclaration, setModelDeclaration] = useState('unknown');
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const canWrite = status.scopes.includes('knowledge:write');
  const blockedNode = !!selected && (snapshot.excludedIds.includes(selected.id) || selected.lifecycle === 'withdrawn');
  const hasDraft = dirty || JSON.stringify(draft) !== JSON.stringify(basis) || reverse
    || JSON.stringify(relationDraft) !== JSON.stringify(relation) || relationTargetId !== (relation?.target.objectId ?? '')
    || !!settingsDraft && JSON.stringify(settingsDraft) !== JSON.stringify(settings?.settings)
    || !!publicTitle || !!publicStatement || !!publicConditions || !!publicSources;
  const leaveDraft = useRef(false);
  leaveDraft.current = hasDraft || !!preview || !!dataPreview || !!settingsPreview || payloadLocked;
  useEffect(() => {
    if (!registerLeaveGuard) return;
    return registerLeaveGuard(governanceGuard(() => ({ dirty: leaveDraft.current, operations: [flow.getSnapshot(), dataFlow.getSnapshot()], payloadState: payloadSaveRef.current.state }), () => {
      setNotice('原操作或批准尚未结清，请先核验结果或撤回批准。');
      document.getElementById(governancePayloadLocked(payloadSaveRef.current.state) ? 'gov-payload-status' : flow.getSnapshot().stage !== 'idle' ? 'gov-change-status' : 'gov-data-status')?.focus();
    }));
  }, [registerLeaveGuard, flow, dataFlow]);

  const call = useCallback(async <T,>(path: string, input?: unknown, method = 'POST'): Promise<T | null> => {
    const current = ++requestId.current; controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); setError(null); setNotice('');
    try {
      const response = await apiRequest<T>(`/api/governance${path}`, { signal: pending.signal, ...(input === undefined ? {} : { method, body: JSON.stringify(input) }) });
      if (requestId.current !== current || pending.signal.aborted) return null;
      if (!response.ok) { setError(response.error); return null; }
      return response.data;
    } catch { if (!pending.signal.aborted) setError(networkError); return null; }
    finally { if (requestId.current === current) setBusy(false); }
  }, []);
  useEffect(() => () => { controller.current?.abort(); requestId.current++; }, []);
  useEffect(() => { if (preview) document.getElementById('governance-preview')?.focus(); }, [preview]);
  useEffect(() => {
    if (registerLeaveGuard) return;
    if (!leaveDraft.current && !payloadLocked && !flow.locked && !dataFlow.locked && !submission.approval && !dataAction.approval) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [registerLeaveGuard, hasDraft, preview, dataPreview, settingsPreview, payloadLocked, flow, dataFlow, submission.stage, submission.approval, dataAction.stage, dataAction.approval]);
  useEffect(() => {
    flow.observeRevision(snapshot.revision);
    dataFlow.observeRevision(snapshot.revision);
    stop(); setPreview(null); setImpact(null); setDataPreview(null); setSettingsPreview(null);
    if (!governancePayloadLocked(payloadSaveRef.current.state)) resetPayload();
  }, [snapshot.revision, flow, dataFlow]);
  useEffect(() => {
    if (tab === 'history') { setHistory(null); void call<HistoryData>(`/history?${new URLSearchParams(selectedId ? { nodeId: selectedId } : {})}`).then((data) => { if (data) setHistory(data); }); }
    if (tab === 'audit') { setAudit(null); void call<ReturnType<typeof auditView>>('/audit').then((data) => { if (data) setAudit(data); }); }
    if (tab === 'settings' && !settings) void call<SettingsData>('/settings').then((data) => { if (data) { setSettings(data); setSettingsDraft(data.settings); } });
  }, [tab, selectedId, call]);
  useEffect(() => {
    const operationId = routeParams?.draftId;
    if (!operationId || mixedRoute) { setRestoredOperation(null); setRestoreState('idle'); return; }
    const controller = new AbortController(); setRestoredOperation(null); setRestoreState('loading');
    void readGovernancePayload((path, init) => apiRequest(path, { ...init, signal: controller.signal }), { operationId, actorId: status.actorId, workspaceId: status.snapshot.workspaceId }, undefined, { requireRecovery: true }).then((response) => {
      if (controller.signal.aborted) return;
      if (!response.ok) { setRestoreState('unknown'); setError(response.error); return; }
      setRestoredOperation(response.data.state); setRestoreState(hasRestorablePayload(response.data.state) ? 'ready' : 'expired'); setError(null);
    });
    return () => controller.abort();
  }, [routeParams?.draftId, mixedRoute, status.actorId, status.snapshot.workspaceId, restoreAttempt]);

  function stop() { controller.current?.abort(); requestId.current++; setBusy(false); }
  function updatePayloadSave(operationId: string, state: GovernancePayloadSaveState) {
    const next = { operationId, state }; payloadSaveRef.current = next; setPayloadSave(next);
  }
  function resetPayload() { payloadRequest.current = null; updatePayloadSave('', 'idle'); }
  function clearPreview() {
    if (governancePayloadLocked(payloadSaveRef.current.state) || flow.locked || dataFlow.locked || submission.stage === 'succeeded' || dataAction.stage === 'succeeded') return false;
    if (!flow.invalidate() || !dataFlow.invalidate()) return false;
    stop(); setPreview(null); setImpact(null); setDataPreview(null); setSettingsPreview(null); resetPayload(); setDemoOperationId(''); setDemoPayload(null); return true;
  }
  function beginPreview() {
    if (!clearPreview()) return false;
    if (flow.locked || dataFlow.locked) { setNotice('正在撤回旧批准，完成后可重新预览。'); return false; }
    return true;
  }
  function pick(id: string) {
    if (controlsLocked) return;
    if (hasDraft && !window.confirm('切换对象会放弃当前未提交的草稿，是否继续？')) return;
    stop(); clearPreview(); setError(null); setNotice('');
    const next = snapshot.nodes.find((n) => n.id === id);
    setSelectedId(id); setBasis(next); setDraft(next); setBaseRevision(snapshot.revision); setReferenceRevision(undefined); setReason(''); setDirty(false);
    if (settings) setSettingsDraft(settings.settings);
  }
  function pickRelation(id: string) {
    if (controlsLocked) return;
    if (hasDraft && !window.confirm('切换关系会放弃当前未提交的草稿，是否继续？')) return;
    stop(); setRelationId(id); const next = snapshot.relations.find((r) => r.id === id); setRelationDraft(next); setRelationTargetId(next?.target.objectId ?? ''); setRelationBaseRevision(snapshot.revision);
    setDraft(basis); setReverse(false); setReason(''); setDirty(false); clearPreview();
  }
  function cancel() {
    if (!clearPreview()) return;
    setError(null);
    setNotice(flow.getSnapshot().stage === 'revoking' || dataFlow.getSnapshot().stage === 'revoking' ? '输入保留，正在撤回本次批准。' : '预览已取消，输入保留，未发送执行请求。');
  }
  async function recoverKnowledgeApproval() {
    await flow.recoverApproval();
    if (flow.getSnapshot().stage === 'idle') {
      setPreview(null); setNotice('原批准已失效或撤回，编辑输入保留，请重新预览。');
    }
  }
  async function recoverDataApproval() {
    await dataFlow.recoverApproval();
    if (dataFlow.getSnapshot().stage === 'idle') {
      setDataPreview(null); setSettingsPreview(null); setNotice('原批准已失效或撤回，编辑输入保留，请重新预览。');
    }
  }
  function changeNode(patch: Partial<KnowledgeNode>) { if (draft && !controlsLocked && clearPreview()) { setDraft(editedNode(draft, patch)); setDirty(true); } }
  function showPreview(value: ChangePreview | null) { if (value && flow.invalidate()) { setPreview(value); setPayloadSave({ operationId: value.changes.id, state: 'idle' }); setNotice('差异已生成，尚未写入。'); } }
  async function previewNode() {
    if (!basis || !draft || !beginPreview()) return;
    showPreview(await call<ChangePreview>(`/nodes/${encodeURIComponent(basis.id)}`, { action: 'preview', operationId: crypto.randomUUID(), baseRevision, nodeRevision: referenceRevision ?? basis.revision, reason, patch: nodePatch(basis, draft) }, 'PATCH'));
  }
  async function previewRelation() {
    if (!relationDraft || !beginPreview()) return;
    showPreview(await call<ChangePreview>(`/relations/${encodeURIComponent(relationDraft.id)}`, { action: 'preview', operationId: crypto.randomUUID(), baseRevision: relationBaseRevision, reason,
      patch: relationDraft.state === 'withdrawn' || relationDraft.state === 'rejected' ? { state: relationDraft.state }
        : { reverse, targetId: relationTargetId, type: relationDraft.type, rationale: relationDraft.rationale, evidenceIds: relationDraft.evidenceIds } }, 'PATCH'));
  }
  async function previewData(kind: 'export' | 'delete' | 'verify') {
    if (!beginPreview()) return;
    if (kind === 'export') { const value = await call<ExportData>('/export', { action: 'preview', objectIds, baseRevision: snapshot.revision }); if (value) { setDataPreview({ kind, value }); setPayloadSave({ operationId: '', state: 'idle' }); setDemoPayload(null); dataFlow.prepare({ kind, workspaceId: snapshot.workspaceId, preview: value }, status.actorId); } }
    if (kind === 'delete') { const value = await call<DeleteData>('/delete/preview', { action: 'preview', objectIds, baseRevision: snapshot.revision }); if (value) { setDataPreview({ kind, value }); setPayloadSave({ operationId: '', state: 'idle' }); setDemoPayload(null); dataFlow.prepare({ kind, workspaceId: snapshot.workspaceId, preview: value }, status.actorId); } }
    if (kind === 'verify') { const value = await call<DeleteVerification>('/delete/verify', { action: 'verify', objectIds }); if (value) setDataPreview({ kind, value }); }
  }
  async function previewSettings() {
    if (!settings || !settingsDraft || !beginPreview()) return;
    const value = await call<SettingsPreview>('/settings', { action: 'preview', baseRevision: settings.baseRevision, expectedSettingsHash: settings.currentHash,
      ...(settings.settingsRevision === null ? {} : { expectedSettingsRevision: settings.settingsRevision }), patch: settingsDraft }, 'PATCH');
    if (value) { setSettingsPreview(value); setPayloadSave({ operationId: '', state: 'idle' }); dataFlow.prepare({ kind: 'settings', workspaceId: snapshot.workspaceId, preview: value }, status.actorId); }
  }
  async function saveOriginalPayload(kind: GovernanceOperationKind, operationId: string, baseRevision: string, payload: Record<string, unknown>) {
    if (!operationId || busy || refreshing || refreshError || governancePayloadLocked(payloadSaveRef.current.state) || flow.locked || dataFlow.locked) return;
    if (payloadSaveRef.current.operationId === operationId && ['saved', 'expired'].includes(payloadSaveRef.current.state)) return;
    let request: GovernanceOperationSaveRequest;
    try {
      request = governanceOperationRequest({ operationId, kind, baseRevision, payload });
    } catch {
      updatePayloadSave(operationId, 'failed');
      setError({ code: 'VALIDATION', message: '原载荷格式无效，未发送保存请求，输入保留。', dataState: 'preserved', retryable: false, nextAction: 'review_original_operation' });
      return;
    }
    payloadRequest.current = request; updatePayloadSave(operationId, 'saving'); setError(null); setNotice('');
    const response = await saveGovernancePayload(apiRequest, request, { operationId, actorId: status.actorId, workspaceId: status.snapshot.workspaceId }, { requireRecovery: true });
    if (!response.ok) { updatePayloadSave(operationId, governancePayloadSaveState(response.error)); setError(response.error); return; }
    updatePayloadSave(operationId, hasRestorablePayload(response.data.state) ? 'saved' : 'expired');
    setNotice(hasRestorablePayload(response.data.state) ? `原载荷与独立保存回执已核验，恢复仍使用操作ID ${operationId}。` : '原保存回执已核验，载荷已过期，未恢复内容或重新保存。');
  }
  async function readOriginalPayload(operationId: string) {
    if (!operationId || busy || refreshing || refreshError || ['saving', 'reading'].includes(payloadSaveRef.current.state) || payloadRequest.current?.operationId !== operationId) return;
    updatePayloadSave(operationId, 'reading'); setError(null); setNotice('');
    const response = await readGovernancePayload(apiRequest, { operationId, actorId: status.actorId, workspaceId: status.snapshot.workspaceId }, payloadRequest.current, { requireRecovery: true });
    if (!response.ok) { updatePayloadSave(operationId, 'unknown'); setError(response.error); return; }
    updatePayloadSave(operationId, hasRestorablePayload(response.data.state) ? 'saved' : 'expired');
    setNotice(hasRestorablePayload(response.data.state) ? '原载荷与独立保存回执已按同一操作ID核验，未创建新操作。' : '原保存回执已核验，载荷已过期，未恢复内容或重新保存。');
  }
  async function previewDemo() {
    if (!beginPreview()) return;
    const operationId = crypto.randomUUID();
    const input = { action: 'preview' as const, operationId, baseRevision: snapshot.revision, modelDeclaration, items: [{ nodeId: selectedId, publicTitle, publicStatement, publicConditions: lines(publicConditions), publicSourceLabels: lines(publicSources) }] };
    const value = await call<DemoData>('/demo/preview', input);
    if (value) {
      setDemoOperationId(operationId); setDemoPayload({ request: value.request, preview: value as unknown as Record<string, unknown> });
      setPayloadSave({ operationId, state: 'idle' }); setDataPreview({ kind: 'demo', value });
      dataFlow.prepare({ kind: 'demo', workspaceId: snapshot.workspaceId, preview: value }, status.actorId);
    }
  }
  async function reloadSettings() {
    if (!beginPreview()) return;
    const value = await call<SettingsData>('/settings');
    if (value) { setSettings(value); setNotice('当前设置版本已更新，未提交输入保留。'); }
  }
  function finishData() {
    const result = dataAction.result;
    if (!result || governancePayloadLocked(payloadSaveRef.current.state) || !dataFlow.finish()) return;
    if (result.kind === 'settings') { setSettings(result.value); setSettingsDraft(result.value.settings); setSettingsPreview(null); setDirty(false); }
    if (result.kind === 'delete') { setDataPreview({ kind: 'verify', value: result.value }); setObjectIds([]); setRecords(null); onReload?.(); }
    if (result.kind === 'export' || result.kind === 'demo') setDataPreview(null);
    resetPayload(); setDemoOperationId(''); setDemoPayload(null);
    setError(null); setNotice('本次结果已核验，可以继续处理下一项。');
  }
  function toggleObject(id: string, checked: boolean) { if (clearPreview()) setObjectIds((ids) => checked ? [...ids, id] : ids.filter((value) => value !== id)); }
  function finishChange() {
    const result = submission.result;
    if (!result || governancePayloadLocked(payloadSaveRef.current.state) || !flow.finish()) return;
    const latest = result.snapshot;
    const nextNode = latest.nodes.find((n) => n.id === selectedId);
    const nextRelation = latest.relations.find((r) => r.id === relationId);
    const pendingNode = !prepared?.changes.nodes.some((n) => n.id === selectedId) && JSON.stringify(draft) !== JSON.stringify(basis);
    const pendingRelation = !prepared?.changes.relations.some((r) => r.id === relationId) && (reverse || JSON.stringify(relationDraft) !== JSON.stringify(relation) || relationTargetId !== (relation?.target.objectId ?? ''));
    setSnapshot(latest); setBasis(nextNode); setDraft(pendingNode ? draft : nextNode); setBaseRevision(latest.revision); setReferenceRevision(undefined);
    setRelationDraft(pendingRelation ? relationDraft : nextRelation); if (!pendingRelation) setRelationTargetId(nextRelation?.target.objectId ?? ''); setRelationBaseRevision(latest.revision);
    if (!pendingNode && !pendingRelation) setReason('');
    setDirty(false); if (!pendingRelation) setReverse(false);
    setPreview(null); setImpact(null); setHistory(null); setRecords(null); setDataPreview(null); setSettingsPreview(null); setError(null);
    resetPayload();
    setNotice('提交版本已读回，可以继续处理下一项。'); onReload?.();
  }
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const dataPrepared = dataAction.prepared;
  const originalPayload: Parameters<typeof governanceOperationRequest>[0] | null = payloadRequest.current ?? (preview
    ? { kind: 'change', operationId: preview.changes.id, baseRevision: preview.changes.baseRevision, payload: { preview } }
    : settingsPreview && dataPrepared?.kind === 'settings'
      ? { kind: 'settings', operationId: dataPrepared.operationId, baseRevision: settingsPreview.baseRevision, payload: { preview: settingsPreview } }
      : dataPreview?.kind === 'demo' && demoOperationId && demoPayload
        ? { kind: 'demo', operationId: demoOperationId, baseRevision: dataPreview.value.authorizationBinding.baseRevision, payload: demoPayload }
        : dataPrepared
          ? { kind: dataPrepared.kind, operationId: dataPrepared.operationId, baseRevision: dataPrepared.kind === 'delete' ? dataPrepared.preview.plan.baseRevision : dataPrepared.kind === 'demo' ? dataPrepared.preview.request.baseRevision : dataPrepared.preview.baseRevision, payload: { preview: dataPrepared.preview } }
          : null);

  return <div className="governance" aria-busy={busy}>
    <header className="gov-heading"><div><h1>版本演进与数据控制</h1><p className="gov-meta">当前版本 <code>{snapshot.revision}</code></p></div><div className="gov-heading-actions"><span className={`gov-mode gov-mode-${mode}`}>{mode === 'fixture' ? 'fixture · 测试数据' : mode === 'live' ? 'live · 已授权工作区' : '未连接'}</span>{onReload && <button className="gov-icon" type="button" title="重新读取快照，当前草稿保留" aria-label="重新读取快照" disabled={busy || flow.locked || dataFlow.locked || refreshing} onClick={onReload}><RefreshCw size={18}/></button>}</div></header>
    {refreshError && <ErrorNotice error={refreshError}/>}
    {mixedRoute && <p className="gov-notice">原记录、草稿与操作入口不可混用，未恢复任何载荷。</p>}
    {draftRoute && !mixedRoute && <section className="gov-band" aria-label="治理原载荷恢复"><h2>治理原载荷恢复 · {routeParams!.draftId}</h2>
      {restoreState === 'loading' && <p role="status">正在按原操作ID读取私有载荷…</p>}
      {restoreState === 'ready' && restoredOperation && hasRestorablePayload(restoredOperation) && <><p role="status">原载荷已恢复为只读内容，未创建新操作。</p><p className="gov-meta">类型 <code>{restoredOperation.kind}</code> · 基准版本 <code>{restoredOperation.baseRevision}</code> · 保存回执已读回</p><pre>{JSON.stringify(restoredOperation.payload, null, 2)}</pre><p className="gov-notice">原载荷恢复不等于批准、提交、删除或公开；当前路由保持只读，不自动重发。</p></>}
      {restoreState === 'expired' && <p className="gov-notice" role="status">原载荷已过期或已被清除，仅保留操作元数据；未恢复编辑内容，未创建新操作。</p>}
      {restoreState === 'unknown' && <><p className="gov-notice" role="status">原载荷或独立保存回执无法核验，未恢复编辑内容，未创建新操作。</p><button type="button" onClick={() => setRestoreAttempt((value) => value + 1)}>按同一操作ID只读重查</button></>}
    </section>}
    {originRoute && !mixedRoute && <HistoryOriginPanel selection={{ ...(nodeId ? { nodeId } : {}), ...(routeParams?.taskId ? { taskId: routeParams.taskId } : {}), ...(routeParams?.useId ? { useId: routeParams.useId } : {}), ...(routeParams?.evidenceId ? { evidenceId: routeParams.evidenceId } : {}) }} revision={revision} disabled={refreshing || !!refreshError} onReady={setOriginReady}/>}
    {!mixedRoute && (operationRoute || ['data', 'settings', 'audit'].includes(tab)) && <OperationInspector initial={routeOperation ?? auditOperation ?? { kind: tab === 'settings' ? 'settings' : tab === 'data' ? 'delete' : 'knowledge', id: '' }} disabled={refreshing || !!refreshError}/>}
    {operationRoute && !routeOperation && <p className="gov-notice">原操作参数冲突或无效，未恢复任何载荷。</p>}
    <fieldset disabled={controlsLocked} aria-label="治理编辑区域">
    <div className="gov-tabs" role="tablist" aria-label="治理视图">{tabs.map(([key, title], index) => { const Icon = icons[index]!; return <button id={`gov-tab-${key}`} type="button" role="tab" key={key} aria-selected={tab === key} aria-controls={`gov-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => { stop(); setTab(key); setError(null); }} onKeyDown={(e) => { const next = nextTab(key, e.key); if (next !== key) { e.preventDefault(); stop(); setTab(next); document.getElementById(`gov-tab-${next}`)?.focus(); } }}><Icon size={16} aria-hidden="true"/>{title}</button>; })}</div>
    {error && <ErrorNotice error={error}/>}{(busy || notice) && <p className="gov-status" role="status">{busy ? '正在核验…' : notice}{busy && <button type="button" className="gov-icon" aria-label="取消当前读取或预览" title="取消当前读取或预览" onClick={() => { stop(); setNotice('当前读取已取消，输入保留。'); }}><X size={16}/></button>}</p>}
    {tabs.filter(([key]) => key !== tab).map(([key]) => <section hidden key={key} id={`gov-panel-${key}`} role="tabpanel" aria-labelledby={`gov-tab-${key}`}/>)}
    <section className="gov-panel" id={`gov-panel-${tab}`} role="tabpanel" aria-labelledby={`gov-tab-${tab}`}>
      {['knowledge', 'history'].includes(tab) && <label className="gov-selector">知识对象<select value={selectedId} onChange={(e) => pick(e.target.value)} disabled={busy}><option value="">选择知识对象</option>{snapshot.nodes.map((n) => <option value={n.id} key={n.id}>{n.title} · {label(n.lifecycle)}</option>)}</select></label>}
      {tab === 'knowledge' && <>{basis && draft ? <><div className="gov-section-heading"><h2>{basis.title}</h2><a className="gov-link" href={retrievalLink(basis.id, basis.revision)}>查看知识</a></div><p className="gov-meta"><code>{basis.id} @ {basis.revision}</code> · {label(basis.confirmation)} · {label(basis.evidenceStatus)}</p>
        {(referenceRevision && referenceRevision !== basis.revision || baseRevision !== snapshot.revision) && <div className="gov-notice"><p>引用或基准版本已变化。草稿保留，尚未覆盖当前知识。</p><VersionComparisonPanel key={`${selectedId}:${referenceRevision ?? baseRevision}:${snapshot.revision}`} nodeId={selectedId} revision={referenceRevision ?? baseRevision}/><button type="button" onClick={() => { if ((!hasDraft || window.confirm('重新以当前版本开始会放弃现有草稿，是否继续？')) && clearPreview()) { setDirty(false); setBasis(selected); setDraft(selected); setReferenceRevision(undefined); setBaseRevision(snapshot.revision); } }}>以当前版本重新开始</button></div>}
        <p className="gov-meta">当前草稿仅保留在本页面，尚未持久化。</p>
        {blockedNode && <p className="gov-notice">该对象已撤回或阻断。普通编辑不能将其重新启用。</p>}
        <form onSubmit={(e) => { e.preventDefault(); void previewNode(); }}><NodeFields value={draft} onChange={changeNode} actorId={status.actorId} disabled={busy || !canWrite || blockedNode}/>
          <label>修改理由<textarea required maxLength={4000} rows={2} value={reason} disabled={busy || !canWrite} onChange={(e) => { setReason(e.target.value); setDirty(true); clearPreview(); }}/></label>
          <div className="gov-actions"><button type="submit" className="gov-primary" disabled={busy || !canWrite || blockedNode || JSON.stringify(draft) === JSON.stringify(basis) || !reason.trim()}><Eye size={16} aria-hidden="true"/>预览修订</button><button type="button" disabled={busy || blockedNode} onClick={() => void call<ReturnType<typeof inspectImpact>>('/impact', { action: 'preview', objectIds: [basis.id], baseRevision: snapshot.revision, budget: 1000 }).then((value) => { if (value) setImpact(value); })}><GitBranch size={16} aria-hidden="true"/>检查影响</button><button type="button" onClick={cancel}><X size={16} aria-hidden="true"/>取消修改</button></div>
        </form>
        <details className="gov-band"><summary>替代与恢复</summary><div className="gov-fields"><label>替代知识<select value={replacementId} onChange={(e) => { setReplacementId(e.target.value); clearPreview(); }}><option value="">选择已有的新结论</option>{snapshot.nodes.filter((n) => n.id !== basis.id && n.lifecycle === 'active').map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label><button type="button" disabled={busy || !canWrite || !replacementId || !reason.trim()} onClick={() => { if (beginPreview()) void call<ChangePreview>('/replace', { action: 'preview', operationId: crypto.randomUUID(), relationId: crypto.randomUUID(), baseRevision: snapshot.revision, oldNodeId: basis.id, replacementNodeId: replacementId, reason, evidenceIds: basis.sources.filter((s) => s.support === 'supports').map((s) => s.id) }).then(showPreview); }}><ArrowLeftRight size={16} aria-hidden="true"/>预览替代</button><label>历史版本引用<input value={restoreRevision} maxLength={160} onChange={(e) => { setRestoreRevision(e.target.value); clearPreview(); }}/></label><button type="button" disabled={busy || !canWrite || !restoreRevision.trim() || !reason.trim()} onClick={() => { if (beginPreview()) void call<ChangePreview>('/rollback', { action: 'preview', operationId: crypto.randomUUID(), nodeId: basis.id, baseRevision: snapshot.revision, historicalRevision: restoreRevision.trim(), reason }).then(showPreview); }}><History size={16} aria-hidden="true"/>预览恢复</button></div></details>
      </> : <p className="gov-empty">当前快照没有选定的知识对象。</p>}</>}

      {tab === 'relations' && <>
        <label className="gov-selector">正式关系<select value={relationId} disabled={busy} onChange={(e) => pickRelation(e.target.value)}>
          {snapshot.relations.map((r) => <option key={r.id} value={r.id}>{r.source.objectId} → {label(r.type)} → {r.target.objectId} · {label(r.state)}</option>)}
        </select></label>
        {relationDraft ? <form onSubmit={(e) => { e.preventDefault(); void previewRelation(); }}>
          <p className="gov-meta">草稿基准 <code>{relationBaseRevision}</code> · 仅保留在当前页面</p>
          <fieldset className="gov-fields" disabled={busy || !canWrite}>
            <p className="gov-path"><code>{reverse ? relationDraft.target.objectId : relationDraft.source.objectId}</code><span>{label(relationDraft.type)}</span><code>{relationTargetId}</code></p>
            <label className="gov-check"><input type="checkbox" checked={reverse} disabled={relationDraft.state === 'withdrawn' || relationDraft.state === 'rejected'} onChange={(e) => { if (!clearPreview()) return; setReverse(e.target.checked); setRelationTargetId(e.target.checked ? relationDraft.source.objectId : relationDraft.target.objectId); setRelationDraft({ ...relationDraft, evidenceIds: [] }); setDirty(true); }}/><ArrowLeftRight size={16} aria-hidden="true"/>反转方向</label>
            <label>关系目标<select value={relationTargetId} disabled={relationDraft.state === 'withdrawn' || relationDraft.state === 'rejected'} onChange={(e) => { if (!clearPreview()) return; setRelationTargetId(e.target.value); setRelationDraft({ ...relationDraft, evidenceIds: [] }); setDirty(true); }}>
              {snapshot.nodes.filter((node) => node.id !== (reverse ? relationDraft.target.objectId : relationDraft.source.objectId) && node.confirmation === 'confirmed' && node.lifecycle === 'active' && !snapshot.excludedIds.includes(node.id)).map((node) => <option key={node.id} value={node.id}>{node.title} · {node.id} @ {node.revision}</option>)}
            </select></label>
            <div className="gov-two-col">
              <label>关系类型<select value={relationDraft.type} onChange={(e) => { setRelationDraft({ ...relationDraft, type: e.target.value as Relation['type'] }); setDirty(true); clearPreview(); }}>{['supports', 'depends_on', 'contradicts', 'supersedes'].map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label>
              <label>处理方式<select value={relationDraft.state === 'withdrawn' || relationDraft.state === 'rejected' ? relationDraft.state : 'proposed'} onChange={(e) => { setRelationDraft({ ...relationDraft, state: e.target.value as Relation['state'] }); setDirty(true); clearPreview(); }}><option value="proposed">修订待确认</option><option value="withdrawn">撤回错误关系</option><option value="rejected">拒绝并撤回正式关系</option></select></label>
            </div>
            <label>关系依据<textarea rows={3} required value={relationDraft.rationale} onChange={(e) => { setRelationDraft({ ...relationDraft, rationale: e.target.value }); setDirty(true); clearPreview(); }}/></label>
            <label>证据引用<select multiple value={relationDraft.evidenceIds} onChange={(e) => { setRelationDraft({ ...relationDraft, evidenceIds: Array.from(e.target.selectedOptions, (o) => o.value) }); setDirty(true); clearPreview(); }}>
              {[...new Set([...relationDraft.evidenceIds, ...snapshot.nodes.filter((n) => [reverse ? relationDraft.target.objectId : relationDraft.source.objectId, relationTargetId].includes(n.id)).flatMap((n) => n.sources.filter((source) => source.support === 'supports').map((source) => source.id))])].map((id) => <option value={id} key={id}>{id}</option>)}
            </select></label>
            <label>修改理由<textarea rows={2} required value={reason} onChange={(e) => { setReason(e.target.value); setDirty(true); clearPreview(); }}/></label>
          </fieldset>
          <div className="gov-actions"><button type="submit" className="gov-primary" disabled={busy || !canWrite || !reason.trim()}><Eye size={16} aria-hidden="true"/>预览关系变更</button><button type="button" onClick={cancel}><X size={16} aria-hidden="true"/>取消</button></div>
        </form> : <p className="gov-empty">当前没有正式关系。</p>}
      </>}

      {tab === 'history' && (history ? <HistoryList data={history}/> : !error && <p className="gov-empty" role="status">正在读取原版本记录…</p>)}
      {tab === 'data' && <><h2>选择数据范围</h2><fieldset className="gov-selection" disabled={busy}>{snapshot.nodes.map((n) => <label className="gov-check" key={n.id}><input type="checkbox" checked={objectIds.includes(n.id)} onChange={(e) => toggleObject(n.id, e.target.checked)}/><span>{n.title}<small>{n.id} · {label(n.lifecycle)}</small></span></label>)}{snapshot.relations.map((r) => <label className="gov-check" key={r.id}><input type="checkbox" checked={objectIds.includes(r.id)} onChange={(e) => toggleObject(r.id, e.target.checked)}/><span>{r.source.objectId} → {label(r.type)} → {r.target.objectId}<small>{r.id} · {label(r.state)}</small></span></label>)}{records?.entries.map(({ record }) => record && <label className="gov-check" key={record.id}><input type="checkbox" checked={objectIds.includes(record.id)} onChange={(e) => toggleObject(record.id, e.target.checked)}/><span>{record.id}<small>{record.kind} · {record.recordedAt}</small></span></label>)}</fieldset>
        <div className="gov-actions"><button type="button" disabled={busy || !status.scopes.includes('evidence:read')} onClick={() => void call<HistoryData>('/history').then((value) => { if (value) setRecords(value); })}><History size={16} aria-hidden="true"/>列出可选记录</button><span className="gov-meta">已选择 {objectIds.length} 项</span></div>
        <div className="gov-actions"><button type="button" disabled={busy || !objectIds.length || !status.scopes.includes('data:export')} onClick={() => void previewData('export')}><Download size={16} aria-hidden="true"/>预览导出</button><button type="button" className="gov-danger" disabled={busy || !objectIds.length || !status.scopes.includes('data:delete')} onClick={() => void previewData('delete')}><Trash2 size={16} aria-hidden="true"/>预览删除</button><button type="button" disabled={busy || !objectIds.length || !status.scopes.includes('data:delete')} onClick={() => void previewData('verify')}><CheckCheck size={16} aria-hidden="true"/>核验检索阻断</button><button type="button" onClick={cancel}><X size={16} aria-hidden="true"/>取消预览</button></div>
        {dataPreview && <section className="gov-band" aria-label="数据预览">{dataPreview.kind === 'export' && <><h2>导出预览</h2><FileList files={dataPreview.value.files}/><ul>{dataPreview.value.limitations.map((text) => <li key={text}>{text}</li>)}</ul></>}{dataPreview.kind === 'delete' && <><h2>删除计划预览</h2><LayerTable layers={dataPreview.value.layers}/></>}{dataPreview.kind === 'verify' && <><h2>{dataPreview.value.retrievalBlocked ? '应用检索阻断已核验' : '应用检索阻断尚未全部核验'}</h2><p>物理清理仍未核验。</p><ul>{dataPreview.value.objects.map((item) => <li key={item.id}>{item.id} · {label(item.state)}</li>)}</ul><LayerTable layers={dataPreview.value.layers}/></>}{dataPreview.kind === 'demo' && <><h2>脱敏演示预览 · 未发布</h2><p className="gov-meta">批准绑定 · 操作 <code>{dataPreview.value.authorizationBinding.operationId}</code> · 操作者 <code>{dataPreview.value.authorizationBinding.actorId}</code> · 工作区 <code>{dataPreview.value.authorizationBinding.workspaceId}</code> · 版本 <code>{dataPreview.value.authorizationBinding.baseRevision}</code> · 对象 <code>{dataPreview.value.authorizationBinding.objectIds.join(', ')}</code></p><p className="gov-meta">请求摘要 <code>{dataPreview.value.requestHash}</code> · 脱敏内容摘要 <code>{dataPreview.value.contentHash}</code> · 目标 <code>local_download</code> · published=false</p><FileList files={dataPreview.value.files}/><ul>{dataPreview.value.warnings.map((text) => <li key={text}>{text}</li>)}</ul></>}</section>}
        <details className="gov-band"><summary>最小演示副本</summary>
          <form onSubmit={(e) => { e.preventDefault(); void previewDemo(); }}>
            <fieldset className="gov-fields" aria-label="演示副本" disabled={busy || !status.scopes.includes('data:export')}>
              <label>原知识对象<select value={selectedId} onChange={(e) => pick(e.target.value)}><option value="">选择原知识</option>{snapshot.nodes.map((n) => <option value={n.id} key={n.id}>{n.title}</option>)}</select></label>
              <label>脱敏标题<input required maxLength={120} value={publicTitle} onChange={(e) => { setPublicTitle(e.target.value); clearPreview(); }}/></label>
              <label>脱敏陈述<textarea required rows={3} value={publicStatement} onChange={(e) => { setPublicStatement(e.target.value); clearPreview(); }}/></label>
              <label>脱敏前提<textarea rows={2} value={publicConditions} onChange={(e) => { setPublicConditions(e.target.value); clearPreview(); }}/></label>
              <label>脱敏来源名称<textarea rows={2} value={publicSources} onChange={(e) => { setPublicSources(e.target.value); clearPreview(); }}/></label>
              <label>模型使用声明<select value={modelDeclaration} onChange={(e) => { setModelDeclaration(e.target.value); clearPreview(); }}><option value="unknown">实际模型信息待核验</option><option value="used">使用了模型</option><option value="not_used">未使用模型</option></select></label>
              <button type="submit" disabled={busy || !selectedId || !status.scopes.includes('data:export')}><Eye size={16} aria-hidden="true"/>预览脱敏副本</button>
            </fieldset>
          </form>
        </details>
      </>}
      {tab === 'settings' && <>{settings && settingsDraft ? <><form onSubmit={(e) => { e.preventDefault(); void previewSettings(); }}><p className="gov-meta">设置版本 <code>{settings.settingsRevision ?? '未提供'}</code></p><SettingsFields value={settingsDraft} disabled={busy || !status.scopes.includes('settings:write')} onChange={(value) => { if (clearPreview()) { setSettingsDraft(value); setDirty(true); } }}/><p className="gov-meta">关闭影响后续操作；已有文本、关系、版本与过去记录仍保留。</p><div className="gov-actions"><button type="submit" disabled={busy || !status.scopes.includes('settings:write')}><Save size={16} aria-hidden="true"/>预览设置</button><button type="button" disabled={busy} onClick={() => void reloadSettings()}><RefreshCw size={16} aria-hidden="true"/>读取当前设置版本</button><button type="button" onClick={cancel}><X size={16} aria-hidden="true"/>取消修改</button></div>{settingsPreview && <div className="gov-band"><h2>设置变更预览</h2><SettingsFields value={settingsPreview.settings} disabled onChange={() => {}}/></div>}</form></> : !error && <p className="gov-empty" role="status">正在读取服务端设置…</p>}</>}
    {tab === 'audit' && (audit ? <AuditLog entries={audit.entries} onInspectOperation={setAuditOperation}/> : !error && <p className="gov-empty" role="status">正在读取审计记录…</p>)}
    </section>
    {impact && tab === 'knowledge' && <section className="gov-band"><h2>影响检查 · {impact.coverage === 'partial' ? '存在覆盖缺口' : '当前预算内已检查'}</h2><p>直接影响：{impact.directNodeIds.join(', ') || '当前未发现'}；间接待复核：{impact.indirectNodeIds.join(', ') || '当前未发现'}。</p><p>可读历史引用：{impact.evidenceRefs.map((r) => r.id).join(', ') || (impact.historyCoverage === 'current' ? '当前授权范围内未发现' : '未完整核验')}。</p><ul>{impact.warnings.map((text) => <li key={text}>{text}</li>)}</ul></section>}
    {preview && (tab === 'knowledge' || tab === 'relations') && <><ChangesView preview={preview}/><div className="gov-actions"><button type="button" disabled={busy || !!prepared} onClick={() => void call<Prepared>('/changes/prepare', { action: 'prepare', changes: preview.changes, ...(preview.restoration ? { restoration: preview.restoration } : {}) }).then((value) => { if (value) flow.prepare(value, status.actorId); })}><Save size={16} aria-hidden="true"/>核验提交摘要</button><button type="button" onClick={cancel}><X size={16} aria-hidden="true"/>取消</button></div></>}
    </fieldset>
    {originalPayload && <GovernancePayloadControl kind={originalPayload.kind} operationId={originalPayload.operationId} state={payloadSave.operationId === originalPayload.operationId ? payloadSave.state : 'idle'} disabled={busy || refreshing || !!refreshError} saveDisabled={operationRoute || draftRoute || !originReady || flow.locked || dataFlow.locked || submission.stage === 'succeeded' || dataAction.stage === 'succeeded'} onSave={() => void saveOriginalPayload(originalPayload.kind, originalPayload.operationId, originalPayload.baseRevision, originalPayload.payload)} onRead={() => void readOriginalPayload(originalPayload.operationId)}/>} 
    <ChangeControls state={submission} disabled={busy || refreshing || !!refreshError || payloadLocked} onApprove={() => void flow.approve()} onRecover={() => void recoverKnowledgeApproval()} onCommit={() => void flow.commit()} onVerify={() => void flow.verify()} onRevoke={() => void flow.revoke()} onCancel={cancel} onContinue={finishChange}/>
    <DataControls state={dataAction} disabled={busy || refreshing || !!refreshError || payloadLocked} onApprove={() => void dataFlow.approve()} onRecover={() => void recoverDataApproval()} onCommit={() => void dataFlow.commit()} onVerify={() => void dataFlow.verify()} onRevoke={() => void dataFlow.revoke()} onCancel={cancel} onContinue={finishData}/>
  </div>;
}
