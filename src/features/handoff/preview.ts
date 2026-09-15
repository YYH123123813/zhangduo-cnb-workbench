import type { Candidate, ChangeSet, HandoffDraft, KnowledgeSnapshot } from '../../contracts/domain';
import { isAICandidate } from './model';
import type { ReviewSubject } from './model';

export interface DiffRow { action: 'add' | 'remove' | 'change'; label: string; before: string; after: string }
export interface HandoffPreview { draft: HandoffDraft; changes: ChangeSet; diff: { rows: DiffRow[]; impacts: string[] } }
const conditionLabels = { confirmed: '条件成立', unknown: '未核验', rejected: '条件不成立' };
const supportLabels = { supports: '支持', partial: '部分支持', does_not_support: '不支持', unverified: '未核验' };
const relationLabels = { supports: '支持', depends_on: '依赖', contradicts: '冲突', supersedes: '替代' };

export function readableDiff(changes: ChangeSet, snapshot: KnowledgeSnapshot, candidate: ReviewSubject): HandoffPreview['diff'] {
  const rows: DiffRow[] = [];
  const impacts: string[] = [];
  for (const node of changes.nodes) {
    const old = snapshot.nodes.find((entry) => entry.id === node.id);
    rows.push({ action: old ? 'change' : 'add', label: `知识：${node.title}`, before: old?.humanStatement ?? '尚无正式知识', after: node.humanStatement });
    rows.push({ action: 'add', label: '作者身份', before: isAICandidate(candidate) ? 'AI 仅提议' : '手动来源，无 AI 候选', after: ({ human_written: '人撰写', human_edited: '人编辑 AI 文本', ai_accepted: '接受 AI 原文' })[node.authorship] });
    rows.push({ action: 'add', label: '条件与边界', before: old?.conditions.map((condition) => condition.text).join('\n') || '未确认',
      after: [...node.conditions.map((condition) => `${condition.text}（${conditionLabels[condition.status]}）`), ...node.boundaries].join('\n') || '无边界记录' });
    for (const source of node.sources) rows.push({ action: 'add', label: `来源：${source.title}`, before: source.excerpt,
      after: `${supportLabels[source.support]}\n对应主张：${source.supportedClaim || '尚未核验'}\n范围限制：${source.limitation || '未填写'}` });
    for (const source of (old?.sources ?? candidate.sources).filter((source) => !node.sources.some((entry) => entry.id === source.id))) {
      rows.push({ action: 'remove', label: `未随本条入库的来源：${source.title}`, before: source.excerpt, after: '不随本次提交保存；原始现场保持不变。' });
    }
    if (node.conditions.some((condition) => condition.status !== 'confirmed')) impacts.push('仍有未满足或未核验条件，后续检索不能无条件采用本条。');
    if (node.evidenceStatus !== 'supported') impacts.push('来源支持尚非充分支持；人的确认不会补足来源证据。');
  }
  for (const relation of changes.relations) rows.push({ action: 'add', label: `关系：${relationLabels[relation.type]}`, before: '本次尚未入库',
    after: `${relation.source.objectId} @ ${relation.source.revision}\n→ ${relationLabels[relation.type]} →\n${relation.target.objectId} @ ${relation.target.revision}\n理由：${relation.rationale}\n依据：${relation.evidenceIds.join('、')}` });
  for (const id of changes.withdrawnIds) {
    const node = snapshot.nodes.find((entry) => entry.id === id);
    const relation = snapshot.relations.find((entry) => entry.id === id);
    rows.push({ action: 'remove', label: `撤回：${node?.title ?? id}`, before: node?.humanStatement ?? relation?.rationale ?? `未知对象 ${id}`,
      after: '未来检索排除；不代表 Git 历史或平台副本已物理删除。' });
  }
  impacts.push('Git 保存结果与知识库索引状态分别报告。');
  impacts.push('本次不生成使用或学习行为证据。');
  return { rows, impacts: [...new Set(impacts)] };
}
