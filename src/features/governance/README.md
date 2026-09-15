# 版本演进与数据控制

窗口六首版收口模块。本轮消费基线为正式发布的1.25 `review_private_state`，最新正式公告为1.26.0；源码登记1.27.0但尚无正式发布公告，索引专项待通知。知识修订/恢复、关系撤回、原子提交、固定版本读回、设置CAS与精确回执、结构化历史、证据导出、分层删除、1.18审计关联、1.19治理原载荷、1.21专用`demo_export`和1.22只读`operation-recovery`已接实际共享Services/HTTP，未在本轮重做。删除新层专项为`integrated`；整体仍`blocked`，本轮普通导出发现共享文件集合不一致。不是授权CNB、浏览器或G4/G5最终验收。

## 当前验证快照（2026-09-16 02:50，Asia/Shanghai）

- 新增`delete-review-state.test.ts`和`delete-review-integration.test.ts`：20/20通过，先取得10项失败证据再做最小修复。实际Services/ApprovalAuthority/SQLite/HTTP覆盖未经批准不清理、旧批准/错范围/跨身份拒绝、正文屏障、最小原事件回执和原planId丢响应/重开只读恢复。
- 相关删除与静态页面语义回归：37/37通过；静态React标记不是浏览器验收。
- 治理全量：31文件、263项，257通过、6失败。失败定位为共享`knowledgeFiles()`新增`knowledge-index/*.md`被普通`exportData()`复用，超出当前治理预览文件集合，安全校验拒绝下载。已交窗口一W6-REQ-012，未改共享代码、未放宽白名单或字节核验。
- `pnpm exec tsc --noEmit`通过；02:42的`pnpm typecheck`曾因节点五`retained-operation`尚未落地报TS2307，发现节点五补入模块后定向重查，02:50最终`pnpm typecheck`通过，此项不再阻塞。`pnpm check:boundaries`通过：6 workers、75 task documents、78 uniquely owned routes。
- 本轮未启服务器，未跑浏览器/build/全库test；真实CNB、模型、删除、部署、公开及G4/G5均未验收。具体命令、时刻和恢复条件见节点六03/04；不循环刷新历史数量。

## 删除新层

`review_private_state`展示为“审核题、作答与答案暴露记录”：清理关联审核题（含标准答案和提示）、作答正文及答案暴露记录的行内状态，保留最小原操作回执。导入源文件、SQLite页/WAL、备份的物理清除未核验。应用检索阻断不等于行内正文清理，更不等于物理擦除；普通Git版本恢复不能解除应用删除屏障。

预览、完整范围确认、执行结果和原计划只读核验使用同一层标识/中文后果。中文只在展示投影中，不改平台计划或摘要。批准绑定完整原planId/hash/范围，新增层或改变计划不能沿用旧批准。缺原报告仍展示原层并标unknown，缺执行层标pending；failed/unsupported等状态及原报告细节不被说明文字覆盖，不自动再次删除。原操作读取只核验事实，无批准或重发入口。

## 组合入口

- 前端：`client.tsx`导出`Page({nodeId?,revision?,routeParams?,registerLeaveGuard?})`，兼容旧入口。App/PageOutlet已透传完整routeParams与离开guard。changeSetId/planId/approvalId进入只读核验；useId/evidenceId/taskId经共享readEvidence/listEvidence精确读取，核对原任务和outcome.useRecordId，再提供带原SHA的修订与返回learning链接。旧SHA触发只读字段对照，不静默覆盖HEAD。
- `draftId`使用治理专用持久原载荷端口读取，恢复仅展示原载荷且保持只读，不借1.16任务存储或1.17交接操作存储冒充治理恢复。混合原记录/草稿/操作参数不自动核验，原记录未核验前不默认选中第一条无关知识。
- 服务端：`server.ts` 导出 `registerRoutes(app, services)`。依赖通过 `Services` 注入；本模块不读取 Token，不调用 CNB SDK，不建立第二份知识存储。
- UI 含知识修订、关系、历史记录、数据控制、AI 与隐私、活动审计六个页签，CSS 仅作用于 `.governance`。
- 治理预览可显式按原操作ID保存30天原载荷；保存后必须读取同一operation的状态和独立receipt，未知/partial结果只按同一ID读回，确定性冲突不再次POST。刷新恢复仅只读展示且不自动批准/提交/删除/导出/公开。原载荷未知期间编辑和共享离开guard均blocked，但仍允许只读核验。只读操作检查器可按原ChangeSet、设置批准、删除plan、三个治理用途的登记operationId查询事实，不恢复正文或提供重发。提供共享guard时不重复注册beforeunload；浏览器实际拦截仍需验收。
- 知识/设置/普通导出/删除及`demo_export`由共享HTTP登记对应用途的真实批准，UI不自造Approval；未配置和拒绝返回真实错误。预览、登记批准、执行分步确认；只有核验结果后才可继续下一项。设置、导出、删除预览以及脱敏演示预览都显示原载荷保存控件；演示副本仅允许本地下载并固定`published:false`，不表示部署、公开或评委可访问。

