import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '..', 'codex节点');
const { workers, contractVersion } = JSON.parse(await readFile(path.join(root, 'coordination/assignments.json'), 'utf8'));
async function create(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await access(file); } catch { await writeFile(file, content, 'utf8'); }
}
const link = (worker) => `[${worker.folder}](${worker.folder}/开始.md)`;
const total = workers.reduce((sum, worker) => sum + worker.tasks.length, 0);
await create(path.join(output, 'README.md'), `# codex节点：六窗口并行启动包

这是你要分别交给六个Codex终端的文件夹。**开六个窗口即可，六个窗口共同写一个“作品”，不是六套独立项目。**

统一工程：\`${root}\`。

## 分配表

| 窗口 | 交给它的文件夹 | 原子任务数 | 主要代码范围 |
|---|---|---:|---|
${workers.map((w) => `| ${w.number} | ${link(w)} | ${w.tasks.length} | ${w.number === 1 ? '平台、契约、应用入口与集成测试' : `src/features/${w.feature}/`} |`).join('\n')}

总计${total}项本轮实施任务。它们是六个并行责任包内部逐个完成的小任务，不是要开${total}个窗口。此前讨论的118项全量拆解尚未全部交付；本轮先提供可启动的并行实施范围。

## 实际启动

1. 六个终端都先进入同一个工程目录：\`cd "${root}"\`。
2. 在每个Codex对话中发送对应子目录的\`开始.md\`内容，或让它读取该文件后执行。
3. 每个窗口先读自己的\`00_前置知识.md\`与公共契约，再按\`02_逐节点任务.md\`逐个实现。
4. 窗口二至六可以立即用自己测试中的Services fixture开发，不用等待真实CNB接通。
5. 只有窗口一维护共享契约、安装依赖、启动共享服务器和最终集成；接口问题写到本窗口\`04_接口申请.md\`。

## 不要做的事

- 不把“节点文件夹”当代码输出目录；所有代码只在“作品”内。
- 不复制六份作品；不让六个窗口都运行脚手架初始化或修改package.json。
- 不让所有窗口轮流改一个全局文件；公共变更由窗口一协调。
- 不自动提交Git、切分支、reset或还原别人的未提交变更。
- 不把fixture跑通称为真实CNB已接通。

## 交付状态

当前交付为共同工程骨架、固定接口、窗口说明和任务单。完整业务尚未实现，真实CNB未接入。检查结果见\`../作品/coordination/基线验收.md\`；不存在该文件时表示基线验证尚在进行，不代表失败或完成。

先读[全体窗口必读.md](全体窗口必读.md)与[集成顺序.md](集成顺序.md)。
`);

await create(path.join(output, '全体窗口必读.md'), `# 全体窗口必读

## 你们正在共同完成什么

腾讯选题是CNB个人知识图谱，不是通用聊天工具或孤立的学习网站。唯一主线：任务与对话 → 范围/隐私 → CNB Issue → AI候选 → 人的解释与边界判断 → Git正式知识与关系 → CNB知识库召回与图关系检查 → 下一次任务采用/不采用 → 结果记录与修订。

来源：\`../新总结/\`、\`../设计操作系统分析/\`和\`../08_新系统设计_逐节点实施蓝图/\`。这些是设计资料，不是可直接声称的真实用户实验。不要为实现一个小节点重新读取53篇全部语料。

## 不可改变的底线

1. 人决定目标、保存范围、正式表达、关系、不可逆写入和退出；AI只提议。
2. 发送模型和持久化前确认范围，已有CNB内容必须说明已在平台保存。
3. 人的确认、来源支持、知识有效性、行为证据分开。看过答案不算无提示掌握。
4. 图关系必须参与召回/条件/冲突/替代检查；图有列表和文本路径等价方式。
5. Git为正式知识事实源，派生图可重建；修改影响未来检索，历史仍可解释。
6. 候选、私人Issue和学习记录默认不入语义索引；删除按层说明真实能力。
7. 模型关闭或失败时，已有文本、来源、关系和导出仍可使用。

## 开发协作

先读\`${root}/AGENTS.md\`和\`${root}/coordination/接口契约说明.md\`。每个窗口只改自己的分配范围；窗口一是共享文件唯一维护者，不等于他可以覆盖其他模块。

接口版本${contractVersion}。业务模块固定导出Page与registerRoutes。平台访问一律经过Services。对其他模块只知道其对象契约和API，不导入内部实现。

每次只实现一个任务单，测试通过再继续。自己模块的fixture测试不受真实CNB账号未就绪阻塞。需要真实写入、付费模型、部署、公开或删除时，必须取得对应授权。

只有窗口一执行依赖安装、全局格式化、共享服务器和集成检查。其他窗口可运行\`pnpm exec vitest run src/features/自己的模块\`、\`pnpm typecheck\`与\`pnpm check:boundaries\`。读到别人的未提交变化，不要还原。

## 报告必须真实

状态使用：pending、working、implemented_fixture、integrated、verified_live、blocked。只有对应证据存在才能升级。报告改动文件、测试命令和结果、fixture/live区别、剩余风险以及接口申请。禁止“已完成”掩盖未接通端口。
`);

