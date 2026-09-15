import { ArrowRight, ExternalLink, GitCommitHorizontal } from 'lucide-react';
import type { CommitReceipt } from '../../contracts/domain';
import { safeUrl } from './links';
export function ResultPanel({ receipt, nodeId, conversationId, mode, titleId = 'handoff-result-title', onNavigate }: {
  receipt: CommitReceipt; nodeId?: string; conversationId?: string; mode: string; titleId?: string; onNavigate?: () => boolean;
}) {
  return <section className="handoff-result" aria-labelledby={titleId}>
    <h2 id={titleId} tabIndex={-1}><GitCommitHorizontal size={22} />提交结果</h2>
    <p role="status">{mode === 'fixture' ? 'Fixture 回执 · ' : ''}Git 已保存</p>
    <dl><div><dt>提交版本</dt><dd><code>{receipt.revision}</code></dd></div><div><dt>操作 ID</dt><dd><code>{receipt.changeSetId}</code></dd></div>
      <div><dt>知识库索引</dt><dd>{({ pending: '等待更新', current: '已同步', failed: '索引失败；Git 正文仍已保存' })[receipt.indexing]}</dd></div></dl>
    <div className="handoff-actions"><a href={safeUrl(receipt.commitUrl)} target="_blank" rel="noreferrer"><ExternalLink size={16} />查看 Commit</a>
      {nodeId && <a href={`#retrieval?nodeId=${encodeURIComponent(nodeId)}&revision=${encodeURIComponent(receipt.revision)}`}
        onClick={(event) => { if (onNavigate && !onNavigate()) event.preventDefault(); }}><ArrowRight size={16} />查看对应知识</a>}
      {conversationId && <a href={`#capture?conversationId=${encodeURIComponent(conversationId)}`}
        onClick={(event) => { if (onNavigate && !onNavigate()) event.preventDefault(); }}><ArrowRight size={16} />返回原始现场</a>}</div>
  </section>;
}
