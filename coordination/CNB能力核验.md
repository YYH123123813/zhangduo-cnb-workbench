# W01 CNB 能力核验

日期：2026-09-05。状态：implemented_fixture。**未进行任何真实账号验证。**

## 文档证据与账号证据分开

本次只匿名读取 CNB 官方 OpenAPI：`https://api.cnb.cool/swagger.json`。
文档存在不代表本账号具有权限，也不证明平台实际的隔离、删除或原子性。

| 能力 | 官方文档入口 / 最小权限 | 本次账号证据 |
|---|---|---|
| 身份 | GET /user；account-profile:r | pending，无授权 |
| 工作区 | GET /{repo}；repo-basic-info:r | pending，无授权 |
| Issue | GET /{repo}/-/issues/{number}；repo-issue:r；包含 invisible | pending，需双身份/无权限读取验证 |
| Git 版本 | GET /{repo}/-/git/commits/{ref}；repo-code:r | pending，原子写入与读回需单独授权 |
| 知识库 | GET /{repo}/-/knowledge/base；repo-code:r | pending，需核实 include/exclude、Issue 同步和索引版本 |
| 知识库过滤 | GET /{repo}/-/knowledge/base/query；metadata_filtering_conditions | pending，需检验隔离与旧片段阻断，不能把参数存在当有效 |
| AI | POST /{repo}/-/ai/chat/completions | pending，模型 ID、费用、配额和调用均未验证 |
| 评委访问 | 需约定只读范围与独立账号 | pending，不自动公开仓库 |
| 删除 | Git 历史、Issue、索引和缓存须逐层核实 | pending，不声称物理彻底清除 |

## 默认不联网的核验入口

`pnpm exec tsx tools/cnb-verify.ts` 在缺配置/缺授权时非零退出，零远程请求。
仅在用户明确授权后，从服务端环境提供 CNB_TOKEN、CNB_REPO_SLUG，
并将 CNB_VERIFY_READS_FOR 设置为完全相同的仓库路径，才运行只读探测。
可选 CNB_VERIFY_ISSUE、CNB_VERIFY_REF、CNB_VERIFY_KNOWLEDGE=true 扩展已授权范围。
不要在命令行参数、浏览器或报告粘贴令牌。

脚本仅报告 HTTP 读观察、状态码和待验证项，不输出账号详情、Issue 正文、令牌或上游错误。
请求固定发往 api.cnb.cool，禁止重定向，有超时，遇拒绝即停止。
不调用模型、不发送语义查询、不写入、不部署、不删除；HTTP 200 也不会把五个高风险待验证项升级为已验证。

## Live 门所需外部输入

- 明确的仓库及允许只读验证的范围。
- 单独提供的最小权限服务端令牌，不从本机私人配置自动搜集。
- 写入、模型费用上限、评委只读访问、部署、删除分别授权。
- 在获得授权后记录真实结果与读回证据；现有 fixture 测试不能替代这些证据。
