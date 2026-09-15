# 窗口二捕获接口

## 当前接入状态

2026-09-16本机静态核对，当前源码契约为1.31.0。**静态检查，未运行测试**，未运行HTTP、SQLite回归、浏览器、健康探针、真实CNB或模型请求，未启停服务。节点二既有接入为integrated，本轮修补及全局G0-G5尚未运行验收。完整使用顺序、权限、同意、存储位置与期限见[README.md](README.md)。

W2-REQ-006任务、W2-REQ-008批准登记、W2-REQ-009提取终态及统一operation-recovery已有正式Services/HTTP消费，不重复申请。extract与model-approve要求`retentionDays:7, confirmed:true`，候选批次区分missing/expired/已完成empty，恢复不能从null或空数组推断未执行。共享1.31页面身份头针对AI面板，不改变capture白名单或原操作身份语义。

历史createServices/SQLite/HTTP证据使用synthetic外部CNB/Git/模型传输。窗口一2026-09-16公告另有真实CNB只读和部分桌面/320px浏览器证据，不再沿用“环境完全未接通”；Issue invisible未核验成功，正式应用写入未开放。本轮未探测现有服务，源码版本不等于正在运行的版本。

所有端点使用ApiResponse；身份、工作区、mode来自Services.context。错误响应不转发平台私人正文。请求JSON上限256KiB；导入最多100000个UTF-16字符、200个片段；模型输入最多24000字符，超限拒绝而不是截断。

## 路由

| 路由 | 输入 | 成功输出/实际限制 |
|---|---|---|
| GET /api/capture/status | 无正文 | workspace、aiExtraction=enabled/disabled/unavailable、modelApproval。默认上下文未配置时503；不能由fixture声称live |
| POST /api/capture/issue | `{issueNumber,selected:true}` | 选定Issue的Conversation，sourceAlreadyPersisted=true；不读历史列表 |
| POST /api/capture/preview | 见下例 | `{conversation,task,approvalRequest}`；approvalRequest仅待确认字段，不是已登记Approval |
| POST /api/capture/approve | `{conversation,baseRevision:"new",operationId,confirmed:true}` | 通过Services.approveConversation登记的Approval；客户端固定原登记ID，缺端口503，不自行发放 |
| POST /api/capture/save | `{conversation,approval,confirmed:true}` | 经saveConversation及readConversation读回校验的Conversation；未知结果409，复用原conversation.id核验 |
| POST /api/capture/approvals/:id/revoke | `{}` | 通过Services.revokeApproval撤回；不声称撤销已发出的远程写入 |
| GET /api/capture/:id | 无正文 | 同ID且已核验保存的Conversation；不触发新建 |
| POST /api/capture/:id/model-preview | `{task:TaskContext,segmentIds,scopeConfirmed:true}` | `{input:{purpose:"extract",text,sourceIds},approvalRequest,promptVersion}`；AI关闭/缺权限/密钥/失效范围拒绝 |
| POST /api/capture/:id/model-approve | `{task,segmentIds,scopeConfirmed:true,operationId,expectedInputHash,expectedConversationHash,retentionDays:7,confirmed:true}` | 服务端重算最小输入并校验两个已展示摘要后，通过Services.approveModel登记Approval；缺端口/提供者未配置503，不复用保存批准 |
| POST /api/capture/:id/extract | 模型预览请求字段加`{approval,retentionDays:7,confirmed:true}` | DeliveryReceipt；只有模型批准有效、schema和引用有效、来源版本没变、候选存储读回一致才成功 |
| GET /api/capture/:id/candidates | 无正文 | 经引用校验的DeliveryReceipt；模型关闭或失败后仍可读取 |
| GET /api/capture/:id/model-operations/:approvalId | 无正文 | 原ModelOperationReceipt或null；服务端核验actor/workspace/extract/来源hash，null不证明没有发送 |

### 消费的共享路由

以下由窗口一所有，capture只调用，不注册旁路或生产数据库：