## HTTP 约定

统一前缀 `/api/governance`。响应使用共享 `ApiResponse`：成功为 `{ ok: true, data, meta }`，失败为 `{ ok: false, error, meta }`。`meta` 包含可信 `requestId`、`mode` 与 `contractVersion`，不接受客户端自行声明 live 模式或身份。

所有 POST/PATCH 的顶层请求使用严格 `action` 联合，支持 `{ "action": "cancel" }`。取消会检查会话与路由权限，但不读取对象、不写入；取消不是撤销已经发出的平台操作。实际字段以各实现文件中的 Zod schema 为准。

| 方法与后缀 | 输入要点 | 成功数据与限制 | 路由权限 |
|---|---|---|---|
| GET `/status` | 无 | `snapshot`、`actorId`、`scopes`、实现状态 | `knowledge:read` |
| GET `/nodes/:id/compare` | `revision` | 原/当前节点、changedFields、readOnly；不可读与受限明确区分 | `knowledge:read` |
| GET `/operations/:kind/:id` | kind=knowledge/settings/delete/settings_approval/export_approval/delete_approval | 仅原操作元数据/回执/逐层结果，不恢复ChangeSet正文；缺回执不证明未执行 | 知识读/设置读/删除，登记查询分别需设置写/导出/删除 |
| PATCH `/nodes/:id` | `preview`、`operationId`、`baseRevision`、`nodeRevision`、`reason`、`patch` | `ChangePreview`，不保存草稿 | `knowledge:write` |
| POST `/impact` | `preview`、`objectIds`、`baseRevision`、可选 `budget` | 图与历史覆盖分开；历史未接或无权限不能当零影响 | `knowledge:read`，历史另需`evidence:read` |
| POST `/changes/prepare` | `prepare`、不带 `contentHash` 的 `changes`，恢复另带`restoration:{nodeId,historicalRevision}` | 规范化拟提交对象、统一摘要和批准范围；恢复会重新核对历史 | `knowledge:write` |
| PATCH `/relations/:id` | `preview`、`operationId`、`baseRevision`、`reason`、`patch` | 改方向、类型、依据、证据或撤回的差异 | `knowledge:write` |
| POST `/changes/commit` | `commit`、完整 `ChangeSet`、`approval`，恢复另带`restoration` | 经 `Services.commit` 返回回执；索引和新查询另行核验；重放仍由平台验证摘要/撤回 | `knowledge:write` |
| POST `/changes/verify` | `verify`、原完整`ChangeSet` | readCommit按原ID查回执并核验固定snapshot；null为not_recorded而非未写入 | `knowledge:read` |
| POST `/replace` | `preview`、`operationId`、`baseRevision`、`oldNodeId`、`replacementNodeId`、新 `relationId`、`reason`、`evidenceIds` | 新结论 `supersedes` 旧结论，拒绝替代循环 | `knowledge:write` |
| GET `/history` | 可选且不可重复的`nodeId/taskId/useId/evidenceId`，拒绝其他字段 | 指定ID时只经readEvidence读取原记录及outcome所关联use；验证任务/类型/ID/workspace，null不是空列表成功。无ID时才按taskId调用listEvidence。原task/三态/路径不改写 | `knowledge:read` + `evidence:read` |
| POST `/rollback` | `preview`、`operationId`、`nodeId`、`baseRevision`、`historicalRevision`、`reason` | 从可信历史快照生成恢复差异，不执行 Git reset | `knowledge:write` |
| POST `/export` | `preview` / `execute`、`objectIds`、`baseRevision`；执行另含 `approval` | 显式选择的知识 Markdown、来源、关系与证据文件 | `data:export`，读取证据另需 `evidence:read` |
| POST `/delete/preview` | `preview`、`objectIds`、`baseRevision` | 平台计划、七层能力及未知项，尚未阻断或删除 | `data:delete` |
| POST `/delete/execute` | `execute`、完整 `plan`、`approval` | 计划复核、平台执行报告、新快照阻断核验；不是物理清除证明 | `data:delete` |
| POST `/delete/verify` | `verify`、`objectIds`、可选 `planId` | 按可信原计划读取逐层报告+当前阻断；仅报告存在时reportAvailable=true；物理清除仍false | `data:delete` |
| GET `/settings` | 无 | 五项开关、独立`settingsRevision`、`baseRevision`、`currentHash` | `settings:read` |
| PATCH `/settings` | `preview` + `patch` 或 `execute` + 完整 `settings` + `approval`；均含 `baseRevision`、`expectedSettingsHash`、`expectedSettingsRevision` | 差异、CAS或保存读回；`modelEnforcementVerified: false` | `settings:write` + `settings:read` |
| POST `/settings/verify` | `verify`、原`approvalId`、`contentHash`、`baseRevision`、`expectedSettingsRevision` | 1.7.0只读原操作回执及当前设置；区分历史saved与后续当前值；null不推断成功 | `settings:read` |
| GET `/audit` | 无 | 结构化白名单活动，未知动作/结果脱敏 | `audit:read` |
| POST `/demo/preview` | `preview`、`baseRevision`、`modelDeclaration`、`items` | 用户显式填写的脱敏副本及摘要，`published: false` | `data:export` |

