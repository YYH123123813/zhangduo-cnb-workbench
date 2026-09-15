# 窗口四：检索模块交接

状态：2026-09-16静态终审收口；当前共享源码契约1.31.0。本轮只阅读源码、修复本模块缺口和整理文档，未运行测试、类型、构建、浏览器、健康探针或外部请求。已消费1.28的recoveryRequested，旧“首次null接口缺失”不再成立；本轮修改尚无执行验收。保留检索、图关系、条件三态、Dagre和1.20/1.22/1.26回答恢复，固定导出仍是 `client.tsx: Page`、`server.ts: registerRoutes`。R01-R13静态覆盖表与共享差额见本节点03/04，不将静态覆盖写成系统完成。

## 用户操作段落（供节点一合并）

### 查询与条件

进入“知识与检索”，填写“当前问题”，按需添加“任务补充说明”，再点击“检索知识”。问题和临时结果默认不保存。任务补充说明的“已确认”只代表你确认这段说明，不会靠关键词替你确认某条知识的前提。

系统把Git文本匹配和已授权的CNB知识库语义定位合并，再检查正式关系。语义相似度只帮助找到对象，展示和回答使用授权Git快照中的正文，不使用向量库返回的旧片段作为事实。若显示“仅Git文本召回”，表示CNB语义通道不可用或尚未授权，并非语义检索已经完成。读取错误与无命中分别提示；已有结果保留时仍属于上次查询，不能直接当作新结果采用。

必要条件会一次询问一项。选择“满足”仍需通过来源、版本、冲突及其他前提；“不满足”会使依赖它的结论不能通过当前检查；“未知”或“跳过本次”保留缺口，不等于否定或满足。可在“本次条件核验”中重新核对，或清除核验并重查；修改问题会使旧核验失效。澄清期间可以使用“取消条件核验”按钮停止，保留输入，不提交待选答案。

### 结果、图与来源

结果分为“通过当前检查”“有条件参考”和“存在冲突”，同时显示快照、覆盖警告和未解决缺口。通过当前检查不是正确性或掌握证明。依赖可找到低文字相似度的前提；支持关系寻找支持节点；冲突不自动裁决；替代会限制旧结论的当前使用。循环、缺失邻居和检查预算耗尽都会保留限制。

选择结果后可核对人的正文、确认/来源支持/知识状态/表达作者、前提、节点与快照版本、来源摘录和关系列表。“列表”“文本路径”与局部图共用选择；局部图默认一跳，可选择两跳，最多15节点，提供缩放和以选中知识为中心。图不能表达的完整信息仍在详情与文本入口中，布局失败保留等价节点列表。

引用按钮进入对应知识详情，可继续打开已有来源地址；缺少地址时会明确提示，不生成猜测链接。版本变化不会静默把旧引用换成新正文。显式“查看引用版本”仅供历史核对，仍服从当前权限和删除屏障；“查看当前版本”不改写历史使用记录。

### 可选回答与恢复

AI回答关闭时仍能使用Git正文、来源和关系。可用时先点“预览模型范围”，核对精确内容、知识与来源ID、摘要及版本；勾选本次模型范围同意后点“批准本次范围”，再单独点“生成回答”。有前提、冲突或来源缺口时不生成确定回答；无效引用或模型失败保留安全直接结果和缺口，不以删掉引用的方式保留确定结论。

回答区区分待批准、已批准待发送、发送中、未知、已结束、输出丢弃和平台已证明未发送。网络错误、取消、撤回批准、关闭AI或没有答案都不证明未发送。“核验原操作”只核对原回执；不自动重试或再次计费。已结束不等于引用有效，更不代表知识已保存或用户已经掌握。

需要刷新后定位原操作时，在批准前另行勾选“单独同意保留原操作身份24小时”。它默认不勾选，与保存任务、模型发送同意分离；只保留原登记ID、摘要和版本等最小身份，读取不续期。保留未知时不会继续批准。重新连接原身份后从共享“原操作核验”进入，只读核验原操作；不恢复查询、预览、答案正文，也不自动批准、发送、撤回或close。未保留身份、身份到期或读回失败不会被描述成业务操作未发生。

### 应用与修订