await create(path.join(output, '集成顺序.md'), `# 六窗口集成顺序

## G0：共同基线

共享契约、Page/registerRoutes、目录边界和基础测试先固定。代码已经预留模块接口，窗口二至六同时开始本模块测试和实现；窗口一同时处理真实CNB能力验证。

## G1：捕获到交接

窗口二交付Conversation/Candidate与稳定来源ID；窗口三能用同一ID读取和保存草稿。验收含敏感范围、取消、模型失败和未知写入。窗口一提供真实存储替换fixture。

## G2：提交到检索

窗口三提交ChangeSet获得真实CommitReceipt；窗口四用KnowledgeSnapshot和CNB召回读到对应节点，未确认/撤回对象不进入正式结论。Git保存与索引状态必须分开。

## G3：检索到应用与验证

窗口四交付版本固定的结果及路径；窗口五保存有条件的采用/不采用记录，并提供与普通任务独立的无提示验证。已看过答案的记录不能冒充无提示证据。

## G4：修订到新查询

窗口六修改关键前提或撤回关系；窗口四重跑同题，旧结论不再无条件可用；窗口五旧记录保留原版本解释。删除已阻断但平台清理待完成必须可见。

## G5：整体可用

窗口一运行pnpm check、全部端到端、键盘/读屏、移动端、AI关闭与授权CNB真实验证。确认同一个前端、同一个API、同一个事实源。只有到此才能说“六窗口成果可以作为完整系统使用”，单模块通过不等于此门通过。

## 接口变更协议

窗口提出本地接口申请 → 窗口一复核是否真缺共享能力 → 先改契约与契约测试 → 公布版本和受影响窗口 → 每个受影响窗口适配 → 集成测试。没有聊天窗口之间的自动消息总线，窗口一需要读取各交付报告，用户也可把报告内容转给它；不得假定其他会话已知道你的改动。

一次契约变更未完成集成前，不叠加第二个破坏性变更。若使用同一Git工作树，不切分支、不统一回退、不运行清理命令。
`);