| 路由 | 范围与语义 |
|---|---|
| GET /api/workspace/session | 批准和任务保存前核对原actor/workspace及必要权限，不从用户正文复制身份 |
| GET /api/workspace/operation-recovery/capture/:operationId | 原保存批准登记operationId，校验原actor/workspace/purpose/approvalId/requestHash/contentHash/baseRevision/objectIds；只返回元数据 |
| GET /api/workspace/operation-recovery/model/:operationId?modelPurpose=extract | 原模型批准登记operationId，modelPurpose唯一且为extract；从回执取得实际approvalId后再读提取终态，不返回模型或候选正文 |
| GET /api/workspace/approval-registrations/save_conversation/:operationId | 仅核验原保存批准登记，不保存Issue |
| GET /api/workspace/approval-registrations/model_input/:operationId?modelPurpose=extract | 仅核验原extract批准登记，不发送模型或保存候选 |
| POST /api/workspace/tasks | 完整TaskSaveRequest：operationId、task、expectedRevision、expectedContentHash、retentionDays:30、confirmed:true |
| GET /api/workspace/tasks/:taskId | 原TaskState，按原身份返回available/missing/expired；missing的absenceIsFinal=false |
| GET /api/workspace/task-receipts/:operationId | 原TaskReceipt或null；只读核验原保存，不将最新同值任务认领为本次结果 |
| GET /api/workspace/extraction-operations/:operationId | 当前该operationId等于实际modelApprovalId，不等于批准登记operationId；只返回原ExtractionOperation阶段和身份/来源摘要 |
| GET /api/workspace/conversations/:conversationId/extractions | 同会话原提取操作发现；`absenceIsFinal:false`、`retryAllowed:false`，不以空列表证明未发送 |

捕获预览输入示例（只有已选、已处理的片段，没有未选原文）：

```json
{
  "conversationId": "stable-new-capture-id",
  "task": {"id":"task-id","question":"如何避免重复写入？","constraints":[],"intent":"archive"},
  "source": {"origin":"paste"},
  "segments": [{"id":"source-id/s1","role":"user","text":"选中的脱敏正文"}],
  "personalInfoReviewed": false,
  "scopeConfirmed": true
}
```

source也可为`{origin:"manual"}`，或`{origin:"cnb_issue",issueNumber,sourceRevision}`。CNB来源在预览时重新读取指定Issue核对版本，不把原Issue改写成选中子集。

## 摘要和引用

- 正文使用共享hashConversation；保存状态不改变摘要。新现场baseRevision=`new`，它不是Git版本。
- 模型文本是固定指令与untrustedTask/untrustedSegments的canonicalJson；只含当前问题、约束、选中片段。1.6.0明确批准objectIds=sourceIds、baseRevision=来源Conversation.contentHash，conversationId由平台用于核验已保存来源。
- 模型返回`{candidates:[...]}`，数量0-3；每项仅title/question/claim/kind/whyKeep/uncertainties/spans。不能自带已确认状态、来源证明、对象ID或摘要。
- spans的start/end为UTF-16左闭右开偏移，必须与quote及选中片段精确匹配，不能切断surrogate pair。contentHash使用共享hashSegment。
- Candidate和SourceSpan的ID由受控内容确定；候选state永远proposed。SourceRecord仅证明原话出现，support=unverified。
- DeliveryReceipt为`{conversationId,conversationHash,candidates,state:"saved"|"empty"|"existing"|"missing"|"expired"|"unverified",batch?,handoffHref}`。empty必须有available空批次；legacy只读空数组为unverified，不能解锁未知操作。
- saveCandidates使用`{modelApproval,expectedConversationHash,expectedRevision,retentionDays:7,confirmed:true}`。实际共享平台负责批准/来源/设置重验与SQLite CAS；单进程in-flight Set仍只限制本路由实例并发。原批次不可覆盖，两个独立批准可能各调用模型，不冒称按现场去重计费。

## 页面和交接

固定导出Page、registerRoutes不变。Page兼容NavigationProps及可选routeParams，读取conversationId/approvalId/taskId。Page、TaskPanel、SavePanel、ModelPanel均effect注册/注销共享capture guard，读取最新状态；原批准/写入未知不能用dirty确认绕过。全局hash解析使用窗口一已提供实现，模块不监听/重写hash。

通用交接保持`#handoff?conversationId=...`；手动整理为`#handoff?conversationId=...&source=manual`；单候选为`#handoff?conversationId=...&candidateId=...&source=candidate`。恢复为`#capture?conversationId=...&approvalId=<原模型批准登记operationId>`；历史参数名不能被当成实际Approval.id。仅按会话发现、未持有登记ID时，链接退为现场发现入口，由用户重新选择具体原提取操作，不猜ID、不重发。

