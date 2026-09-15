# Handoff 模块 API

2026-09-09 14:48：窗口一公告与代码当前契约均为1.20.0；节点三30文件/183项模块测试、64条边界检查通过。已消费1.17.0不可变原操作快照；1.20.0的W4 `not_sent`扩展不改变节点三快照语义。既有统一导航、候选、草稿/部分进度/CAS、原知识批准和手动来源实现保持。所有响应使用共享 `ApiResponse<T>`；服务端 context 决定 mode、workspace 与 actor，响应 `Cache-Control: no-store`。保留原始可信 RequestContext 对象，不克隆或改写身份。本模块没有第二存储，手动流程不调用 AI。浏览器和授权CNB不因测试通过而升级。

- `GET /api/handoff/status`：模块实现状态，不代表 CNB 已连接。
- `GET /api/handoff/:id`：id 是 conversationId；返回 Review（来源、最多三个 AI 候选、空白本地审阅状态、稳定 draftId/nodeId、可信 actorId）。默认需要 conversation:read + candidate:read；`?source=manual` 只需要 conversation:read，不读候选。复核源文本 UTF-16 偏移及共享摘要。ReviewItem.subject 为 AI Candidate 或独立 ManualReviewSource，不再使用 ReviewItem.candidate。
- `POST /api/handoff/:id/manual`：请求 `{segmentIds,expectedConversationHash,confirmed:true}`，至少选择一条非空原句；返回只有一项的空白手动 Review。校验已保存现场、范围、摘要和 UTF-16 引用；本请求不保存、不批准、不写 Git、不调用候选或模型端口。ID 为独立 `handoff-manual-<UUID>`，nodeId 为 `knowledge-<draftId>`；不伪造 modelId/generatedAt/claim。
- `GET /api/handoff/:id/snapshot`：返回 KnowledgeSnapshot，需要 knowledge:read。只用于目标选择/基准版本，不写入、不调用语义模型。
- `GET /api/handoff/:id/draft?draftId=...`：返回 HandoffDraft；需要 draft:read。缺失/权限失败原样作为错误，绝不冒充空草稿。
- `PUT /api/handoff/:id/draft`：请求 `{draft: HandoffDraft, consent: true, options: DraftSaveOptions}`；需要 conversation:read、knowledge:read、draft:read、draft:write，AI 来源另需 candidate:read。验证所有引用、工作区、基准版本、来源原句、身份、条件、关系后经 Services 原子 CAS 保存并读回核对；不写 Git/索引。
- `POST /api/handoff/:id/preview`：请求 `{draft: HandoffDraft, reason: string}`，返回 `{draft,changes:ChangeSet,diff:{rows,impacts}}`；需要知识读取/提交权限。使用同一快照、共享 schema/hash，生成新的操作 ID；纯预览，不保存、不取得批准。
- `POST /api/handoff/:id/commit`：请求 `{draft:HandoffDraft,changes:ChangeSet,approval:Approval,confirmed:true}`，返回平台 CommitReceipt。复核共享摘要、actor/workspace、purpose、对象集合、期限和原预览版本。以 `snapshot(ctx, baseRevision)` 重建并对比变更；Services.commit 独占登记/撤回、HEAD 原子 CAS 与持久幂等。模块不实现 Git 写入，也不在未知结果后自动重试。

知识批准与提交读回已接入 1.4.0 可选端口；默认未配置服务仍不承诺可写。API fixture 通过共享端口登记批准，不再绕过批准路由直接发放给流程测试。

- `POST /api/handoff/:id/approval`：请求 `{draft,changes,confirmed:true}`。先从可信现场和原 baseRevision 重建并精确核对 ChangeSet，然后调用 `Services.approveKnowledge(ctx,{changes,confirmed:true})`。响应批准再次校验共享摘要、对象集合、actor/workspace、用途、版本和期限。缺端口返回 NOT_CONFIGURED；调用后异常或错误绑定回执为 UNKNOWN_RESULT（登记未知，未发出 Git 提交），不允许客户端新造批准。
- `POST /api/handoff/:id/approval/:approvalId/revoke`：已有 Services.revokeApproval 可选端口的桥接；缺端口明确 NOT_CONFIGURED，客户端收到 revoked=true 才丢弃旧批准。
- `GET /api/handoff/:id/receipt?changeSetId=...`：需要 knowledge:read 和合法 ID，调用 `Services.readCommit`。null 只代表服务未登记，转为 UNKNOWN_RESULT，不显示未写入；缺端口 NOT_CONFIGURED。该读取不要求原始现场仍可读，操作归属由平台按可信 workspace/actor 检查；receipt 本身不含 conversationId，不能把 URL 中的现场 ID 当作操作归属证据。不使用新的 commit 请求冒充读回。
- 提交回执严格检查 changeSetId/版本/索引枚举/安全链接。live 回执要求完整 Git SHA；fixture 明确标示。无可信回执则 UNKNOWN_RESULT，不展示 Git 成功。
- 未知提交的只读核验若返回平台已登记的分支拒绝（`CONFLICT` + `dataState=preserved` + `nextAction=preview_again`），转为提交失败并保留批准，允许明确撤回后重审。不把权限/网络/空读回或其他冲突解释为“未写入”；这些错误仍保留原未知状态。