for (const worker of workers) {
  const folder = path.join(output, worker.folder);
  const start = `你是掌舵腾讯CNB个人知识图谱项目的窗口${worker.number}，负责“${worker.name}”。\n\n唯一代码目录：${root}\n你的任务说明目录：${folder}\n\n先读取这个目录下的00_前置知识.md、01_职责与边界.md、02_逐节点任务.md，以及作品/AGENTS.md和作品/coordination/接口契约说明.md。不要重新创建项目，不要复制另一套工程，不要修改其他窗口拥有的文件。\n\n从自己的第一个未完成原子节点开始，一次一个节点：检查已有代码与契约，写失败测试，实现，运行本模块测试与类型检查，更新03_交付报告.md，再继续下一个节点。共享端口未接通时在自己的测试目录注入fixture，不修改共享实现。缺接口写04_接口申请.md交窗口一处理。未经批准不真实调用付费模型、写CNB、部署或公开数据。\n\n这是实现请求，不要只给计划；持续推进到本窗口任务完成或出现明确需要用户处理的外部阻塞。完成时说明真实测试结果、改动路径和未完成项。\n`;
  await create(path.join(folder, '开始.md'), `# 窗口${worker.number}启动提示词\n\n将下面这段发给本窗口，或者让Codex读取并执行本文件。\n\n\`\`\`text\n${start}\`\`\`\n`);
  await create(path.join(folder, '00_前置知识.md'), `# ${worker.name}：前置知识

## 产品目的

${worker.goal}

系统服务用AI完成技术/课程/研究任务的个人用户。不是用大图伪装知识，也不是强迫学习。系统保留人的陈述、条件、来源、版本和应用结果，让下一次任务能判断旧知识是否适用。

## 人与系统

人可选择只归档、修改、拒绝、稍后、关闭AI、撤销、导出和删除。AI提议不自动升级。已有Issue、Git和向量索引分别具有不同保存与删除边界。不要把用户确认当来源证明，不把采用当掌握。

## 你收到什么

${worker.upstream}

## 你交给谁

${worker.downstream}

## 你的高风险边界

${worker.risks}

## 必须先读的最小资料

1. \`${root}/AGENTS.md\`
2. \`${root}/coordination/接口契约说明.md\`
3. \`${root}/src/contracts/domain.ts\`、\`api.ts\`、\`ports.ts\`
4. 本目录的职责边界和当前一个原子任务单。
5. \`${output}/全体窗口必读.md\`与\`集成顺序.md\`。

需要解释选题或设计时，按需阅读\`${path.join(root, '..', '08_新系统设计_逐节点实施蓝图')}\`中的\`00_系统定义与唯一主线.md\`、\`01_腾讯选题逐项体现.md\`、\`03_人的主权与交互规范.md\`。不要因相对路径不对重新生成一套方案。
`);
  await create(path.join(folder, '01_职责与边界.md'), `# 窗口${worker.number}：职责与边界

目标：${worker.goal}

## 允许修改

全部相对于\`${root}\`：
${worker.owns.map((p) => `- \`${p}\``).join('\n')}

另可更新本说明目录中的\`03_交付报告.md\`和\`04_接口申请.md\`。不要修改其他窗口报告。

## 路由所有权

${worker.routes.map((r) => `- \`${r}\``).join('\n')}