原始粘贴和未确认草稿只在当前页面内存，没有localStorage、第二业务数据库、自动上传或私人日志。完整TaskContext仅在单独预览并同意私有保留30天后保存；不随Issue批准暗存，不入Git/语义索引。按taskId或现场taskId只读恢复后，用户必须明确“使用已存任务”；conditionChecks、sourceIssueNumber及未编辑constraint attribution保留。失去原上下文时不能把新输入绑定旧模型批准。

任务编辑固定用户明确恢复的revision和完整task摘要。预览重新读取原任务后，若版本或摘要变化（包括同正文的新revision），拒绝借用新CAS覆盖；必须明确恢复新版本后编辑。保存未知保留原operationId，只GET原回执和原task，严格核验身份、requestHash、contentHash及previousRevision；旧回执不覆盖新版，不续期，不以expired/missing重建旧正文。

## 原批准恢复

- 保存和模型登记各有稳定operationId；requestHash按公共ConversationApprovalRequestSchema/ModelApprovalRequestSchema解析后的完整原请求计算，包含operationId与confirmed。模型不散列capture桥接body，输入批准与候选7天同意仍分别遵循公共模型请求和模块extract范围。
- 丢失、畸形或unknown批准响应只读原用途/ID；严格校验actor/workspace/purpose/modelPurpose/requestHash及原批准的ID、对象、摘要、基准版本和期限。not_registered的absenceIsFinal=false不解锁；registered不是Issue/模型/候选执行成功。
- GET恢复本身不重发、不撤回。保留原完整载荷且本页未发出执行时，用户可“继续原批准”或明确撤回；继续前再次核对原会话、完整请求hash和当前原登记，不新建批准。改范围、过期、失权、取消或非最终缺失均不放行。
- 已发送未知只核验原执行，不能再用“继续”重发。强制刷新后即使地址保留原登记ID，也不具有原完整请求；只提供原操作读回，不重建旧批准载荷，不把新任务正文绑定旧批准。迟到的旧响应不能覆盖已恢复状态或自动执行。

## 当前集成与最终门

1. 七阶段保持：`model_sending`、`model_done`、`candidate_saving`、`unknown`不释放重试；`rejected_without_save`必须同时有平台拒绝终态与候选missing，并按rejectionReason区分引用非法、输出非法、来源/设置失效或批准失效，不能由任意错误推断。`saved_empty/saved_nonempty`还需原批准、batch revision、数量与candidateContentHash一致。
2. 只读恢复请求抛异常时，ModelFlow现在回到unknown并释放checking按钮锁；仍保留原身份和发送阻断，不重新批准、发送或落盘。发现得到的实际批准ID不再进入统一登记ID链接。这些修改仅静态复核，未跑回归。
3. 已接TaskStore不等于节点三已展示完整任务；当前handoff读取Conversation/候选，没有TaskState消费。Issue源编号仅可能保存在独立任务中，原Issue版本没有随Conversation保存。分别登记W2-REQ-012、W2-REQ-010，不夸大任务/来源贯通。
4. AI对话归档链接能读取现场及进入manual，但capture对恢复页面保持allowInitialExtraction=false；当前没有从非最终空发现安全开放首次提取的依据。W2-REQ-011待共享设计/消费者确认，不以放宽missing门禁实现。
5. 真实CNB写入、模型、Git传输、浏览器完整主线及G0-G5由窗口一按各自授权组织；本轮没有执行。

## 检查

本轮仅文件读取、文本搜索和人工控制流核对；未执行单测、类型、边界、构建、HTTP/SQLite、浏览器或探针。下次获准后优先核验：发现操作的恢复链接不携带实际批准ID；两个只读GET分别抛异常能再次人工核验；不同rejectionReason正确显示；七阶段、双刷新和重启不重发。历史通过数不能验证本次改动。

## 历史说明边界

以下为2026-09-05的历史实现记录。旧接口阻塞、端口状态、浏览器错误和通过数不代表当前；当前结论以本文顶部及节点二03/04为准。

## 第二轮恢复与取消约束

以下保留各版本历史说明；接口就绪、参数和当前缺口以本文顶部及最新03/04报告为准。

2026-09-05，兼容共享契约1.5.0；治理可选端口的增加不代表模型批准已提供。本模块前缀、请求字段、Page/registerRoutes导出不变。

