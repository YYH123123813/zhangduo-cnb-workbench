import type { EvidenceRecord, TaskContext } from '../../contracts/domain';
import { evidenceKindLabel } from './history';
import { savedOutcomeLinks, taskHref } from './links';

const decisionLabels = { adopt: '采用', reject: '不采用', verify_later: '待验证' };
const checkLabels = { satisfied: '本次满足', not_satisfied: '本次不满足', unknown: '本次尚不清楚' };
const coverageLabels = { current: '语义覆盖当前', partial: '语义覆盖不足', stale: '语义覆盖过期', unavailable: '语义覆盖不可用' };

export function TaskConditionDetails({ task }: { task: TaskContext }) {
  return <section aria-label="原任务前提核对"><h3>本次任务前提</h3>
    {!task.conditionChecks?.length && <p>本次前提三态未记录；任务文字不代表前提已满足。</p>}
    <ul>{task.conditionChecks?.map((check) => <li key={`${check.nodeRef.objectId}:${check.conditionId}`}>
      <p><strong>{checkLabels[check.status]}</strong> · 条件 <code>{check.conditionId}</code></p>
      <p><code>{check.nodeRef.objectId}@{check.nodeRef.revision}</code>{check.confirmedBy && <> · 确认人 {check.confirmedBy}</>}</p>
    </li>)}</ul>
  </section>;
}

export function EvidenceRecordDetails({ record, saved = true }: { record: EvidenceRecord; saved?: boolean }) {
  const context = record.useContext, outcome = record.outcome;
  return <section className="learning-evidence-details" aria-label={`${evidenceKindLabel(record.kind)}详情`}>
    <h3>{evidenceKindLabel(record.kind)}{record.kind === 'outcome' && ' · 用户自报'}</h3>
    <p>记录 <code>{record.id}</code> · 原任务 <code>{record.taskId}</code></p>
    <p>记录时间：{record.recordedAt}</p>
    {record.decision && <p>本次决定：{decisionLabels[record.decision]}</p>}
    {context ? <>
      <p>原任务：{context.task.question}</p>
      <p>任务方式：{context.task.mode === 'independent' ? '独立任务' : '辅助任务'} · 原任务时间：{context.task.updatedAt}</p>
      {context.task.sourceIssueNumber && <p>来源 Issue：{context.task.sourceIssueNumber}</p>}
      <ul aria-label="原任务条件">{context.task.constraints.map((condition) => <li key={condition.id}>{condition.text}{condition.confirmedBy && <> · 确认人 {condition.confirmedBy}</>}</li>)}</ul>
      <TaskConditionDetails task={context.task}/>
      <p>原快照 <code>{context.snapshotRevision}</code></p>
      <p>决定理由：{context.reason || '未填写'}</p>
      <ul aria-label="原知识与适用边界">{context.knowledge.map((node) => <li key={`${node.id}@${node.revision}`}>
        <h3>{node.title}</h3><p><code>{node.id}@{node.revision}</code></p><p>{node.humanStatement}</p>
        <p>原来源证据状态：{node.evidenceStatus}</p>
        {node.conditions.map((condition) => <p key={condition.id}>知识前提（{condition.status === 'confirmed' ? '正式已确认' : condition.status === 'rejected' ? '已否定' : '待核对'}）：{condition.text}</p>)}
        {node.boundaries.map((text, index) => <p key={index}>边界：{text}</p>)}
      </li>)}</ul>
      <ul aria-label="原正式关系">{context.relations.map((edge) => <li key={edge.id}><p><code>{edge.id}</code>：{edge.source.objectId} → {edge.type} → {edge.target.objectId}</p><p>{edge.rationale}</p></li>)}</ul>
      <ul aria-label="原关系路径">{context.paths.map((path, index) => <li key={index}><p>{path.nodeIds.join(' → ')}</p><p>关系：{path.relationIds.join('、') || '直接选择'}</p><p>{path.reason}</p></li>)}</ul>
      <p>{coverageLabels[context.retrievalContext.coverage]} · 检索 ID：{context.retrievalContext.queryId ?? '未记录'}</p>
      {context.retrievalContext.missingConditions.map((text, index) => <p key={`missing-${index}`}>待核对：{text}</p>)}
      {context.retrievalContext.warnings.map((text, index) => <p key={`warning-${index}`}>覆盖警告：{text}</p>)}
      <p className="learning-notice">人的使用情境 · client_preview_only；不证明受信检索、无提示作答或已经掌握。</p>
    </> : outcome ? <>
      <p>实际结果：{{ succeeded: '达到本次目标', failed: '未达到本次目标', unclear: '尚不清楚' }[outcome.status]}</p>
      <p>{outcome.summary}</p>{outcome.failureReason && <p>失败原因：{outcome.failureReason}</p>}
      <p>核验状态：用户自报（self_reported），未升级为已复核。</p>
      <a href={`#learning?${new URLSearchParams({ useId: outcome.useRecordId, taskId: record.taskId })}`}>查看原应用记录 {outcome.useRecordId}</a>
      {saved && <div className="learning-actions">{savedOutcomeLinks(record).map(({ nodeRef, href }) => <a key={href} href={href}>复核原版本 {nodeRef.objectId}</a>)}<a href={taskHref(record.taskId)}>返回原任务</a></div>}
    </> : <><p>历史条件未记录 · 不以当前条件替换</p>{record.answer && <p>{record.answer}</p>}</>}
    <p>原节点版本：{record.nodeRefs.map((ref) => `${ref.objectId}@${ref.revision}`).join('；')}</p>
  </section>;
}