从当前有效检索详情进入“记录采用 / 不采用”，由“应用与回顾”保留原task、条件、知识版本、路径和覆盖警告，再单独决定是否保存use/outcome。临时交接刷新后可能丢失，不伪造恢复；大范围交接仍有下述预算差额，不能截去警告冒认完整。“修订此版本”进入版本与控制，由人核对差异及批准；修订、撤边或恢复产生的新版本影响下一次查询，不改写旧使用记录。删除屏障不因普通恢复解除。浏览正文已经可能提供帮助，`client_preview_only`以及没有模型答案都不能作为“未看过答案”的证据。

## CNB配置与覆盖依赖

- 配置由窗口一在服务端管理，本模块不读取私人.env、不接收CNB Token，也不自行启动服务。需要已核验的私人工作区、`knowledge:read`及持久删除屏障；正式知识来自同一Git快照。
- 仅读Git与发送语义查询分别授权。当前共享配置要求`CNB_LIVE_READS_FOR`、`CNB_LIVE_QUERIES_FOR`各自匹配`CNB_REPO_SLUG`，服务端凭据具有相应读取权限；这些变量是授权配置条件，不是本轮已配置成功的声明。语义未授权时保留Git回退。
- 索引更新由共享工作区IndexPanel管理，需独立`knowledge:index`、`update_index`批准、精确Commit与白名单文件、匹配仓库的`CNB_LIVE_INDEX_FOR`和经核验的`CNB_INDEX_EMBEDDING_MODEL`。普通保存成功不等于索引已更新，查询不能自动触发索引；生产条件以窗口一公告为准。
- 当前KnowledgeQuery仍返回`indexRevision:null/coverage:partial`。索引操作的`approved/pending/current/failed/unknown`与查询覆盖是两类事实，触发成功不代表覆盖完整，`physicalPruning:unverified`不能描述为旧向量已物理删除。未检查部分可能还有知识或冲突。

## 1.26/1.28恢复身份

- `AnswerControls -> createAnswerFlow.approve`消费`NavigationProps.retainOperationRecovery`。独立checkbox默认不勾选，与模型发送同意和任务30天同意分离；选中后在业务批准POST前保留`feature=retrieval`、`kind=model/modelPurpose=answer`、原approveModel登记operationId、原contentHash/baseRevision及至多24小时绝对期限。未同意零身份留存；返回id、身份、范围、摘要、期限不匹配或保存未知时不继续批准/发送，不自动重存。
- `Page`消费共享`recoveryIdentity`进入独立只读页面，不构造RetrievalRequest、查询、预览、Approval或答案。`restored-answer.ts`先GET可信会话，验证共享保留身份及原元数据，再复用1.22原operationId GET；显式再次核验可GET同一恢复身份，不按approvalId、queryId或相同内容猜操作。
- `matched/unknown/mismatch/missing/expired/unauthorized`分别显示；元数据的done/discarded/not_sent不升级为可信回答、权威未发送回执或学习证据，恢复模式保持blocked。卸载只detach/dispose并取消读取，不自动撤回、close或重试；旧响应不能覆盖新操作。正常模式下用户显式取消及既有权威终态核验保持原语义。
- 1.28已提供`recoveryRequested`和共享RecoveryAwaiting；本轮Page以requested、非空身份或本实例已见恢复意图进入只读页。首次requested=true/null不挂载普通查询或模型预览；后续null不回clean，普通false/null保持原查询入口。不读取location、不复制history，不建浏览器存储；此项源码接入已完成，执行验收未在本轮进行。
- 正文暴露由已发布1.25共享HTTP组合层记录，本模块不建暴露数据库。原task/result交接仍是`client_preview_only`；默认unknown不证明无提示，not_sent也不是学习证据。

## HTTP契约

知识读取路由要求可信 `knowledge:read`；模型操作回执仅需 `workspace:read` 与 `model:answer`，不重取知识正文。发送/预览另查model:answer、settings:read和服务端开关。成功和失败均返回共享ApiResponse，`meta.mode`来自Services.context，响应禁止缓存。客户端不能传模式、操作者或关系消融开关。

