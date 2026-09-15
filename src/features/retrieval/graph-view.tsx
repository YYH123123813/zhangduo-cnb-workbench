import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Crosshair, List, Network, Route, ZoomIn, ZoomOut, RotateCcw, RefreshCw, X } from 'lucide-react';
import { apiRequest } from '../../app/api-client';
import type { LocalGraphData, NodeSummary } from './api';
import type { ApiError } from '../../contracts/api';
import { latestRead } from './client-state';
import { layoutGraph, type GraphLayout } from './layout';
import { TextPaths, relationLabels } from './views';
import { evidenceLabels } from './ranking';

type SelectionProps = { graph: LocalGraphData; selectedId: string | null; onSelect: (id: string) => void };
const colors = { supports: '#286f58', depends_on: '#386c96', contradicts: '#a74453', supersedes: '#8a651f' } as const;
interface GraphRead { key: string; data: LocalGraphData }
export const graphRequestKey = (center: NodeSummary | null, snapshotRevision: string | undefined, depth: number, refresh: number) =>
  center ? JSON.stringify([center.id, center.revision, snapshotRevision ?? null, depth, refresh]) : null;
export const currentGraph = (stored: GraphRead | null, key: string | null) => key !== null && stored?.key === key ? stored.data : null;
export function GraphNodeList({ graph, selectedId, onSelect }: SelectionProps) {
  return <ul className="graph-node-list">{graph.nodes.map((n) => <li key={n.id}><button type="button" aria-pressed={selectedId === n.id} onClick={() => onSelect(n.id)}><span>{n.title}</span><span className="metadata">{n.id} · {n.revision} · {evidenceLabels[n.evidenceStatus]}</span></button></li>)}</ul>;
}
export function GraphCanvas({ graph, selectedId, onSelect, layout, zoom }: SelectionProps & { layout: GraphLayout | null; zoom: number }) {
  const marker = useId().replace(/:/g, '');
  if (!layout) return <><p className="notice" role="status">布局不可用，当前为同一子图的节点列表。</p><GraphNodeList graph={graph} selectedId={selectedId} onSelect={onSelect}/></>;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n])); const edges = new Map(graph.relations.map((r) => [r.id, r]));
  const shortTitle = (text: string) => { const chars = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)]; return chars.slice(0, 25).map((c) => c.segment).join('') + (chars.length > 25 ? '…' : ''); };
  return <div className="graph-scaled-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="graph-stage" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
    <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64756e"/></marker></defs>{layout.edges.map((p) => {
      const edge = edges.get(p.id)!;
      return <g key={p.id}><path d={p.points.map((v, i) => `${i ? 'L' : 'M'} ${v.x} ${v.y}`).join(' ')} fill="none" stroke={colors[edge.type]} strokeWidth="1.6" markerEnd={`url(#${marker})`} strokeDasharray={edge.type === 'contradicts' ? '5 4' : undefined}/><rect x={p.x - 54} y={p.y - 10} width="108" height="20" fill="#fafbfa"/><text x={p.x} y={p.y + 4} textAnchor="middle" fill={colors[edge.type]} fontSize="12">{relationLabels[edge.type]}</text></g>;
    })}</svg>
    {layout.nodes.map((p) => { const n = nodes.get(p.id)!; return <button type="button" className="graph-node" key={p.id} data-node-id={n.id} title={n.title} aria-label={`${n.title}；${evidenceLabels[n.evidenceStatus]}；版本 ${n.revision}`} aria-pressed={selectedId === n.id} style={{ left: p.x, top: p.y, width: p.width, height: p.height }} onClick={() => onSelect(n.id)}><span aria-hidden="true">{shortTitle(n.title)}</span><span className="metadata" aria-hidden="true">{evidenceLabels[n.evidenceStatus]}</span></button>; })}
  </div></div>;
}

