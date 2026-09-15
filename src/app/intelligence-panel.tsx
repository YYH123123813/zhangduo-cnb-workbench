import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BrainCircuit, Check, Play, RefreshCw, RotateCcw, Save, Settings2, Square, Trash2, X } from 'lucide-react';
import { DEFAULT_INTELLIGENCE, IntelligenceSettingsSchema, trainingWeight, type IntelligenceOverview, type IntelligenceSettings, type TrainingRun } from '../contracts/intelligence';
import type { NavigationProps } from '../contracts/navigation';
import { SettingsReceiptSchema, useIntelligence } from './intelligence-client';
import { activationBlockReason, buildTrainingCommand, captureTrainingApproval, intelligenceLeaveState, isTrainingApprovalCurrent,
  reconcileSettingsDraft, settingsDraft, settingsEqual, trainingBlockReason, type IntelligenceMutation, type NodeSelection, type SettingsDraft, type TrainingApproval } from './intelligence-ui-state';
import './intelligence.css';

const providerNames = { cnb: 'CNB AI', openai: 'OpenAI API', local: '本地兼容 API' };
const stateNames = { running: '训练中', completed: '已完成', failed: '失败', interrupted: '已中断', deleted: '已删除' };
export function IntelligencePanel({ registerLeaveGuard }: NavigationProps) {
  const { data, message, busy, refreshing, readingOperation, verified, denied, accessVersion, unresolved, refresh, readOperation, execute, setMessage } = useIntelligence();
  const [edit, setEdit] = useState<SettingsDraft | null>(null);
  const [tab, setTab] = useState<'settings' | 'runs'>('settings');
  const [mode, setMode] = useState<'smoke' | 'lora'>('smoke');
  const [selected, setSelected] = useState<NodeSelection>({}), [approval, setApproval] = useState<TrainingApproval | null>(null);
  const guard = useRef<'clean' | 'dirty' | 'blocked'>('clean');
  const dirty = Boolean(edit && !settingsEqual(edit.value, edit.baseSettings));
  const locked = busy || refreshing || readingOperation || !verified || Boolean(unresolved);
  const editingLocked = busy || readingOperation || !verified || Boolean(unresolved);
  guard.current = denied ? 'clean' : intelligenceLeaveState(busy, Boolean(unresolved), dirty || Object.keys(selected).length ? ['draft'] : []);
  useEffect(() => registerLeaveGuard?.({ owner: 'intelligence', getState: () => guard.current,
    onBlocked: () => setMessage('原操作正在处理或尚未核验，请先只读核验。') }), [registerLeaveGuard, setMessage]);
  useEffect(() => { setEdit(null); setSelected({}); setApproval(null); setMode('smoke'); }, [accessVersion]);
  useEffect(() => { if (data && !denied) setEdit((current) => reconcileSettingsDraft(current, data)); }, [data, denied]);
  useEffect(() => {
    if (approval && (!data || dirty || !isTrainingApprovalCurrent(approval, data, mode, selected))) setApproval(null);
  }, [data, dirty, approval, mode, selected]);
  const running = Boolean(data?.runs.some((run) => run.state === 'running'));
  useEffect(() => {
    if (!running || denied || busy || refreshing) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [running, denied, busy, refreshing, refresh]);
  if (!data || !edit || denied) return <section className="intelligence"><h1>模型与权重</h1><p role="status">{message || '正在读取设置'}</p>
    <button type="button" onClick={() => void refresh()} disabled={busy || refreshing}><RefreshCw size={16} aria-hidden="true"/>只读重新读取</button><a className="memory-link" href="#workspace">工作区状态</a></section>;
  const draft = edit.value, baseRevision = edit.baseRevision;
  const conflict = verified && baseRevision !== data.revision;
  const valid = IntelligenceSettingsSchema.safeParse(draft).success;
  const consent = !dirty && !conflict && valid && isTrainingApprovalCurrent(approval, data, mode, selected);
  const trainingBlocked = dirty ? '设置有未保存修改。' : conflict ? '设置版本已变化，请先处理冲突。' : !valid ? '训练参数无效。' : trainingBlockReason(data, mode, selected);
  const update = (next: IntelligenceSettings) => { setEdit({ ...edit, value: next }); setApproval(null); };
  const reset = () => { setEdit(settingsDraft(data)); setApproval(null); setMessage('已采用当前服务器设置，未提交变更。'); };
  const weightControls: { key: keyof IntelligenceSettings['weights']; label: string; min: number; max: number; step: number }[] = [
    { key: 'defaultImportance', label: '默认重要性', min: 0, max: 5, step: 0.25 },
    { key: 'reuseInfluence', label: '已采用次数增益', min: 0, max: 2, step: 0.05 },
    { key: 'correctionBoost', label: '人工修订增益', min: 1, max: 3, step: 0.1 },
    { key: 'maxWeight', label: '单样本权重上限', min: 1, max: 10, step: 0.25 },
  ];
  const save = async () => {
    if (locked || !dirty || !valid || conflict) return;
    const result = await execute({ action: 'settings', operationId: crypto.randomUUID(), expectedRevision: baseRevision, settings: draft, confirmed: true });
    if (!result) return;
    setApproval(null);
    if (result.ok) { setEdit(settingsDraft(SettingsReceiptSchema.parse(result.data))); setMessage('设置已保存，训练同意需重新确认。'); void refresh(); }
    else if (result.error.code === 'CONFLICT') void refresh();
  };
  const start = async () => {
    if (locked || !consent || trainingBlocked) return;
    const command = buildTrainingCommand(approval, data, mode, selected, crypto.randomUUID());
    if (!command) { setApproval(null); return; }
    const result = await execute(command);
    if (!result) return;
    setApproval(null);
    if (result.ok) { setTab('runs'); setSelected({}); setMessage('训练请求已受理，尚未启用适配器。'); void refresh(); }
    else if (result.error.code === 'CONFLICT') void refresh();
  };
  const runCommand = async (command: IntelligenceMutation) => {
    if (locked) return;
    const result = await execute(command);
    if (result?.ok) { setMessage(command.action === 'delete_run' ? '本次训练产物已删除，外部基础模型和物理残留未同时删除。' : command.action === 'activate' ? '已单独启用为候选提取试用适配器。' : '已停用适配器，后续提取使用所选 API。'); void refresh(); }
  };
  const verifyOriginal = async () => {
    const original = unresolved?.command;
    const receipt = await readOperation();
    if (!receipt) return;
    const latest = await refresh();
    if (!latest) return;
    setApproval(null);
    if (receipt.state === 'completed' && original?.action === 'settings' && latest.revision === receipt.result?.revision && settingsEqual(latest.settings, original.settings)) setEdit(settingsDraft(latest));
    if (receipt.state === 'completed' && original?.action === 'train') { setSelected({}); setTab('runs'); }
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'settings' : event.key === 'End' ? 'runs' : tab === 'settings' ? 'runs' : 'settings';
    setTab(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  };
  return <section className="intelligence" aria-busy={busy || refreshing || readingOperation}>
    <header className="intelligence-heading"><div><p className="eyebrow">掌舵 / 个人模型</p><h1><Settings2 size={25} aria-hidden="true"/>模型与权重</h1></div>
      <button type="button" className="icon-button" title="只读刷新状态" aria-label="只读刷新状态" onClick={() => void refresh()} disabled={busy || refreshing}><RefreshCw size={18} aria-hidden="true"/></button></header>
    <div className="intelligence-tabs" role="tablist" aria-label="模型设置视图">
      <button type="button" id="memory-settings-tab" data-view="settings" role="tab" aria-controls="memory-settings-panel" aria-selected={tab === 'settings'} tabIndex={tab === 'settings' ? 0 : -1} onKeyDown={tabKeys} onClick={() => setTab('settings')}>参数与权重</button>
      <button type="button" id="memory-runs-tab" data-view="runs" role="tab" aria-controls="memory-runs-panel" aria-selected={tab === 'runs'} tabIndex={tab === 'runs' ? 0 : -1} onKeyDown={tabKeys} onClick={() => setTab('runs')}>训练记录 <span>{data.runs.length}</span></button>
    </div>
    {message && <p className="intelligence-message" role="status">{message}</p>}
    {unresolved && <div className="intelligence-message" role="status"><strong>原操作待核验</strong><p>操作编号：{unresolved.operationId}。当前状态不等于原操作回执，未核验前不能再次提交。</p>
      <button type="button" onClick={() => void verifyOriginal()} disabled={busy || refreshing || readingOperation}><RefreshCw size={16} aria-hidden="true"/>只读核验</button></div>}
    <div id="memory-settings-panel" role="tabpanel" aria-labelledby="memory-settings-tab" hidden={tab !== 'settings'} tabIndex={0}>
      {conflict && <div className="intelligence-message" role="alert"><strong>设置版本冲突</strong><p>草稿基于版本 {baseRevision}，服务器现为版本 {data.revision}。草稿已保留，尚未覆盖服务器。</p>
        <button type="button" onClick={() => { if (window.confirm('放弃本地设置草稿并采用最新服务器版本？')) reset(); }} disabled={locked}><RotateCcw size={16} aria-hidden="true"/>放弃草稿并采用服务器版本</button></div>}
      <fieldset className="intelligence-fields" disabled={editingLocked}>
        <legend className="intelligence-sr-only">模型、样本权重与训练参数</legend>
        <section className="intelligence-section"><h2 id="provider-heading">模型来源</h2><div className="provider-options" role="radiogroup" aria-labelledby="provider-heading">
          {(Object.keys(providerNames) as IntelligenceSettings['provider'][]).map((id) => {
            const provider = data.providers.find((item) => item.id === id);
            return <label key={id}><input type="radio" name="ai-provider" value={id} checked={draft.provider === id} onChange={() => update({ ...draft, provider: id })}/>
              <span><strong>{providerNames[id]}</strong><small>{!provider ? '服务器未报告状态' : provider.ready ? provider.model || '服务器已配置' : '服务端未配置'}</small></span>{provider?.ready && <Check size={16} aria-hidden="true"/>}</label>;
          })}
        </div><p className="intelligence-hint">API 密钥仅由服务器管理。</p></section>
        <section className="intelligence-section"><div className="section-title"><h2>训练样本权重</h2><button type="button" className="icon-button" title="恢复默认权重" aria-label="恢复默认权重"
          onClick={() => update({ ...draft, weights: { ...DEFAULT_INTELLIGENCE.weights }, importance: {} })}><RotateCcw size={16} aria-hidden="true"/></button></div>
          <div className="weight-controls">{weightControls.map((control) => <label key={control.key} htmlFor={`weight-${control.key}`}><span>{control.label}</span>
            <div><input id={`weight-${control.key}`} type="range" min={control.min} max={control.max} step={control.step} value={draft.weights[control.key]}
              onChange={(event) => update({ ...draft, weights: { ...draft.weights, [control.key]: event.target.valueAsNumber } })}/><output htmlFor={`weight-${control.key}`}>{draft.weights[control.key].toFixed(2)}</output></div></label>)}</div>
          <div className="section-title"><h3>确认节点</h3><span>{Object.keys(selected).length} / 100 已选</span></div>
          {Object.keys(selected).length > 0 && <button type="button" onClick={() => { setSelected({}); setApproval(null); }}><X size={16} aria-hidden="true"/>清空选择</button>}
          <div className="knowledge-weights" role="group" aria-label="逐条知识权重">
            {data.samplesStatus?.state === 'unavailable' && <p className="intelligence-message" role="status">{data.samplesStatus.message || '节点来源暂不可用，未开始个人知识训练。'}</p>}
            {data.samples.length === 0 && data.samplesStatus?.state !== 'unavailable' ? <p>暂无已确认的知识节点。</p> : data.samples.map((sample) => {
              const importance = draft.importance[sample.id] ?? draft.weights.defaultImportance;
              const invalid = !Number.isFinite(importance) || importance < 0 || importance > 5;
              const stale = Boolean(selected[sample.id] && selected[sample.id] !== sample.revision);
              return <div className="knowledge-weight" key={sample.id}>
                <label className="sample-select"><input type="checkbox" checked={Boolean(selected[sample.id])} disabled={!selected[sample.id] && Object.keys(selected).length >= 100}
                  onChange={(event) => { const next = { ...selected }; if (event.target.checked) next[sample.id] = sample.revision; else delete next[sample.id]; setSelected(next); setApproval(null); }}/>
                  <span><strong>{sample.title}</strong><small>已采用 {sample.uses} 次{sample.corrected ? ' / 人工修订' : ''}</small><small>版本 {sample.revision}</small>
                    {stale && <strong className="intelligence-invalid">版本已变化，请取消后重新选择</strong>}</span></label>
                <div className="sample-number"><label>重要性<input type="number" min="0" max="5" step="any" required aria-label={`${sample.title}的重要性`} aria-invalid={invalid}
                  value={Number.isFinite(importance) ? importance : ''} onChange={(event) => update({ ...draft, importance: { ...draft.importance, [sample.id]: event.target.valueAsNumber } })}/></label>
                  {Object.hasOwn(draft.importance, sample.id) && <button type="button" className="icon-button" title="恢复此节点默认重要性" aria-label={`恢复${sample.title}的默认重要性`}
                    onClick={() => { const next = { ...draft.importance }; delete next[sample.id]; update({ ...draft, importance: next }); }}><RotateCcw size={14} aria-hidden="true"/></button>}</div>
                <output className="sample-effective">训练权重<strong>{valid ? trainingWeight(draft, sample).toFixed(3) : '参数无效'}</strong>{!invalid && importance === 0 && <small>不纳入训练</small>}</output>
              </div>;
            })}
            {Object.entries(selected).filter(([id]) => !data.samples.some((sample) => sample.id === id)).map(([id, revision]) => <div key={id} className="intelligence-message" role="status">
              <p>已选节点不可用：{id} / {revision}</p><button type="button" onClick={() => { const next = { ...selected }; delete next[id]; setSelected(next); setApproval(null); }}><X size={16} aria-hidden="true"/>移除该选择</button></div>)}
          </div>
        </section>
        <section className="intelligence-section"><h2>训练参数</h2><div className="training-parameters">
          <label>学习率<input type="number" min="0.000001" max="0.005" step="any" required aria-describedby="training-parameter-limits" aria-invalid={!Number.isFinite(draft.learningRate) || draft.learningRate < 0.000001 || draft.learningRate > 0.005}
            value={Number.isFinite(draft.learningRate) ? draft.learningRate : ''} onChange={(event) => update({ ...draft, learningRate: event.target.valueAsNumber })}/></label>
          <label>训练步数<input type="number" min="5" max="200" step="1" required aria-describedby="training-parameter-limits" aria-invalid={!Number.isInteger(draft.steps) || draft.steps < 5 || draft.steps > 200}
            value={Number.isFinite(draft.steps) ? draft.steps : ''} onChange={(event) => update({ ...draft, steps: event.target.valueAsNumber })}/></label>
          <div className="training-runtime"><BrainCircuit size={20} aria-hidden="true"/><span>Transformer + LoRA<small>{data.training.ready ? '训练环境已就绪' : '训练环境未配置'}</small><small>{data.training.pretrainedReady ? '本地预训练模型文件已配置' : '本地预训练模型文件未配置'}</small></span></div>
        </div><p id="training-parameter-limits" className="intelligence-hint">学习率 0.000001 至 0.005；训练步数为 5 至 200 的整数；节点重要性 0 至 5。</p>
        {!valid && <p role="alert" className="intelligence-invalid">存在空值或超范围参数，未保存，也不能训练。</p>}
        <div className="intelligence-actions"><button type="button" className="primary" onClick={() => void save()} disabled={locked || !dirty || !valid || conflict}><Save size={17} aria-hidden="true"/>保存设置</button>
          <button type="button" onClick={reset} disabled={locked || (!dirty && !conflict)}><RotateCcw size={17} aria-hidden="true"/>放弃修改</button><span>{dirty ? `未保存 / 基于版本 ${baseRevision}` : `设置版本 ${baseRevision}`}</span></div></section>
      </fieldset>
      <section className="intelligence-section"><h2>新建训练</h2><label className="training-mode">训练模式<select value={mode} disabled={editingLocked} onChange={(event) => { setMode(event.target.value as typeof mode); setApproval(null); }}>
        <option value="smoke">smoke / 合成结构验证</option><option value="lora" disabled={!data.training.pretrainedReady}>LoRA / 个人知识</option></select></label>
        <dl className="training-facts"><div><dt>数据范围</dt><dd>{mode === 'smoke' ? '16 条内置合成样本，不读取私人知识' : `${Object.keys(selected).length} 个选中节点的已选版本及其对话来源`}</dd></div>
          <div><dt>模型基础</dt><dd>{mode === 'smoke' ? '随机初始化的小模型' : '本地预训练模型 / LoRA'}</dd></div>
          <div><dt>设置版本</dt><dd>{baseRevision}</dd></div><div><dt>权重范围</dt><dd>{mode === 'smoke' ? '仅用固定合成权重，不使用个人节点权重' : '已保存的个人样本权重'}</dd></div><div><dt>模型启用</dt><dd>{mode === 'smoke' ? '不可启用为生产提取器' : '训练后单独确认试用'}</dd></div><div><dt>留出验证</dt><dd>按原始对话分组，来源分组由服务器核验</dd></div></dl>
        {trainingBlocked && <p className="intelligence-hint" role="status">{trainingBlocked}</p>}
        <label className="intelligence-consent"><input type="checkbox" checked={consent} disabled={locked || Boolean(trainingBlocked)} onChange={(event) => setApproval(event.target.checked ? captureTrainingApproval(data, mode, selected) : null)}/>
          <span>同意按上述版本与范围在本机训练，样本和模型文件保留至主动删除。不发送到第三方训练平台，不自动启用或改写正式知识。</span></label>
        <button type="button" className="primary" onClick={() => void start()} disabled={locked || !consent || Boolean(trainingBlocked)}><Play size={17} aria-hidden="true"/>开始训练</button>
      </section>
    </div><div id="memory-runs-panel" role="tabpanel" aria-labelledby="memory-runs-tab" hidden={tab !== 'runs'} tabIndex={0}>
      <div className="training-active"><span>当前知识提取适配器</span><strong>{data.training.activeRunId ? '本地 LoRA（试用）' : '未启用，使用所选 API'}</strong>
        {data.training.activeRunId && <><code>{data.training.activeRunId}</code><button type="button" onClick={() => {
          if (window.confirm('停用当前适配器并恢复使用所选 API？不会删除训练产物或正式知识。')) void runCommand({ action: 'deactivate', operationId: crypto.randomUUID(), confirmed: true });
        }} disabled={locked}><Square size={16} aria-hidden="true"/>停用适配器</button></>}</div>
      {!data.runs.length && <p className="empty-memory">暂无训练记录。</p>}
      {data.runs.map((run) => <TrainingResult key={run.id} run={run} active={data.training.activeRunId === run.id} busy={locked} samples={data.samples} remove={() => {
        if (window.confirm('删除本次训练的样本和适配器文件，并停用该适配器？不会删除正式知识、来源或外部基础模型；备份和磁盘物理残留未核验。')) void runCommand({ action: 'delete_run', id: run.id, operationId: crypto.randomUUID(), confirmed: true });
      }} activate={() => {
        if (activationBlockReason(run, data.samples)) return;
        if (window.confirm('单独启用此适配器进行后续候选提取试用？这不是知识正确或能力认证，已有知识和图谱不会自动改写。')) void runCommand({ action: 'activate', id: run.id, operationId: crypto.randomUUID(), confirmed: true });
      }}/>)}</div>
  </section>;
}
export function TrainingResult({ run, active, busy, samples, activate, remove }: { run: TrainingRun; active: boolean; busy: boolean; samples: IntelligenceOverview['samples']; activate: () => void; remove: () => void }) {
  const m = run.metrics;
  const activationBlocked = activationBlockReason(run, samples);
  return <article className="training-result"><header><strong>{run.mode === 'smoke' ? '合成结构验证' : '个人知识 LoRA'}</strong><span className={`training-state ${run.state}`}>{stateNames[run.state]}</span></header>
    <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString('zh-CN')}</time><p>{run.message}</p>
    {run.completedAt && <p className="intelligence-hint">结束于 <time dateTime={run.completedAt}>{new Date(run.completedAt).toLocaleString('zh-CN')}</time></p>}
    <dl className="training-facts"><div><dt>设置版本</dt><dd>{run.settingsRevision}</dd></div><div><dt>样本数</dt><dd>{run.sampleCount}</dd></div><div><dt>来源节点</dt><dd>{run.nodeRefs.length}</dd></div></dl>
    {run.state === 'interrupted' && <p role="status">{run.cleanupReady ? '服务端已核验进程停止，可单独删除本次产物；不会自动重跑。' : '进程状态待服务端核验，不能删除或自动重跑。'}</p>}
    {run.state === 'running' && <p role="status">正在运行，尚无最终指标；只读刷新不会启动新训练。</p>}
    {run.state === 'deleted' && <p>本次产物已删除；外部基础模型、备份和磁盘物理残留未同时删除。以下指标如有保留，仅为历史记录。</p>}
    {m && <dl className="training-metrics"><div><dt>训练损失</dt><dd>{m.beforeLoss.toFixed(4)} → {m.afterLoss.toFixed(4)}</dd></div><div><dt>独立验证损失</dt><dd>{m.heldOutBefore?.toFixed(4) ?? '未测'} → {m.heldOutAfter?.toFixed(4) ?? '未测'}</dd></div>
      <div><dt>参数更新量</dt><dd>{m.parameterDelta.toFixed(4)}</dd></div><div><dt>训练参数</dt><dd>{m.trainableParameters.toLocaleString()} / {m.totalParameters.toLocaleString()}</dd></div>
      <div><dt>权重影响量</dt><dd>{m.weightEffect.toPrecision(4)}</dd></div><div><dt>保存后重载</dt><dd>{m.reloadVerified ? '已核验一致' : '未通过'}</dd></div>
      <div><dt>实际步数</dt><dd>{m.steps}</dd></div><div><dt>独立验证组</dt><dd>{m.validationGroups}</dd></div></dl>}
    {!m && run.state !== 'running' && <p className="intelligence-hint">无可核验的训练指标。</p>}
    <p className="intelligence-hint">损失与参数变化不代表知识正确或能力认证。</p>
    <details><summary>本次训练范围</summary><dl className="training-facts"><div><dt>记录编号</dt><dd>{run.id}</dd></div><div><dt>数据摘要</dt><dd>{run.datasetHash || '未保留'}</dd></div></dl>
      {run.nodeRefs.length > 0 && <ul>{run.nodeRefs.map((ref) => <li key={ref.id}>{ref.id} / {ref.revision}</li>)}</ul>}</details>
    {activationBlocked && run.state !== 'deleted' && <p className="intelligence-hint">{activationBlocked}</p>}
    <div className="intelligence-actions">{run.mode === 'lora' && run.state === 'completed' && <button type="button" onClick={activate} disabled={active || busy || Boolean(activationBlocked)}><Play size={16} aria-hidden="true"/>{active ? '正在试用' : '确认试用此适配器'}</button>}
      {(['completed', 'failed'].includes(run.state) || run.state === 'interrupted' && run.cleanupReady) && <button type="button" onClick={remove} disabled={busy || !run.cleanupReady}><Trash2 size={16} aria-hidden="true"/>删除本次训练产物</button>}</div>
    {['completed', 'failed'].includes(run.state) && !run.cleanupReady && <p className="intelligence-hint">产物清理能力尚未由服务器核验。</p>}
  </article>;
}
