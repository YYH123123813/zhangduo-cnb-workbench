import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { Conversation } from '../../contracts/domain';
import { apiRequest } from '../../app/api-client';
import { parseText, type SourceDraft } from './parse';

export function SourcePicker({ onSelect, onDirty }: { onSelect: (source: SourceDraft | null) => void; onDirty?: () => void }) {
  const [origin, setOrigin] = useState<'cnb_issue' | 'paste' | 'manual'>('paste');
  const [text, setText] = useState('');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  function cancel() { active.current?.abort(); active.current = null; setBusy(false); onSelect(null); }
  async function read() {
    cancel();
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage('正在读取指定Issue。');
    try {
      const result = await apiRequest<Conversation>('/api/capture/issue', { method: 'POST', body: JSON.stringify({ issueNumber: Number(issue), selected: true }), signal: controller.signal });
      if (active.current !== controller) return;
      if (result.ok) { onSelect({ ...result.data, sourceRevision: result.data.contentHash }); setMessage('原内容已经保存在CNB；本次尚未保存或发送模型。'); }
      else setMessage(result.error.message);
    } catch { if (active.current === controller) setMessage('读取失败；未进行保存或模型调用。'); }
    finally { if (active.current === controller) { setBusy(false); active.current = null; } }
  }
  return <section className="capture-section" aria-labelledby="capture-source-title">
    <h2 id="capture-source-title">对话来源</h2>
    <fieldset className="capture-modes"><legend>来源类型</legend>{([['paste', '粘贴对话'], ['manual', '手动记录'], ['cnb_issue', 'CNB Issue']] as const).map(([value, label]) => <label key={value} className="capture-choice"><input type="radio" name="capture-origin" checked={origin === value} onChange={() => { cancel(); setOrigin(value); setMessage(''); }}/>{label}</label>)}</fieldset>
    {origin === 'cnb_issue' ? <>
    <label htmlFor="capture-issue">CNB Issue编号</label>
    <input id="capture-issue" inputMode="numeric" value={issue} onChange={(e) => { onDirty?.(); cancel(); setIssue(e.target.value); setMessage('选择已更改；旧预览与授权不再适用。'); }}/>
    <div className="capture-actions"><button type="button" disabled={busy || !/^[1-9]\d*$/.test(issue)} onClick={() => void read()}><Download size={16} aria-hidden="true"/>读取此Issue</button>
      {busy && <button type="button" onClick={() => { cancel(); setMessage('已取消读取。'); }}><X size={16} aria-hidden="true"/>取消</button>}</div>
    </> : <>
      <label htmlFor="capture-import">{origin === 'paste' ? '对话原文' : '手动记录'}</label>
      <textarea id="capture-import" rows={7} value={text} onChange={(e) => { onDirty?.(); cancel(); setText(e.target.value); setMessage('文本已修改；旧预览与授权不再适用。'); }}/>
      <button type="button" onClick={() => {
        const id = crypto.randomUUID(); const result = parseText(text, id);
        if (!result.ok) { setMessage(result.error.message); return; }
        onSelect({ id, origin, segments: result.data.segments, sourceAlreadyPersisted: false, createdAt: new Date().toISOString() });
        setMessage(result.data.warnings.join(' ') || '原文已在当前页面解析；尚未上传、保存或发送模型。');
      }}>解析文本</button>
    </>}
    {message && <p role="status" className="capture-notice">{message}</p>}
  </section>;
}