export function GraphBrowser({ center, snapshotRevision, selectedId, onSelect, onRecenter, canRecenter = Boolean(selectedId), onFailure, reader }: {
  center: NodeSummary | null; snapshotRevision?: string; selectedId: string | null; onSelect: (id: string) => void; onRecenter: () => void;
  canRecenter?: boolean; onFailure?: (error: ApiError) => void; reader?: ReturnType<typeof latestRead>;
}) {
  const [stored, setGraph] = useState<GraphRead | null>(null);
  const [depth, setDepth] = useState(1); const [view, setView] = useState<'graph' | 'list' | 'paths'>('graph');
  const [zoom, setZoom] = useState(1); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [refresh, setRefresh] = useState(0);
  const requestKey = graphRequestKey(center, snapshotRevision, depth, refresh);
  const graph = currentGraph(stored, requestKey);
  const localReader = useRef(latestRead()); const reads = reader ?? localReader.current; const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const signal = reads.start(); setGraph(null); setError('');
    if (!center || requestKey === null) { setLoading(false); return () => reads.cancel(); }
    setLoading(true);
    const params = new URLSearchParams({ depth: String(depth), revision: center.revision });
    if (snapshotRevision) params.set('snapshotRevision', snapshotRevision);
    void apiRequest<LocalGraphData>(`/api/retrieval/graph/${encodeURIComponent(center.id)}?${params}`, { signal }).then((response) => {
      if (!reads.active(signal)) return;
      if (response.ok) setGraph({ key: requestKey, data: response.data });
      else { setError(response.error.code === 'CONFLICT' ? '图谱版本已变化，请重新检索。' : response.error.message); onFailure?.(response.error); }
    }).catch(() => { if (reads.active(signal)) setError('局部图读取失败，已有文本结果保留。'); }).finally(() => { if (reads.active(signal)) setLoading(false); });
    return () => reads.cancel();
  }, [center?.id, center?.revision, snapshotRevision, depth, refresh, requestKey, reads, onFailure]);
  const layout = useMemo(() => graph ? layoutGraph(graph) : null, [graph]);
  useEffect(() => {
    if (!viewport.current || !layout || view !== 'graph') return;
    const n = layout.nodes.find((n) => n.id === selectedId) ?? layout.nodes.find((n) => n.id === graph?.rootId);
    if (n) viewport.current.scrollTo({ left: Math.max(0, (n.x + n.width / 2) * zoom - viewport.current.clientWidth / 2), top: Math.max(0, n.y * zoom - 28) });
  }, [layout, zoom, selectedId, view, graph?.rootId]);
  const tabs = [['graph', Network, '局部图'], ['list', List, '节点列表'], ['paths', Route, '文本路径']] as const;
  function changeView(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    const id = tabs[next]![0]; setView(id); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-view="${id}"]`)?.focus();
  }
  return <section className="local-graph-section" aria-label="局部关系浏览" aria-busy={loading}><header className="retrieval-heading"><div><h2>局部关系</h2><p className="metadata">{center ? `中心：${center.title}` : '尚未选择图谱中心'}</p></div><div className="heading-actions"><label className="depth-control">关系范围<select value={depth} onChange={(e) => setDepth(Number(e.target.value))}><option value={1}>一跳</option><option value={2}>两跳</option></select></label><button type="button" className="tool-button" aria-label="以选中知识为中心" title="以选中知识为中心" disabled={!canRecenter} onClick={onRecenter}><Crosshair size={18}/></button><button type="button" className="tool-button" aria-label="刷新局部图" title="刷新局部图" disabled={loading || !center} onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={18}/></button><button type="button" className="tool-button" aria-label="取消局部图读取" title="取消局部图读取" disabled={!loading} onClick={() => { reads.cancel(); setLoading(false); setError('局部图读取已取消。'); }}><X size={18}/></button></div></header>
    <div className="view-tabs" role="tablist" aria-label="局部关系视图">{tabs.map(([id, Icon, label], i) => <button type="button" role="tab" key={id} id={`local-tab-${id}`} data-view={id} aria-selected={view === id} tabIndex={view === id ? 0 : -1} aria-controls={`local-panel-${id}`} onKeyDown={(e) => changeView(e, i)} onClick={() => setView(id)}><Icon size={16} aria-hidden="true"/>{label}</button>)}</div>
    {error && <p role="alert" className="error-line">{error}</p>}{loading && <p role="status">正在读取局部关系</p>}
    {graph && <><p className="metadata">{graph.nodes.length} / 15 个节点 · {graph.relations.length} 条正式关系 · {graph.snapshotRevision}</p>{graph.warnings.map((w) => <p className="notice" key={w}>{w}</p>)}<div role="tabpanel" id={`local-panel-${view}`} aria-labelledby={`local-tab-${view}`} tabIndex={0}>
      {view === 'graph' ? <><div className="graph-tools"><button className="tool-button" type="button" aria-label="缩小图谱" title="缩小图谱" disabled={zoom <= 0.5} onClick={() => setZoom((v) => Math.max(0.5, v - 0.25))}><ZoomOut size={18}/></button><output aria-label="缩放比例">{Math.round(zoom * 100)}%</output><button className="tool-button" type="button" aria-label="放大图谱" title="放大图谱" disabled={zoom >= 2} onClick={() => setZoom((v) => Math.min(2, v + 0.25))}><ZoomIn size={18}/></button><button className="tool-button" type="button" aria-label="还原缩放" title="还原缩放" onClick={() => setZoom(1)}><RotateCcw size={18}/></button></div><div className="graph-viewport" ref={viewport} tabIndex={0} aria-label="局部图滚动区域"><GraphCanvas graph={graph} selectedId={selectedId} onSelect={onSelect} layout={layout} zoom={zoom}/></div></> : view === 'list' ? <GraphNodeList graph={graph} selectedId={selectedId} onSelect={onSelect}/> : <TextPaths paths={graph.paths} nodes={graph.nodes} selectedId={selectedId} onSelect={onSelect}/>}
    </div></>}
  </section>;
}