`objectIds` 必须是 1 至 200 个不重复 ID；影响检查预算默认 1000、最大 10000。修改理由不能为空，最多 4000 字符。`PATCH nodes` 的可修改字段见 `revisions.ts`，不能改原会话、候选来源、作者确认身份或任意工作区。

示例仅展示 fixture 修订预览，不产生远程写入：

```json
{
  "action": "preview",
  "operationId": "fixture-revision-1",
  "baseRevision": "fixture-r1",
  "nodeRevision": "fixture-r1",
  "reason": "补充适用边界",
  "patch": { "boundaries": ["仅适用于同一版本"] }
}
```

将响应的 `data.changes` 原样送入 `/changes/prepare` 后会得到拟提交载荷和摘要，不等于已保存。预览中的 `confirmed` 字段描述拟提交状态，不能据此声称人的批准已经登记。

## 批准和未知结果

- 摘要唯一使用 `contracts/hash.ts`。目的分别是 `commit_knowledge`、`export`、`delete`、`settings`；对象、工作区、操作者、摘要、基准版本和有效期都须匹配。
- 提交批准的 `objectIds` 是变更节点、关系和撤回 ID 的去重集合；导出/删除使用显式选定范围；设置使用平台确认的 `[workspaceId]` 和独立版本CAS。
- 本模块的结构和绑定校验不能替代平台批准登记、撤回校验及持久化幂等。Services 必须再次拒绝伪造或已撤回的批准。
- 共享批准能力存在时预览返回`approvalStatus:"required"`，缺能力时返回`unavailable`。`executionEnabled:false`表示仅预览，不能靠预览响应执行。`ChangeFlow`/`DataFlow`经共享批准登记，再独立执行和读回。
- `CONFLICT` 返回 409，保留草稿并重新预览。`UNKNOWN_RESULT` 返回 409，必须读回后决定，不自动重发写入。缺配置返回 503，缺实现返回 501。
- 删除执行期间即使某层失败，平台也不得撤销已经建立的检索阻断。`physicalDeletionComplete` 保持 false，不能把排除清单或回执当物理删除证明。
- 设置正常保存和未知保存均要求原批准ID精确回执；已移除成功响应+相同最终值的旧降级逻辑。回执不可用就保留unknown，后续版本不覆盖原回执，也不把旧设置再写回。
- 修改预览内容会撤回旧批准；未知执行/未知撤回锁定原操作。取消保留输入，不等于撤销已发送的动作。普通导出恢复仅以原批准重新生成文件，不是公开或远端写入。
- 原登记恢复采用1.11知识ChangeSet GET、1.13治理purpose/operationId GET，核对完整原请求摘要/身份/范围/版本；not_registered/unknown均不能解除锁定。服务端只用Services，不导入兄弟业务模块。
- 逻辑撤回的对象仍由共享快照提供正文和withdrawn状态，可解释原use；持久删除会从共享快照移除正文并保留屏障，历史/影响/导出均检查嵌套引用并再次读取当前屏障。两者不能互换。
- 导出严格核验canonical snapshot、SHA-256路径Markdown、evidence/N.json和manifest的文件集合与完整字节；包含原use上下文的证据必须显式选中全部知识/关系/原use依赖。部分导出不是完整备份，生成后重查权限和删除状态。
- conditionChecks中的额外nodeRef同样参与历史/影响/导出依赖和删除阻断。历史保留原SHA、conditionId、当时满足/不满足/未知和原确认人；字段缺失明确未记录，不拿今天的snapshot重新认证当时结论。

