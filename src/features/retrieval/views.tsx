import { ArrowRight, ExternalLink, FilePenLine, ClipboardCheck, BookOpen, RefreshCw } from 'lucide-react';
import type { KnowledgeNode, RetrievalResult } from '../../contracts/domain';
import type { NodeDetail, NodeSummary } from './api';
import { knowledgeLinks, safeSourceUrl } from './client-state';
import { evidenceLabels } from './ranking';

const lifecycleLabels = { active: '有效', needs_review: '待复核', superseded: '已被替代', withdrawn: '已撤回' } as const;
const authorshipLabels = { human_written: '人撰写', human_edited: '人修改', ai_accepted: '人确认保留 AI 原文' } as const;
const supportLabels = { supports: '支持', partial: '部分支持', does_not_support: '不支持', unverified: '未核实' } as const;
export const relationLabels = { supports: '支持', depends_on: '依赖前提', contradicts: '冲突', supersedes: '替代' } as const;

export function TextPaths({ paths, nodes, selectedId, onSelect }: { paths: RetrievalResult['paths']; nodes: NodeSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const titles = new Map(nodes.map((n) => [n.id, n.title]));
  if (!paths.length) return <p className="empty-state">当前没有可展示的正式关系路径。</p>;
  return <ol className="text-paths">{paths.map((p, i) => <li key={`${p.seedId}-${p.relationIds.join('-')}-${i}`}>
    <div className="path-nodes">{p.nodeIds.map((id, index) => <span key={`${id}-${index}`}>{index > 0 && <ArrowRight size={15} aria-hidden="true"/>}<button type="button" aria-pressed={selectedId === id} onClick={() => onSelect(id)}>{titles.get(id) ?? id}</button></span>)}</div>
    <p>{p.reason}</p>{p.relationIds.length > 0 && <p className="metadata">关系：{p.relationIds.join(' / ')}</p>}
  </li>)}</ol>;
}

export function ResultList({ result, selectedId, onSelect }: { result: RetrievalResult; selectedId: string | null; onSelect: (id: string) => void }) {
  const groups = [['eligible', '通过当前检查'], ['conditional', '有条件参考'], ['conflicts', '存在冲突']] as const;
  return <div className="result-groups">{groups.map(([key, title]) => <section key={key} className={`result-group ${key}`} aria-label={title}>
    <h2>{title}<span className="count">{result.groups[key].length}</span></h2>
    {!result.groups[key].length ? <p className="empty-state">暂无</p> : <ul>{result.groups[key].map((n) => <li key={n.id}>
      <button type="button" className="result-select" aria-pressed={selectedId === n.id} onClick={() => onSelect(n.id)}>
        <span className="result-title">{n.title}</span><span className="metadata">{evidenceLabels[n.evidenceStatus]} · {lifecycleLabels[n.lifecycle]}</span><span className="statement-preview">{n.humanStatement}</span>
      </button>
    </li>)}</ul>}
  </section>)}</div>;
}

export function NodeDetails({ detail, taskId, onSelect, canRecordUse = true, onCurrent }: { detail: NodeDetail; taskId: string; onSelect: (id: string) => void; canRecordUse?: boolean; onCurrent?: () => void }) {
  const n = detail.node; const links = knowledgeLinks(taskId, n);
  const names = new Map([n, ...detail.neighbors].map((item) => [item.id, item.title]));
  return <article className="node-detail" aria-label="知识详情">
    <header><p className="metadata">知识详情 · {n.id}</p><h2>{n.title}</h2></header>
    {detail.history && <div className="notice"><p>引用版本 · 只读核对</p><p>当前快照：<code>{detail.history.currentSnapshotRevision}</code></p>{onCurrent && <button type="button" className="text-command" onClick={onCurrent}><RefreshCw size={16} aria-hidden="true"/>查看当前版本</button>}</div>}
    <dl className="node-meta"><div><dt>确认</dt><dd>{n.confirmation === 'confirmed' ? '人已确认' : '草稿'}</dd></div><div><dt>来源支持</dt><dd>{evidenceLabels[n.evidenceStatus]}</dd></div><div><dt>知识状态</dt><dd>{lifecycleLabels[n.lifecycle]}</dd></div><div><dt>表达作者</dt><dd>{authorshipLabels[n.authorship]}</dd></div><div><dt>节点版本</dt><dd><code>{n.revision}</code></dd></div><div><dt>快照版本</dt><dd><code>{detail.snapshotRevision}</code></dd></div></dl>
    {detail.warnings.map((warning) => <p className="notice" key={warning}>{warning}</p>)}
    <h3>人的正文</h3><p className="original-text">{n.humanStatement}</p><p className="metadata">原问题：{n.question}</p>
    <h3>前提与边界</h3>
    {n.conditions.length ? <ul className="condition-list">{n.conditions.map((c) => <li key={c.id}><span>{c.text}</span><span className="metadata">知识记录：{c.status === 'confirmed' ? '已确认' : c.status === 'rejected' ? '不满足' : '未知'}</span></li>)}</ul> : <p className="empty-state">未记录前提</p>}
    {n.boundaries.length > 0 && <ul>{n.boundaries.map((b, i) => <li key={i}>{b}</li>)}</ul>}
    <h3>来源</h3>
    {n.sources.length ? <ol className="source-list">{n.sources.map((s) => { const url = safeSourceUrl(s.url); return <li key={s.id}>
      <h4>{s.title}</h4><p className="metadata">{s.id} · {supportLabels[s.support]} · {s.kind === 'ai_inference' ? 'AI 推断' : s.kind}</p>
      <blockquote>{s.excerpt}</blockquote><p>支持的陈述：{s.supportedClaim || '未记录'}</p>{s.limitation && <p className="notice">限制：{s.limitation}</p>}
      {url ? <a className="command-link" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true"/>{s.kind === 'conversation' ? '打开原 Issue / 来源' : '打开来源'}</a> : <span className="metadata">未提供可打开的来源地址</span>}
    </li>; })}</ol> : <p className="notice">没有直接来源</p>}
    <h3>关系列表 <span className="count">{detail.relations.length}</span></h3>
    {detail.relations.length ? <ul className="relation-list">{detail.relations.map(({ relation: r, usable, reason }) => <li key={r.id}>
      <div className="relation-line"><button type="button" onClick={() => onSelect(r.source.objectId)}>{names.get(r.source.objectId)}</button><span>{relationLabels[r.type]} ({r.type})</span><ArrowRight size={15} aria-hidden="true"/><button type="button" onClick={() => onSelect(r.target.objectId)}>{names.get(r.target.objectId)}</button></div>
      <p>{r.rationale}</p><p className="metadata">{usable ? '参与当前检索' : '不参与当前检索'} · {reason}</p><p className="metadata">依据 ID：{r.evidenceIds.join(' / ')} · 关系 ID：{r.id}</p>
    </li>)}</ul> : <p className="empty-state">当前范围内未记录关系</p>}
    <footer className="detail-actions">{canRecordUse && !detail.history ? <a className="command-link" href={links.learning}><ClipboardCheck size={17} aria-hidden="true"/>记录采用 / 不采用</a> : <span className="metadata">采用记录待本次检索确认</span>}<a className="command-link" href={links.governance}><FilePenLine size={17} aria-hidden="true"/>修订此版本</a><a className="command-link" href={links.handoff}><BookOpen size={17} aria-hidden="true"/>交接现场</a></footer>
  </article>;
}