前端 Page 可选接收 `params: Record<string, string | undefined>`，使用 conversationId、draftId、candidateId。整组读取成功才替换页面；缺失或不匹配的候选/草稿保持错误，不自动回退到第一条。changeSetId 可预填独立回执核验输入，但不自动请求。共享窗口负责解析 hash；模块不自行实现全局路由。

参数更新会脱离旧现场读取的迟到响应，仅最新目标可安装到页面；不能打断草稿写入、批准或正式提交，也不声称这些写入已取消。新目标不复用旧目标的放弃编辑确认；有本地审阅时仍需明确确认后手动读取。

空白和部分进度可通过下文 1.10.0 端口显式私有保存30天；完整草稿与进度共用版本线，跨会话保存使用原子 CAS。本地导出仅包含选中项，用户明确点击后才生成下载，不混入其他审阅或未选原文。

修改陈述、条件、边界或来源判断会将已确认关系恢复为 proposed，保留原理由与目标引用。完整草稿可保存这种待重审状态，但预览/提交必须重新明确确认；未完成的关系表单通过 ReviewProgress 按项保存。读取另一现场须明确同意放弃本页编辑，批准未撤回或提交结果未知时不能替换当前操作。

关系依据在两个端点间按来源不可变身份（id/kind/title/url/excerpt/accessedAt）核对。同 ID 对应不同身份时，界面显示歧义并移除可选依据，API 同样拒绝该 evidenceId；不静默用后一个来源覆盖前一个。同来源针对不同主张的 support/supportedClaim/limitation 不构成来源身份冲突。

草稿未知写入保留实际发送载荷和 operationId；按原回执核验 actor/workspace、draftId、前后版本、原 document/source 的共享摘要，不因当前同 ID 文档内容相似就认领成功。后续保存产生新版本不抹掉旧操作回执，也不覆盖本页后续编辑。partial/UNKNOWN_RESULT 均锁定重复保存。各分流状态均可明确导出本条数据；导出包含未知草稿载荷、操作 ID、批准状态与已知回执，不自动持久化浏览器数据。

恢复完整草稿前再次检查来源原句/身份、候选集合、节点与基准版本和 draft 状态。不把其他操作者记录的条件/关系确认归到当前操作者，恢复为 unknown/proposed 后由人重新判断；原理由保留。显式替换会清空旧的未完成关系表单，避免将其混入已存草稿。

页面保存走 ReviewProgress，包含未完成关系输入并维护逐项 savedFingerprint。旧完整 draft 路由不含 relationInput，不能将该路由的成功解释为已保存部分表单；不能用保存成功触发显式恢复的清空行为。

刷新后不必持有旧内存预览：`ReceiptLookup` 接受现场 ID 和操作 ID，显式只读核验；无变更正文时只展示真实 Commit/索引状态，不凭 URL 参数伪造候选或现场归属链接。未知/空/错误模式/错操作回执均不显示成功。

页面主工作流请求使用同步 RequestGate，重复点击不发第二请求，卸载后的响应不修改页面。独立 ReceiptLookup 使用自己的只读请求门禁，不能发起写入。普通提交失败保留批准并禁止盲目重试，撤回成功后才返回编辑；成功则释放锁定，可继续下一候选。批准登记结果未知与 Git 未知分别显示。W3-REQ-006已接1.11.0原批准GET；W3-REQ-008已接1.17.0完整原快照，只有经另行明确保存的原预览才可按changeSetId恢复，不把只有hash的批准回执当作正文。

本模块自身的返回、结果跳转和草稿重开链接已接下文 W12 统一离开检查。普通未保存内容为 dirty；活跃请求、已登记批准及未知写入为 blocked，不能被“确认放弃”绕过；已核验保存的逐项进度不再误报 dirty。共享导航已有实际 HashNavigation 回归，桌面/320px/键盘/读屏仍待浏览器实测。
# W12 统一导航接入（2026-09-05）

Page继承共享NavigationProps，通过effect注册/注销handoffGuard；getter读取最新状态ref与同步RequestGate。普通未保存编辑dirty，在途/未知写入/未撤回批准blocked。组合层处理侧栏、hash、同页参数和beforeunload，模块只通知阻止原因并聚焦错误区，不重复确认；独立Page保留本地退出保护。navigation.test使用共享HashNavigation，不代替浏览器/键盘/窄屏验收。
# H07 私人进度 1.10.0 接入

