# Git 知识存储格式 v1

W06 读取适配使用 CNB 官方 Git HEAD / commit / contents 接口。当前只有 fixture 证据，未创建任何真实 Git 文件或 Commit。

## 权威对象文件

`knowledge/snapshot.json` 为单一机器可读对象集合：`{schemaVersion:1,workspaceId,nodes,relations,excludedIds}`。
nodes 和 relations 必须具备共享 domain schema 要求的全部业务字段。缺失正文、来源数组、确认字段等一律拒绝，不填入虚构默认知识。

文件内本次修改的节点 revision 和本次明确复核且指向修改节点的关系端点标记 `@snapshot`。这是**存储层占位符，不是 Git 版本**；
读取时先解析默认分支至真实 Commit SHA，再用 `?ref=<完整SHA>` 读取整个文件，对外 VersionRef 用这一真实 SHA 替换占位符。
1.4.0 起未修改对象允许保留完整旧 SHA，未复核的原关系端点保持原引用，不静默绑定变更后的前提；这种失配由窗口四显示并排除关系推理。旧文档全部使用 @snapshot 仍可读取。
这样不会出现“文件内容包含其自身 Commit SHA”的循环依赖。历史读取要求完整不可变 SHA；不接受 main、时间戳或 @snapshot 冒充历史版本。

对外每个节点版本意为“该节点在所引用 Commit 中的内容”。快照 revision 表示全体集合的版本，不要求每个未修改节点都重新产生版本。
人写的 Markdown 视图应由这些同版本结构化对象生成，后续 W07 与 JSON 同一次 Git 提交；Markdown 关系段不另作独立事实源。

## 校验

- 仓库来自可信工作区，不从请求体接入另一仓库。
- 内容必须是指定路径的 base64 blob；核验 Git blob SHA、UTF-8、运行时 schema、工作区、重复 ID 和悬空关系。
- 所有节点/关系/排除清单来自同一文件、同一 Commit，不拼接实时查询或临时数据库中的另一版本。
- 未提供文件或字段时返回错误，不返回伪造空知识库。
- 返回前重新核验会话/配置；删除造成的额外应用阻断将在 W11 接入，W06 本身不声称已实现删除保护。
- @snapshot 只限此文件；客户端、EvidenceRecord 和正式检索结果不得用它当作有效 revision。

## W07 原子提交

`approveKnowledge` / `readCommit` 和受限 Git 发布器已实现 fixture 验证。JSON 与 `knowledge/nodes/<SHA256(objectId)>.md` 同一个 tree/commit 提交；仅允许这些受控路径，保留仓库其他文件。
Git 使用服务端指定的 HTTPS 用户名和令牌、独立 `.local/git-staging` 裸仓库、禁用 hooks/credential helper/全局配置/重定向/其他协议。没有默认启用，不读取开发者 Git 身份或凭据。
远端 ref 使用精确 `--force-with-lease=refs/heads/<branch>:<baseSHA>` 比较，新 commit 必须是 base 的直接子提交。不对用户开发工作树运行 commit/push/reset。
成功必须读回默认分支可达提交、父版本、操作标记与固定快照摘要；丢失响应保持 UNKNOWN_RESULT，重复调用不再次 push。只搜索最近100条，超预算仍 unknown，不能据空结果推断未写入。
同 ID 不同内容冲突；批准撤回/过期/作用域变更在准备后再次检查。节点与关系显式 active/confirmed 恢复可移除对应 Git excludedIds；应用删除阻断优先，后续 W11 不会因此被绕过。
回执 indexing 始终独立，目前 pending；Git 成功不声称向量索引完成。真实账号、分支保护、Git HTTPS 认证、首次知识文件初始化及流水线状态尚未 verified_live。

不要用逐文件 API 成功次数冒充原子提交。该文档的存在也不代表已写入 CNB。
