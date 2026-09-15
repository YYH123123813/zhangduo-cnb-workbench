import { useState } from 'react';
import { EyeOff, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Conversation } from '../../contracts/domain';
import { scanSegments } from './privacy';
import { manualMaskRanges, prepareContent, safeDisplayText, type ManualMask } from './redaction';

export function PrivacyEditor({ segments, alreadySaved, intent, onReady }: { segments: Conversation['segments']; alreadySaved: boolean; intent: 'archive' | 'propose'; onReady: (value: Conversation['segments'] | null) => void }) {
  const [masks, setMasks] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [message, setMessage] = useState('');
  const [manualMasks, setManualMasks] = useState<ManualMask[]>([]);
  const [manualSegment, setManualSegment] = useState(segments[0]?.id ?? '');
  const [manualText, setManualText] = useState('');
  const scan = scanSegments(segments);
  const prepared = prepareContent(segments, masks, reviewed, manualMasks);
  const manualRanges = manualMaskRanges(segments, manualMasks);
  const names = { key: '密钥', credential: '凭据', private_key: '私钥', email: '邮箱', phone: '电话号码' };
  function invalidate() { onReady(null); setMessage(''); setReviewed(false); }
  function addManual() {
    const next = [...manualMasks, { id: crypto.randomUUID(), segmentId: manualSegment, text: manualText }];
    const checked = manualMaskRanges(segments, next);
    if (!checked.ok) { setMessage(checked.error.message); return; }
    invalidate(); setManualMasks(next); setManualText(''); setMessage('手动遮盖已更新；原批准不再适用，尚未保存。');
  }
  return <section className="capture-section" aria-labelledby="capture-privacy-title">
    <h2 id="capture-privacy-title">脱敏与用途</h2>
    <p role="status">{!scan.ok ? '检测失败，暂不能确认。' : scan.data.status === 'blocked' ? '发现疑似密钥；未遮盖前禁止确认。' : scan.data.status === 'review' ? '有疑似个人信息需要核对。' : '未命中已知样式；不代表没有敏感内容。'}</p>
    {scan.ok && scan.data.findings.map((f) => <label className="capture-choice" key={f.id}><input type="checkbox" checked={masks.includes(f.id)} onChange={(e) => { invalidate(); setMasks(e.target.checked ? [...masks, f.id] : masks.filter((id) => id !== f.id)); }}/>
      遮盖{names[f.kind]}，片段{segments.findIndex((s) => s.id === f.segmentId) + 1}，字符{f.start}至{f.end}{f.blocking ? '（必须处理）' : '（可核对后保留）'}</label>)}
    {scan.ok && scan.data.findings.some((f) => !f.blocking) && <label className="capture-choice"><input type="checkbox" checked={reviewed} onChange={(e) => { onReady(null); setMessage(''); setReviewed(e.target.checked); }}/>已核对本次保留的疑似个人信息</label>}
    <details><summary>手动遮盖</summary>
      <label htmlFor="capture-mask-segment">目标片段</label>
      <select id="capture-mask-segment" value={manualSegment} onChange={(e) => { invalidate(); setManualSegment(e.target.value); }}>{segments.map((s, index) => <option key={s.id} value={s.id}>片段 {index + 1}</option>)}</select>
      <label htmlFor="capture-mask-text">需要遮盖的原文</label>
      <input id="capture-mask-text" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={10000} value={manualText} onChange={(e) => { invalidate(); setManualText(e.target.value); }}/>
      <button type="button" disabled={!manualText.trim() || manualMasks.length >= 50} onClick={addManual}><EyeOff size={16} aria-hidden="true"/>遮盖匹配内容</button>
    </details>
    {manualMasks.length > 0 && <ul className="capture-manual-masks" aria-label="手动遮盖范围">{manualMasks.map((entry, index) => <li key={entry.id}><span>手动遮盖 {index + 1} · 片段 {segments.findIndex((s) => s.id === entry.segmentId) + 1} · {manualRanges.ok ? manualRanges.data.filter((range) => range.maskId === entry.id).length : 0} 处匹配</span><button type="button" className="capture-icon" title={`移除手动遮盖 ${index + 1}`} aria-label={`移除手动遮盖 ${index + 1}`} onClick={() => { invalidate(); setManualMasks(manualMasks.filter((m) => m.id !== entry.id)); }}><Trash2 size={16} aria-hidden="true"/></button></li>)}</ul>}
    {manualText.length > 0 && <p role="status">手动遮盖尚未应用。</p>}
    <div className="capture-comparison"><div><h3>选中原文（疑似密钥不展开）</h3>{segments.map((s) => <pre key={s.id} className="capture-segment">{safeDisplayText(s.text)}</pre>)}</div>
      <div><h3>最终内容</h3>{prepared.ok ? prepared.data.map((s) => <pre key={s.id} className="capture-segment">{s.text}</pre>) : <p>{prepared.error.message}</p>}</div></div>
    <dl className="capture-purpose"><div><dt>CNB现场</dt><dd>仅保存上方最终内容。{alreadySaved ? '来源原文已经保存在CNB，本次遮盖不会删除原Issue。' : '目前没有上传或保存原文。'}</dd></div>
      <div><dt>模型</dt><dd>{intent === 'archive' ? '本次只归档，不发送模型。' : '尚未发送。保存后单独确认模型输入。'}</dd></div>
      <div><dt>语义索引</dt><dd>对话和候选默认不进入正式知识索引。</dd></div></dl>
    <div className="capture-actions"><button type="button" disabled={!prepared.ok || manualText.length > 0} onClick={() => { if (prepared.ok && !manualText.length) { onReady(prepared.data); setMessage('内容已核对；仍未保存或发送模型。'); } }}><ShieldCheck size={16} aria-hidden="true"/>核对本次内容</button>
      <button type="button" onClick={() => { onReady(null); setManualText(''); setMessage('已取消本次确认；没有新增写入。'); }}><X size={16} aria-hidden="true"/>取消</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