- SavePanel使用模块内CaptureSaveFlow管理页面内存中的一次操作；不是新增业务存储。重复确认只发送一次批准/保存；预览取消立即恢复可操作状态。取消/离页后晚到的批准会尝试撤回，绝不继续写入。已发出的写入保持unknown，只有匹配原ID、工作区、共享正文摘要、saved状态及Issue位置的读回才能变为saved。
- 模型批准必须与用户已展示的preview.approvalRequest匹配。来源或输入在批准期间改变时，客户端撤回不匹配批准且不调用extract。取消不直接中断批准响应的读取，以便撤回晚到批准；已发出的提取被取消或响应丢失仍为unknown。
- 服务端在最终来源读取后检查取消，在complete异常时保留UNKNOWN_RESULT；候选落盘前重新检查来源版本、AI开关、取消和批准期限。模型输出/引用失败不调用saveCandidates。
- [历史，2026-09-05] 这些检查当时不是平台的原子授权验证；W2-REQ-004/W2-REQ-009平台能力随后已由公告1.9/1.19发布并由capture消费，当前状态以本文顶部为准。
- 捕获成功和错误响应均设置Cache-Control:no-store、Referrer-Policy:no-referrer和X-Content-Type-Options:nosniff，模块单独组合时也生效。
- 恢复、Issue读取和候选请求在取消/离页后忽略晚到响应。提取交付时取消此前候选读取，避免旧空列表覆盖新结果。空列表仍不能解锁未知模型操作。
- workflow.test.ts覆盖CaptureSaveFlow -> 共享apiRequest -> 捕获HTTP路由 -> 同一套Services fixture：选中脱敏范围不扩大、批准前零写入、丢失保存响应按原ID恢复、晚到批准撤回、AI关闭仍保留现场和交接数据。它不是跨窗口G1、实际平台Services或真实CNB测试。

第二轮历史证据：15:17:15批次18个测试文件97项通过；独立tsc通过。第三轮最新证据见下；真实浏览器、G1参数导航及live授权验证仍待外部能力，不升级为integrated或verified_live。

## 1.6模型批准已适配（Fixture）

`POST /api/capture/:id/model-approve`的新请求为`{task,segmentIds,scopeConfirmed:true,expectedInputHash,expectedConversationHash,confirmed:true}`。两个expected摘要来自用户已查看的model-preview，不能省略；仅传用户输入的模型正文不会被接受。

服务端重新生成最小输入并与两个expected摘要对比，通过后调用共享`approveModel(ctx,{input,objectIds:sourceIds,baseRevision:conversationHash,conversationId,confirmed:true})`；不克隆可信ctx。响应仍为登记的Approval，本次请求不调用模型或保存候选。缺端口保留503，AI关闭/缺权限403，预览变更409，缺确认/摘要或附加模型正文422。

- 批准路由要求conversation:read、candidate:read、candidate:write、model:extract、settings:read；状态路由另要求workspace:read。模型提供者是否就绪仍由平台批准/发送时核验，不因方法存在自动认定。
- checkModelPreview在展示和申请批准前重建当前任务、选中来源与固定提示，核对正文、sourceIds、提示版本、来源版本及hashModelInput；新增未选片段、改写正文或伪造匹配摘要均拒绝。开始新预览先清空旧回执。
- 200个选中片段与内部任务分别扫描；不会把任务误计为第201个来源。密钥检查和24000字符上限保持不变。
- model-workflow.test.ts覆盖真实apiRequest -> 捕获HTTP路由 -> Services fixture的预览/批准/提取/读回、晚到批准取消、旧来源、AI关闭、未配置存储和丢失响应恢复。它不是共享平台/G1/live测试。

## 手动遮盖与本轮证据

手动遮盖仅在指定片段做字面匹配，支持重叠范围合并，禁止拆开UTF-16代理对。最多50项，每项10000字符、总匹配最多5000处；失效/重复/外部片段与空白遮盖拒绝。改动会撤销旧内容确认；未应用输入时不能确认。原文字面及遮盖规则只留在页面内存，HTTP只发送最终片段，稳定片段ID保持不变。

2026-09-05 16:49:22完整模块回归：22文件131项通过。节点二独立tsc、全库pnpm typecheck、目录边界检查通过（40登记路由，无跨feature导入）。共享服务器默认status实测503、mode=unconfigured、contractVersion=1.7.0，保留no-store/no-referrer/nosniff；未启动第二服务器。浏览器重试仍在连接前被本机配置阻断，SSR/HTTP证据不等于320px、键盘或读屏验收。