| 路由 | 输入 | 输出 |
| --- | --- | --- |
| GET /api/retrieval/status | 无 | `RetrievalStatus`，workspaceId/actorId、state=ready、aiAnswer=preview_available/disabled/unavailable、queryHistory=not_saved。ready及preview_available都不证明CNB/模型live已配置或授权。 |
| POST /api/retrieval/query | 共享`RetrievalRequest`；query及task.question为1至4000字符；最多50个唯一ID条件，每条1至1000字符 | 共享`RetrievalResult`；查询不保存，answer默认null。confirmedOnly=false也不会允许候选、草稿、撤回或错工作区节点进入正式结论。 |
| GET /api/retrieval/nodes/:id | 可选revision（节点版本）、snapshotRevision（查询快照版本） | 本模块`NodeDetail`，人的正文、独立状态、来源、完整可读取关系列表、文本路径；状态/版本不符的可读关系标为不参与检索。 |
| GET /api/retrieval/nodes/:id/history | 必须revision（节点SHA），可选snapshotRevision（集合SHA，默认节点SHA）；均为40位小写十六进制完整Git SHA | 本模块`NodeDetail`加history当前节点/快照版本，仅供历史核对；前后核验当前权限与排除清单，旧节点/邻居不能绕过当前阻断，不调用模型或进入当前采用。 |
| GET /api/retrieval/graph/:id | 可选revision、snapshotRevision、depth=1或2，默认1 | 本模块`LocalGraphData`，最多15节点/100关系；图/节点列表/文本路径使用同一个对象与选择ID，循环边也有文本路径。 |
| POST /api/retrieval/answer/preview | `{request: RetrievalRequest}` | 服务端重跑查询后的`AnswerPreview {input,objectIds,baseRevision,contentHash}`；不登记批准、不发送模型。 |
| POST /api/retrieval/answer | `{request: RetrievalRequest, approval: Approval}` | 重跑查询、重算输入和hash，交给实际Services.complete再次核验可信批准；输出严格RetrievalResult，不接受浏览器自造结果。模型结果未知返回UNKNOWN_RESULT，页面保留已有原文。缺批准/撤回端口或配置仍拒绝。 |
| GET /api/retrieval/answer/operations/:id | 原模型approval.id | 共享`ModelOperationReceipt`或null；核对ID/actor/workspace/purpose=answer，严格schema不允许夹带正文。只读Services.readModelOperation，绝不调用complete或恢复回答。 |
| GET /api/workspace/operation-recovery/model/:operationId?modelPurpose=answer | 原模型登记`AnswerRegistration.operationId`；不能使用approval.id、answer result ID或queryId | 共享`OperationRecovery`最小元数据；校验kind、原operationId、actor/workspace、purpose、request/content/baseRevision、objectIds、approval绑定、`readOnly:true`、`absenceIsFinal:false`。只读，不恢复输入/输出，不批准/发送/重试；done/expired/revoked/not_registered/null/错误不等于not_sent。 |

HTTP接口的本模块类型与schema在 `api.ts`，没有另造同名共享对象。当前读取缺失/不可读取节点统一403，旧节点版本或旧快照返回409，不静默替换。显式history入口通过 `snapshot(ctx, snapshotRevision)` 返回指定集合中的指定节点版本；平台忽略版本、节点版本不符或读取中快照变化均拒绝。历史关系标为不可用于当前检索，历史节点/邻居与当前可读集合取交集；1.5.0平台的删除阻断继续生效。

Services始终收到 `context(request)` 颁发的原始对象，不能clone/spread后传入平台。响应前另用保存的actor/workspace/mode字段比较会话，并在最终context等待后再次检查取消。此规则已按窗口一1.4.0反馈修复，有严格对象身份fixture回归。

批准登记核验复用共享 `GET /api/workspace/approval-registrations/model_input/:operationId?modelPurpose=answer`，本模块不重复注册共享路由。客户端只发操作ID/用途，严格核验ApprovalRegistrationState、原actor/workspace、完整请求hash和批准范围；读回不带私人输入或回答正文。原回答操作恢复另外只使用登记`operationId`，如果误把approval ID作为operation ID则前置拒绝。

## 检索规则