业务端点可以扩展本模块前缀下路由，但不得占用别人的前缀；先写请求/响应契约和对应测试。入口\`Page\`与\`registerRoutes\`保持兼容。

## 禁止

${worker.number === 1 ? '不覆盖其他业务模块；公共契约升级须通知受影响窗口；不要为了全局测试通过删掉业务测试。' : '不修改package.json、锁文件、src/contracts、src/app、src/server、src/platform和其他业务模块；不自行安装依赖或启动共享dev server。'}

不在作品外写代码，不重建工程，不切分支或还原别人的修改。不要建立另一份用户、知识或关系事实源。个人模型密钥不得放浏览器、本模块源文件或日志。

## 依赖与完成

上游：${worker.upstream}

下游：${worker.downstream}

所有任务须有正常、异常、取消/拒绝、权限/版本测试；UI加键盘、长文本和窄屏。真正外部副作用读回核验。单模块通过后等待集成门，不声称完整系统完成。
`);
  const taskLinks = [];
  for (const [index, task] of worker.tasks.entries()) {
    const [id, name, behavior, acceptance] = task;
    const filename = `${id}_${name}.md`;
    taskLinks.push(`| ${id} | [${name}](逐节点任务/${filename}) | ${index === 0 ? '共享契约就绪' : worker.tasks[index - 1][0]} | pending |`);
    await create(path.join(folder, '逐节点任务', filename), `# ${id} ${name}

窗口：${worker.number} ${worker.name}。初始状态：pending。此文件是任务规格，不是实现证据。

## 单一目标

${behavior}

## 最小上下文

先读本窗口00/01、公共契约及这个任务的直接上游；不要一次实现整个系统。窗口内建议前置：${index === 0 ? '冻结的公共接口与已有模块入口' : worker.tasks[index - 1][0]}。该顺序是可执行建议；不相关纯函数可先做，但不得跳过真实契约依赖。

输入/输出对象严格使用\`src/contracts/domain.ts\`与\`ports.ts\`中适用类型；若缺字段先提交接口申请，不能私造同名类型。开始编码前在测试中写出本节点实际使用的输入样例和期望输出。

## 行为与人的控制

${behavior}

人可以取消、修改或拒绝本节点涉及的建议和写入。无确认时不能产生正式知识或外部副作用。机械处理不要求人重复填写已有数据。AI输出、用户文字、来源事实和系统状态保持可区分。

## 必须通过的验收

${acceptance}

至少写：一个有效输入成功测试；一个本节点关键错误测试；一个取消/拒绝或无权限测试。涉及版本再加并发/过期测试；涉及外部写入再加重复提交及未知结果测试；涉及UI再加键盘、长标题和320px布局检查。

错误使用统一ApiResponse/Result，说明数据是未写入、已保留、部分完成还是未知。禁止返回错误后仍显示成功，也禁止为了测试通过吞错。

## 写入边界

只在窗口${worker.number}的允许目录内实现代码和测试。不得改上游共享契约、其他模块或全局样式来迁就本任务；窗口一的共享修改也必须遵守版本与集成协议。

## 完成记录

在\`../03_交付报告.md\`记录：改动文件、输入输出、执行的测试及结果、fixture/live模式、未完成项、接口变更与后续依赖。只有对应证据存在才能标implemented_fixture、integrated或verified_live。
`);
  }
  await create(path.join(folder, '02_逐节点任务.md'), `# ${worker.name}：逐节点任务

本窗口${worker.tasks.length}项。一次只实现一个，再测试与记录；不要求一次完成整张清单。

| ID | 独立任务单 | 建议前置 | 初始状态 |
|---|---|---|---|
${taskLinks.join('\n')}

此表保留初始计划，实时状态写\`03_交付报告.md\`，不要把初始pending误当运行中的实时状态。依赖的外部端口未ready时，使用本模块测试fixture继续可独立工作。
`);
  await create(path.join(folder, '03_交付报告.md'), `# 窗口${worker.number}交付报告

状态：pending
当前任务：尚未开始
代码目录：${root}

## 任务进度

${worker.tasks.map(([id, name]) => `- [ ] ${id} ${name}`).join('\n')}

## 本次改动文件

待填写。

## 执行的测试和真实结果

待填写。区分未运行、失败、fixture通过与真实CNB验证。

## 接口申请与集成说明

待填写。

## 未完成项与风险

待填写。不能只写“全部完成”。
`);
  await create(path.join(folder, '04_接口申请.md'), `# 窗口${worker.number}接口申请

当前：无已提交申请。

每个新申请记录：

- 申请ID：W${worker.number}-REQ-001
- 当前任务：
- 现有契约为什么无法表达：
- 建议最小字段/端口/依赖：
- 输入和输出示例：
- 兼容性影响及受影响窗口：
- 暂时可用的fixture/不受影响工作：
- 窗口一处理结果和契约版本：待协调

提出申请不等于获准修改共享文件。窗口一须主动读取各目录报告；不同聊天窗口不会自动获知新内容。
`);
  await create(path.join(folder, 'AGENTS.md'), `# 本窗口说明

你负责窗口${worker.number}：${worker.name}。先读开始.md、00_前置知识.md、01_职责与边界.md、02_逐节点任务.md。代码只能写在\`${root}\`中被分配的路径。不要在本说明文件夹写代码或初始化工程。

用户把本文件夹交给你不代表授权修改整个项目。遵守作品/AGENTS.md。每次完成一个节点更新本窗口交付报告，公共接口变更写接口申请，不自行覆盖其他窗口代码。
`);
  if (worker.number !== 1) {
    const featureDir = path.join(root, 'src/features', worker.feature);
    await create(path.join(featureDir, 'client.tsx'), `import { ModuleStatus } from '../../app/ModuleStatus';\n\nexport function Page() {\n  return <div className="${worker.feature}"><ModuleStatus title="${worker.name}" feature="${worker.feature}"/></div>;\n}\n`);
    await create(path.join(featureDir, 'server.ts'), `import type { Hono } from 'hono';\nimport type { Services } from '../../contracts/ports';\nimport { notImplemented } from '../../server/respond';\n\nexport function registerRoutes(app: Hono, _services: Services) {\n${worker.routes.map((route) => { const [method, url] = route.split(' '); return `  app.${method.toLowerCase()}('${url}', (c) => notImplemented(c, '${worker.feature}'));`; }).join('\n')}\n}\n`);
    await create(path.join(featureDir, 'AGENTS.md'), `# 窗口${worker.number}专属模块\n\n读取\`${folder}/开始.md\`与职责边界。只修改本目录，保持client.tsx的Page及server.ts的registerRoutes导出，不跨业务模块导入。共享契约和全局入口由窗口一维护。测试文件放本目录。\n`);
  }
}

console.log(`Prepared ${workers.length} worker folders and ${total} task files in ${output}`);