## 当前外部验收项

1. 已解决并已消费：1.7设置精确回执、1.11/1.13原批准登记恢复、1.14真实`listEvidence`与完整证据导出、1.18审计原操作关联、1.19治理原载荷、1.21专用`demo_export`、1.22只读`operation-recovery`。不再按旧报告列为缺接口。
2. W12/W14外部验收仍由窗口一协调：统一导航在稳定dev server上的浏览器验收、受控索引状态、真实CNB/删除、部署/公开和G4/G5。节点六已提供只读检查和原ID消费，不把代码接线当整机已验证。
3. Git逻辑撤回可新提交恢复，持久删除屏障不能绕过。`private_state`只核验显式选择的证据行正文，`review_private_state`只核验关联审核题/作答/暴露行内清理；两者都不宣称SQLite页/WAL、导入源文件、备份等物理抹除。
4. `extract`/`answer`/`review`三个模型用途已通过发送前/返回前关闭的共享Services回归；真实模型、CNB、部署和公开均未调用。

七个物理层为 `worktree`、`git_history`、`issue`、`index`、`cache`、`backup`、`shared_copies`；实际平台计划另含`application`、`review_private_state`，显式选择证据时另含`private_state`。缺能力显示unknown，缺执行证据标pending或unknown，不能当作已证明unsupported或全层done。

## 历史验证记录（旧快照）

2026-09-12历史批次：治理29文件243项、全库集成12文件61项、全库189文件1513项通过；typecheck、边界、build通过。仅为当时共享Services/SQLite/受控传输快照，不能覆盖本轮导出/类型失败，更不是浏览器或live验收。

`pnpm exec vitest run src/features/governance`：2026-09-09 15:35当前复跑28文件、230项中229项通过；唯一失败是共享模型在途操作实际读回`done`而本回归期望设置变化后为`discarded`，属于平台/节点五语义待协调，不是治理文件类型或业务逻辑错误。测试不调用真实CNB或付费模型。

当前边界检查64条唯一归属路由通过。全库`pnpm typecheck`未通过：当前错误位于平台`review-sessions.test.ts`、`review-sessions.ts`等其他窗口，治理目录无诊断；具体位置已交03报告，不改其他窗口。完整routeParams与离开guard已接，但不等于G4/G5或浏览器通过。

`regression.test.ts` 通过共享 `createApp` 和公开治理/检索 HTTP API 验证关键前提修订、依赖结论降级、撤回、删除阻断、新版本恢复及历史原文保留；未 import 其他业务模块内部文件。这是 G14 API fixture 回归，不代表 G4/G5 已验收。

`platform-flow.test.ts`、`shared-regression.test.ts`及`data-flow.test.ts`进一步使用平台实际会话/批准/SQLite/提交/治理/模型代码，只替换外部传输。覆盖连续操作、未知发布回复、撤回后恢复、独立设置CAS、逐层报告、SQLite重开、同题前提变化、旧向量正文隔离及服务端AI关闭。默认createServices()仍未配置，不标live。

`runtime-regression.test.ts`运行实际createRuntime合成连接/重启/撤权，旧cookie被拒绝，明确重连后只读恢复原批准/设置回执/删除报告，零重复PATCH或Git调用。`evidence-integration.test.ts`运行实际EvidenceStore与治理/检索HTTP：原use保存、影响引用、修订/撤回/恢复后的原解释、完整证据导出和私有正文删除重启均已通过；不代替五的消费端或G4最终门。

新增history-selection/history-origin验证精确原ID、outcome关联、任务归属、删除期间读回、重复/正文参数拒绝和共享导航往返。实际EvidenceStore重启后原use/outcome仍分别读取；条件节点不在直接nodeRefs时也须显式选入导出并继承删除阻断。两条同题联测已移除旧constraints确认等同任务适用的假设：旧SHA核对在修订/恢复后返回冲突，明确核对新SHA后才可恢复适用判断，原任务不改写。

`client.test.ts`仅验证静态React语义标记及纯函数；本轮另补设置预览可见原载荷控件的代码修复。2026-09-09浏览器指定技能路径已不存在，Node REPL前置检查报`failed to start Node runtime: No such file or directory (os error 2)`；不是沿用9月5日的model_catalog错误。未改用户配置、未绕过工具另启浏览器。截图、真实键盘/读屏及320px检查尚未运行。共享4312健康检查为1.17.0/unconfigured/cnbConnected=false，不是授权平台连接。