1. 获取并校验授权快照，优先semanticQueryWithStatus，兼容旧semanticQuery；合并Git文本与CNB语义定位，向量正文不会进入输出。语义不可用时保留文本结果，权限/错误快照/CONFLICT不能静默降级绕过。
2. 语义召回后再读取快照，版本变化拒绝混合结果；新排除清单即时生效。路由返回前再检查会话。
3. 只有已确认且端点版本一致的正式关系参与扩展。depends_on沿source到target追前提，supports反向追支持来源，supersedes反向寻找替代，contradicts双向查询但不改存储方向。
4. 查询最多两跳、60节点、200次遍历检查。检查全部相关安全关系后分组，预算耗尽/失效关系/未展示冲突保持缺口，不能作为确定结论。
5. 本次满足/不满足必须绑定精确workspace/node/revision/conditionId及可信确认人，未知不附确认人；相同文字不构成绑定。知识记录里的confirmed不自动等于本次任务满足，未满足或未知前提向依赖者传播，循环依赖不构成证明。
6. 先资格和适用性，再证据状态，再相关性与稳定ID。来源supportedClaim必须对应当前humanStatement；缺失、争议、待复核、替代状态不会变成无条件推荐。不读取使用次数或学习记录进行排序。
7. 快照运行时上限5000节点、20000关系；超出返回错误，不假装读全。只有平台明确coverage=current且indexRevision等于本次snapshotRevision才显示current；null降partial、错版本降stale。当前平台索引版本未知，不因HTTP成功宣称覆盖最新。
8. authorizedView合并平台excludedIds与本模块排除集合，正文缺失的删除ID仍保留，去重稳定排序；不通过重新返回隐藏对象来补排除显示。当前与历史入口均受持久删除屏障限制。

## 模型接入边界

`answer.ts`提供previewAnswer/prepareAnswerInput/generateAnswer，使用共享hashModelInput。页面先展示服务端精确输入，默认未勾选同意；明确同意才调用共享POST /api/workspace/approvals/model，批准后另按生成回答才POST answer。objectIds是正式节点ID，sourceIds是其真实SourceRecord ID，revision是快照版本。

complete独立核验批准登记、撤回、actor/workspace、用途、范围、期限、设置版本、预算和一次性操作；本模块重跑查询、核对精确hash和版本，不能仅凭字段齐全调用模型，也不复用保存/治理/知识提交批准。批准取消时晚到的ID继续撤回，重复点击不重复登记或发送。

本轮采用保守的提取式整理：模型只能选择已有人的正文和直接支持来源；`citations.ts`核对节点工作区/版本、sourceId、逐字引文、supportedClaim及正文一致性，拒绝附带未引用自由文本。校验失败保留直接结果并列缺口。前后重读快照、关闭AI、取消或版本变化会阻止/丢弃输出。模型失败先重查删除阻断，再返回机器可读unknown，页面保留此前安全原文；调用complete后的取消明确可能已发送，不声称能撤回已发送内容。

`answer-client.ts`将原operation与仍有效的approval分开保存。核验只GET原ID，核对actor/workspace/purpose/hash/baseRevision；done/discarded可以解除调用未知，但不是引用通过或可恢复正文的证明。未撤回批准仍阻止离开；sending/unknown/null/读回失败/错摘要均不解锁、不自动重发。成功的原文降级响应也会撤回剩余批准，撤回失败保留原ID；等待撤回期间修改输入立即使旧回答交付失效。

输入/条件/版本/授权变化使用invalidate永久使旧范围失效，原面板不得再preview/approve/send旧问题。其撤回和只读inspect仍可用，原操作未知状态不消失。新问题通过新的AnswerControls范围单独预览和确认，不因读回成功让旧任务复活。

1.13.0批准登记恢复已接：每次显式预览准备独立operationId和共享schema解析后完整请求的requestHash，批准时原样透传。丢响应后只读原登记；registered仅恢复撤回入口，绝不恢复send；revoked/expired只关闭尚未发出模型请求的登记未知。not_registered/unknown/错身份/错摘要/错范围/读回失败保持blocked。已尝试模型调用时，登记回执不能替代原模型操作回执；取消/换题不会使旧范围复活。实际共享HTTP在SQLite重开后找回同一批准并撤回，零模型调用。

W4-REQ-005已分段消费：1.20.0可信`not_sent` close、1.22.0原操作GET、1.26.0最小恢复身份及1.28.0首次null恢复意图已接入。URL由共享列表进入`#retrieval?recoveryId=<SHA256>`，该ID只定位已同意保留的身份；业务GET始终使用其中原登记operationId，批准ID仅作返回绑定。恢复不取正文、不自动执行业务操作；null、not_registered、expired、revoked、普通错误和统一元数据不能证明not_sent。不再申请已发布的首次null入口；本轮补丁待执行验收。