- `GET /api/handoff/:id/draft-state?draftId=`：共享DraftState，missing/available/expired分开，FORBIDDEN不等于无记录。
- `PUT /api/handoff/:id/progress`：`{progress:ReviewProgress,options:DraftSaveOptions}`；含原operationId、source、conversationHash、expectedRevision/contentHash及30天确认。返回`{state,receipt}`，核验共享Services实际读回与原回执；不写Git、不调用模型。
- `GET /api/handoff/:id/draft-receipt?draftId=&operationId=`：原操作回执；空/错身份/错草稿保持unknown。
- 既有PUT draft新增必需`options`，传给真实saveDraft原子存储；不以两次读取模拟CAS。
- 页面逐项保存全部输入，包括空白陈述/条件及未完成关系。版本冲突保留本地，先对照后明确选择恢复或按对照版本保存；旧回执可确认原保存，不能覆盖后续编辑。私有保留30天，正文不进入Git/索引，不默认落localStorage。GET draftId重开同时接受draft/progress。
# H10 原批准登记恢复 1.11.0

`GET /api/handoff/:id/approval?changeSetId=`通过原RequestContext调用readKnowledgeApproval，只返回原actor/workspace操作。页面对原固定ChangeSet再核对摘要、范围与版本；registered恢复原批准；revoked/expired仅在Git未发出时清除旧预览，重新预览生成新操作；not_registered/unknown均保持未知，不自动POST重登记。Git已发出或未知仍须独立核验readCommit。

# H01/H03 手动来源与纵向证据

`#handoff?conversationId=...&source=manual` 可从捕获进入；恢复用同一 draftId，由平台读回原 source.spans。部分/完整保存和预览/批准/提交都重新核验来源；手动正式预览要求本条来源已明确保存，不能用空 spans、变化原句或 AI authorship 绕过。正式节点为 `candidateIds=[]`、草稿 `candidateId=null`、`authorship=human_written`。

`manual-platform.test.ts` 使用实际 createApp/Services/SQLite，外部传输为合成：AI 关闭的 capture Issue -> 手动选择 -> 空白保存 -> 重开 -> 完整草稿 CAS -> 重开 -> 预览/批准/Git -> retrieval 同 revision -> 原 Issue 核对，模型零调用、Git 一次。另验证无候选/模型权限、私有身份隔离、两条独立手动审阅、CAS 冲突、来源变化及未选片段不入正文。不是浏览器或授权 CNB live 验收。

# H10 原不可变预览 1.17.0

- 保存直接消费共享`POST /api/workspace/handoff-operations`，原状态/回执分别经`GET /api/workspace/handoff-operations/:changeSetId`和`GET /api/workspace/handoff-operation-receipts/:changeSetId`。`makeOperationRequest`要求本条已存版本、无未保存编辑和另行明确同意；内容为原draft/changes/source、原draftRevision/contentHash和conversationHash，不自动保存当前编辑。
- `operation-client.ts`核对POST/GET模式及完整请求hash、快照hash和原回执。POST成功后回执缺失/读取失败也保持unknown；只GET原ID核验，不能再次保存。Page把此未知纳入RequestGate、编辑锁及W12离开保护，与草稿/批准/Git未知分开。
- `GET /api/handoff/:id/operation?changeSetId=`返回`OriginalOperationView {recovery,storage}`。只接受唯一合法参数；读取原平台snapshot.savedDraft，不GET最新草稿。核验actor/workspace、原operation/draft版本/hash、reason/时间、source/UTF-16原句和固定baseRevision；再分别读取readKnowledgeApproval/readCommit；最终再读平台快照以检查核验期间的删除/TTL/失权。
- `recovery.canSubmit`恒为false。恢复正文不批准、不提交；null/not_registered/missing不证明未写入。批准暂不可用时不遮蔽独立已核验Git回执；索引仍显示原pending/current/failed。失权/过期/删除/来源改变不返回旧正文或用B草稿拼A；已有ReceiptLookup保留不依赖正文的Git核验。
- `OperationControls.tsx`提供独立保存同意、未知时只读核验、只读恢复及取消读取。带`conversationId/changeSetId/draftId/source`的原预览链接可重新打开并自动读取；恢复目标只使用`changeSetId`对应的不可变快照，不用当前可变draft重建旧内容。取消使迟到结果失效，不撤回远端批准或已发出的写入。只读面板没有批准/提交/返回修改按钮，保留原理由/确认时间/保存期限。
- 当前边界：保存为私有30天且不超过原草稿expiresAt，不进入Git/索引/localStorage；没有同意就没有持久原预览。共享App按完整hash重挂Page，当前编辑URL自动固定changeSetId还需W3-REQ-009的W12支持；不直接history.replaceState绕开统一导航。带ID链接恢复已接，不能据此声称未带ID原编辑页强刷能自动定位操作。
- `original-platform.test.ts`10项实际共享存储消费含A批准丢响应/另一会话保存B/SQLite重开只恢复A，草稿/快照/批准/Git分别丢回执、到期、失权、恢复核验期间删除。新增导航/目标回归锁住原draftId保留且不读取最新draft。`g1-g2-consumer.test.ts`两条AI/manual链都已消费真实快照保存/读取HTTP，并验证`depends_on`/`contradicts`进入四的同revision和关系路径，Git仅一次；共享`tests/integration/g1-g2-platform.test.ts`当前4/4通过。外部CNB/模型/Git传输合成，浏览器与live单列。
