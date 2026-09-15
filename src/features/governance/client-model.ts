import type { KnowledgeNode, KnowledgeSnapshot } from '../../contracts/domain';
import type { OperationLookup } from './operation-readback';

export interface GovernanceStatus { snapshot: KnowledgeSnapshot; actorId: string; scopes: readonly string[] }
export const tabs = [
  ['knowledge', '知识修订'], ['relations', '关系'], ['history', '历史记录'],
  ['data', '数据控制'], ['settings', 'AI与隐私'], ['audit', '活动审计'],
] as const;
export type Tab = typeof tabs[number][0];
export function nextTab(current: Tab, key: string): Tab {
  const index = tabs.findIndex(([id]) => id === current);
  if (key === 'Home') return tabs[0][0];
  if (key === 'End') return tabs[tabs.length - 1]![0];
  if (key === 'ArrowRight' || key === 'ArrowLeft') return tabs[(index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]![0];
  return current;
}
export function editedNode(original: KnowledgeNode, patch: Partial<KnowledgeNode>): KnowledgeNode {
  const changedClaim = ['title', 'question', 'humanStatement', 'conditions', 'boundaries', 'sources'].some((key) => Object.hasOwn(patch, key));
  return { ...original, ...patch, evidenceStatus: changedClaim ? 'unverified' : patch.evidenceStatus ?? original.evidenceStatus };
}
export function nodePatch(original: KnowledgeNode, draft: KnowledgeNode) {
  const editable = ['title', 'question', 'humanStatement', 'conditions', 'boundaries', 'sources', 'evidenceStatus', 'lifecycle'] as const;
  return Object.fromEntries(editable.filter((key) => JSON.stringify(original[key]) !== JSON.stringify(draft[key])).map((key) => [key, draft[key]]));
}
export function retrievalLink(nodeId: string, revision: string) {
  return `#retrieval?${new URLSearchParams({ nodeId, revision }).toString()}`;
}
export function operationFromRoute(params: Readonly<Record<string, string>> = {}): OperationLookup | undefined {
  const choices = ([['changeSetId', 'knowledge'], ['approvalId', 'settings'], ['planId', 'delete']] as const)
    .flatMap(([key, kind]) => params[key] ? [{ kind, id: params[key]! }] : []);
  return choices.length === 1 && /^[^\s\x00-\x1f\x7f]{1,160}$/.test(choices[0]!.id) ? choices[0] : undefined;
}
export const stateLabels: Record<string, string> = {
  confirmed: '已确认', draft: '草稿', proposed: '待确认', active: '有效', needs_review: '待复核', superseded: '已替代', withdrawn: '已撤回', rejected: '已拒绝',
  supported: '有来源支持', partial: '部分支持', unverified: '未经验证', disputed: '存在争议', unknown: '未知',
  supports: '支持', depends_on: '依赖', contradicts: '冲突', supersedes: '替代',
  unchanged: '引用版本未变', changed: '引用版本已变', excluded: '已阻断检索', missing: '当前版本不存在', not_present: '当前未发现', not_blocked: '尚未阻断',
  done: '平台报告完成', pending: '待完成', failed: '失败', unsupported: '不支持自动清除', cancelled: '已取消', success: '成功', denied: '已拒绝',
  registered: '已登记', revoked: '已撤回', expired: '已过期', not_registered: '尚未查到登记', current: '当前', discarded: '输出已丢弃',
  not_written: '未写入', preserved: '原数据/草稿保留', unknown_result: '结果未知',
};
export const label = (value: string) => stateLabels[value] ?? value;