引文位置核对不等于证明来源真实或结论正确；没有自动掌握判定。原Issue链接只使用已有授权SourceRecord.url；缺地址明确显示缺失，不推测仓库路径。

## Page与跨窗口状态

`PageProps extends NavigationProps`，另有task/nodeId/revision/onResult(task,result)/onInvalidateResult；全部可选，零参数兼容。新的task/workspace ID会切换任务；首次查询及同一任务的父组件回传不会清空本地结果。onResult收到独立副本，当前编辑后的问题和条件与请求一致。只有选中详情的ID/节点版本/集合版本均属于原结果且结果未失效时，才能进入采用；历史和图外延邻居不伪造交接。

窗口一W12负责唯一hash解析并已实际传registerLeaveGuard。Page登记owner=retrieval且从最新ref读取状态：未提交问题/条件/确认变化为dirty，模型批准/发送/撤回/未知为blocked，blocked优先且不能用丢弃确认绕过。侧栏、hash、前后退与beforeunload由公共导航处理。W12用有身份/TTL限制的内存槽接住固定task/result；失效清除可供采用的临时结果，不得据此清除已发生暴露。刷新后临时交接丢失，不默认持久化查询历史。

只看原文也是assisted任务，不代表同意AI。`answer === null`、AI关闭、清空结果、刷新或离开页面都不能证明无提示。1.25共享HTTP层已经接入正文暴露记录：在已同意的观察范围记seen后返回内容，失败扣留正文；正常运行仍不能证明历史未看过，默认unknown。五已消费readReviewRuntime和精确题版本，不再列S07整体缺失。查询/详情/图任一通道失去权限会取消全部内容读取、清除正文并通知W12；输入/版本变化后的结果不可继续进入采用。中心快照独立固定，历史选择不会触发当前图谱。

W4-REQ-006已由1.15任务级条件三态契约解决并消费：`conditionChecks`按精确`nodeRef + conditionId + revision`绑定，`satisfied/not_satisfied/unknown`分别影响资格、缺口和回答预览；满足/不满足必须由当前可信操作者确认，未知不补确认人，旧调用缺字段保守为unknown，不解析自然语言冒认否定。

`clarification.ts`复用现有条件和来源资格规则，仅对可继续核验的有条件结果逐项提问；直接冲突、非active、已拒绝前提、待核对边界或来源不足不再打断。原分组、原文和缺口不变，跳过不升级。检索入口继续由共享schema整批拒绝跨工作区关系，新增ID碰撞回归覆盖查询/详情/图/历史/预览，不放宽已通过的安全校验。

## 验证与限制

本轮仅静态阅读生产调用链、既有测试源码和公告；没有新增测试成绩。历史模块、Services/SQLite/进程内HTTP及synthetic transport结果保留在03历史章节，不为本轮补丁背书。`ablation.test-support.ts`保持同快照/任务/规则，仅移除关系作对照；生产接口不提供消融开关。`platform.test.ts`已有原use/outcome、修订/撤边/恢复与SQLite重开删除阻断的共享链用例，本轮未执行。

CSS可见min-width:0、overflow-wrap、换列断点、固定节点尺寸和滚动图视口；按钮、radio、tab、列表及aria状态保留。它们是源码约束，不是桌面/320px、刷新、前后退、键盘或读屏验收。窗口一04:39/05:36公告已记录部分真实连接、页面和空库查询，不能继续写“完全未连接”或认定浏览器仍不可用；这些记录也不是本模块有知识/语义索引/回答/图谱完整验收。

静态发现的共享差额已在04登记：W4-REQ-007为1.31页面身份绑定尚仅覆盖intelligence，检索及其批准/恢复请求缺统一绑定和回显；W4-REQ-008为检索最多260路径与五入口100路径/证据40关系的预算衔接。不能复制身份协议或截掉路径和覆盖警告后假称交接完整。

最终G3/G4/G5、真实CNB知识库语义与索引、模型及完整浏览器仍分项待验收。由窗口一协调共享修复与授权后的执行检查；本轮不启停服务、不commit/push、不修改共享代码、其他feature或根README。
