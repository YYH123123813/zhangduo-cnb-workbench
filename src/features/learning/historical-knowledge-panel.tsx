import { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { VersionRef } from '../../contracts/domain';
import type { HistoricalKnowledgeView } from './history-reader';

const currentLabels: Record<HistoricalKnowledgeView['currentState'], string> = {
  current: '版本尚未变化', changed: '当前版本已变化', withdrawn: '当前已撤回',
  superseded: '当前已被替代', needs_review: '当前待复核',
};

export function HistoricalKnowledgeDetails({ view }: { view: HistoricalKnowledgeView }) {
  const node = view.knowledge;
  return <section aria-label="原版本知识" className="learning-version">
    <h3>{node.title}</h3>
    <p>原版本 <code>{view.snapshotRevision}</code></p>
    <p>{currentLabels[view.currentState]} · 本次适用性未评估</p>
    <p className="learning-answer">{node.humanStatement}</p>
    {node.conditions.map((condition) => <p key={condition.id}>
      <strong>{condition.status === 'confirmed' ? '原版本已确认' : condition.status === 'rejected' ? '原版本不成立' : '原版本待核对'}</strong> {condition.text}
    </p>)}
    {node.boundaries.map((boundary, index) => <p key={index}>原边界：{boundary}</p>)}
    <p>{view.contextState === 'recorded' ? '当时任务条件与路径见原使用记录；以上来自原 Git 版本知识。'
      : view.contextState === 'linked_use' ? '当时任务条件与路径关联原使用记录；以上来自原 Git 版本知识。'
        : '当时的任务条件与路径未记录；以上来自原 Git 版本知识。'}</p>
  </section>;
}

export function HistoricalKnowledgePanel({ recordId, nodeRef }: { recordId: string; nodeRef: VersionRef }) {
  const [view, setView] = useState<HistoricalKnowledgeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setView(null); setNotice(''); setBusy(false);
    return () => request.current?.abort();
  }, [recordId, nodeRef.workspaceId, nodeRef.objectId, nodeRef.revision]);
  const close = () => {
    request.current?.abort(); request.current = null;
    setView(null); setBusy(false); setNotice('');
  };
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setNotice(''); setView(null);
    try {
      const query = new URLSearchParams({ nodeId: nodeRef.objectId });
      const response = await apiRequest<HistoricalKnowledgeView>(`/api/learning/records/${encodeURIComponent(recordId)}/knowledge?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.ok) {
        if (response.data.recordId !== recordId || response.data.nodeRef.objectId !== nodeRef.objectId
          || response.data.nodeRef.revision !== nodeRef.revision || response.data.nodeRef.workspaceId !== nodeRef.workspaceId) {
          setNotice('历史响应与所选记录不一致，未展示内容。');
        } else setView(response.data);
      } else setNotice(response.error.message);
    } catch {
      if (!controller.signal.aborted) setNotice('原版本知识读取失败；未更改任何记录。');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  return <section aria-label={`历史知识 ${nodeRef.objectId}`} aria-busy={busy}>
    <div className="learning-actions">
      <button type="button" className="learning-secondary" disabled={busy} onClick={() => void load()}><History size={16}/>查看原版本知识 {nodeRef.objectId}</button>
      {(busy || view || notice) && <button type="button" className="icon-button" aria-label={busy ? '取消历史读取' : '关闭原版本知识'} title={busy ? '取消历史读取' : '关闭原版本知识'} onClick={close}><X size={18}/></button>}
    </div>
    {notice && <p role="status" className="learning-notice">{notice}</p>}
    {view && <HistoricalKnowledgeDetails view={view}/>}
  </section>;
}
