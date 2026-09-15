# 掌舵：离线 Transformer 加权训练

这是已有掌舵系统的本地训练 worker，不是另一个服务，也不是 OpenAI 闭源模型训练工具。它使用 Hugging Face Transformers + PEFT/LoRA，学习“授权来源 -> 候选 JSON”的提取行为。OpenAI 只可能是系统另行配置的推理 API 提供方，本模块不调用它。

**模型参数不能替代完整对话、Git 正式知识、关系和来源。** 对话保存、模型发送、知识确认、训练同意分别授权；训练和推理结果均不能自行确认知识。原文仍在既有保存链路中，正式节点/关系仍由人的确认进入 Git，图谱检索仍依据知识库与可核验来源。

本轮 B 完成状态是 `implemented_fixture`：最终 worker 的真实离线合成梯度、重载和公共指标契约已验证。A 已实现 HTTP/Services 到 Python 的接线，旧版 worker 有历史联合证据；本轮修改后的 HTTP 联合验收由 A 在 B 冻结后重新安排。真实预训练模型 LoRA 和产品质量评估仍未验证，详细版本与证据见 `coordination/AI接入并行/B/最终收尾报告.md`。

## 环境与固定来源

从工程根目录执行命令：

```sh
cd '/Users/applemima1111/Desktop/腾讯比赛/作品'
training/.venv/bin/python --version
git -C training/vendor/transformers rev-parse HEAD
```

现有环境实测为 Python 3.11.15、CPU、PyTorch intra-op 线程数 2。保留既有 `.venv`，不要重建或升级。固定直接依赖如下；这不是完整的传递依赖哈希锁，不承诺不同操作系统/硬件位级复现。

| 组件 | 固定版本/来源 | 本地许可证核验 |
| --- | --- | --- |
| Transformers | `4.46.3`，官方 `huggingface/transformers`，vendor 提交 `052e652d6d53c2b26ffde87e039b723949a53493` | Apache-2.0，`training/vendor/transformers/LICENSE` |
| PEFT | `0.13.2`，官方 `huggingface/peft` | Apache-2.0，已安装分发元数据 |
| PyTorch | `2.2.2`，官方 `pytorch/pytorch` | BSD-3-Clause，已安装分发元数据 |
| NumPy | `1.26.4`，官方 `numpy/numpy` | BSD-3-Clause；wheel 内捆绑组件另有许可证，保留各自声明 |
| Tokenizers | `0.20.3`，官方 `huggingface/tokenizers` | Apache-2.0，已安装分发元数据 |
| Safetensors | `0.6.2`，官方 `huggingface/safetensors` | Apache-2.0，已安装分发元数据 |

Transformers 固定源码地址：`https://github.com/huggingface/transformers/tree/052e652d6d53c2b26ffde87e039b723949a53493`。本机 vendor 的 origin 已核对为官方仓库，worker 优先从其 `src/` 导入，缺失时才使用已安装包。其他组件可按上述官方仓库和固定版本审阅源码；本轮未修改 vendor。开源库许可证不授予任意模型权重或训练数据的使用许可，本地基础模型必须另行核对其许可证与来源。

仅在**新环境且由 A 获得依赖安装授权后**执行以下安装步骤；B 本轮没有执行安装，也没有下载模型：

```sh
python3.11 -m venv training/.venv
training/.venv/bin/python -m pip install -r training/requirements.txt
```

现有环境不重复执行 `venv` 命令。若所用平台无法安装固定基线，由 A 处理兼容性，不临时升级第三方库或放开远程代码来绕过错误。

## 两种模式

| 模式 | 数据与基础模型 | 能验证什么 | 能否启用提取 |
| --- | --- | --- | --- |
| `smoke` | 内置 16 条合成样本、8 个对话组；随机初始化 tiny GPT-2；真实 LoRA | 梯度更新、权重作用、掩码、分组、保存重载和命令协议 | **不能**；worker 和平台均应拒绝 |
| `lora` | 单独授权的已确认知识样本；事先准备的本地预训练基础模型 | 在该模型/数据上进行离线适配器训练 | 仅完成训练、重载核验、独立验证损失未退化，并经人的启用操作后试用 |

smoke 的权重固定为 `1 + groupIndex/4`（1 到 2.75）；只消费 settings 的 `steps` 和 `learningRate`，不把界面 importance 等业务参数重新计算为一套 Python 规则。`samples` 必须为 `[]`，传入外部样本会被拒绝。个人权重配置的行为由共享 `trainingWeight()` 和授权 lora 样本链路验证，不应从 smoke 推导。

## 复现合成验证

已有依赖即可运行，不需要 API Key、共享服务器或预训练权重。每次使用**新的 run-id**，脚本拒绝覆盖已有目录：

```sh
training/.venv/bin/python -B training/tests/run_tests.py --run-id my-b-tests-001
training/.venv/bin/python -B training/examples/run_smoke.py --run-id my-b-smoke-001
```

测试入口只发现 `training/tests/test_*.py`。smoke 入口使用 `examples/smoke-request.json`，实际启动 `worker.py train`，然后检查 smoke 推理拒绝和同目录重跑拒绝。后两项子进程预期退出码是 1；全部符合预期时 smoke 验证脚本退出 0。

使用工程已安装的 TypeScript 环境，可进一步只读加载公共 Zod 契约，检查该次真实指标以及合成示例的设置、业务权重、候选和 JavaScript UTF-16 引用：

```sh
env TSX_DISABLE_CACHE=1 TMPDIR="$PWD/.local/fixture/intelligence-parallel/B/my-b-smoke-001/tmp" node --import tsx training/tests/check_contract.ts "$PWD/.local/fixture/intelligence-parallel/B/my-b-smoke-001"
```

结果写入该次目录的 `contract-check.json`；这不是 HTTP 联合验收，也不修改公共契约。为保留原证据，该校验文件存在时不会覆盖。

证据、临时文件、HOME/cache 均隔离到 `.local/fixture/intelligence-parallel/B/<run-id>/`。子进程环境不继承用户 API Key；强制 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`、禁遥测、tokenizer 并行关闭、OMP/MKL 2 线程。JSON 证据标记 `synthetic`；源码 SHA256、固定 vendor 提交和依赖版本随新一轮证据保存。两个入口均核验运行前后源码未变化；测试入口还检查自己的新目录没有遗留符号链接，不扫描或清理旧证据。测试超时 180 秒、smoke 子命令超时 600 秒时，终止并等待自己的确切子进程，以 124 记录到日志，不记成功。离线开关不是 OS 级网络沙箱，不应据此运行未知的第三方代码。

本轮实际证据目录及每条命令的退出码见 `coordination/AI接入并行/B/最终收尾报告.md`，旧 `交付报告.md` 仅为历史版本证据。测试中的模型加载 spy、模拟指标、异常注入只验证协议及拒绝路径，不当作真实训练证据；真实梯度证据来自独立 smoke 运行。

## 输入格式

平台先创建私有运行目录，写入 `request.json`，再启动：

```sh
training/.venv/bin/python -B training/worker.py train '<absolute-run-dir>'
```

工作目录必须为工程根；run-dir 必须为已存在的绝对路径，位于工程 `.local/` 之内，不能直接以 `.local/` 本身作为运行目录。拒绝 `..` 和从 `.local` 到 run-dir 任一级符号链接，即使链接仍指向工程内也拒绝；与 runner 的正常目录规则一致。标准请求：

```json
{
  "mode": "lora",
  "baseModel": "/absolute/path/to/prepared-pretrained-model",
  "settings": {"steps": 30, "learningRate": 0.0005},
  "samples": [
    {"id": "synthetic-node-a", "groupId": "synthetic-conversation-a", "input": "authorized source", "target": "{\"candidates\":[]}", "weight": 1},
    {"id": "synthetic-node-b", "groupId": "synthetic-conversation-b", "input": "another authorized source", "target": "{\"candidates\":[]}", "weight": 2}
  ]
}
```

这是结构说明，不是质量训练集。完整、仅含合成内容且含来源引用的示例是 `examples/lora-request.synthetic.json`；其 baseModel 是不可直接运行的占位符，worker 不会自动补齐或下载模型。正式 runner 会传完整的 `IntelligenceSettings`，worker 不重写 provider、importance 等业务状态。

- `id` 是样本唯一 ID；`groupId` 必须是**原始对话 ID**，不能用节点 ID、切片 ID 或随机 ID 冒充独立对话。相同对话派生的多个节点始终同组。
- `input` 是授权范围内序列化的 `untrustedTask` 与 `untrustedSegments`。worker 不访问聊天库、浏览历史或 CNB 来补来源。
- `target` 是人已确认知识转为的候选 JSON 字符串。Python 对正权重样本只接受恰好包含 `candidates` 数组的 JSON 对象，数组元素必须为对象；空数组可表达没有候选。具体字段、节点版本、CandidateOutputSchema、来源 quote 与 UTF-16 左闭右开偏移由平台核验；Python 不复制这些审批与业务规则。
- `weight` 直接使用共享契约算好的有限数值，范围 `[0,10]`。零权重在切分、tokenizer、训练、验证前排除；不靠零乘法保留在数据集中。非法权重导致整个请求失败，不能静默扔掉错误样本。
- 结构字段必须非空字符串，样本 ID 不重复，原始样本数量为 1 到 1000。排除零权重后必须有至少两个 group。步数为整数 5 到 200，学习率为 `[0.000001,0.005]`，布尔值/字符串不冒充数值。
- JSON 请求最大 20,000,000 字节；拒绝 NaN/Infinity、数值溢出和重复字段。prompt + input + target + EOS 的 token 总长度不得超过 `min(1024, 模型声明的上下文, tokenizer声明的有效上限)`；超长直接失败，**不会静默截断来源或 target**。

## 权重与损失

业务权重只由 `src/contracts/intelligence.ts` 的共享函数计算：

```text
w = round_to_3_decimals(
  min(maxWeight,
      importance * (1 + reuseInfluence * log1p(max(0, confirmedAdoptionCount)))
                 * (humanEdited ? correctionBoost : 1)))
```

`importance=0` 排除对应真实样本；确认采用次数是行为信号，不是正确性或掌握证明。更高权重表示相对于其他样本更大的优化贡献，不保证更大记忆容量，也不提供数据撤回后的机器遗忘。

训练目标（自然对数交叉熵）：

```text
L_i = mean(CE of shifted target tokens, including EOS)
mu  = mean(weight of all positive-weight training samples)
L_batch = mean(w_i * L_i for i in batch) / mu
```

`mu` 在训练集切分后固定，不能换成当前 batch 的权重之和；否则 batch=1 会把自身权重约掉。prompt 和右侧 padding 的 labels 都是 `-100`，padding 的 attention_mask 为 0。第一个 target token 由最后一个 prompt 位置预测，正常计入损失；prompt 本身不作为预测标签。先按每条样本的 target token 数取均值，再按样本加权，避免长 target 自动占更多权重。

统一放大所有权重会被全训练集归一化抵消，这是相对权重的设计。`weightEffect` 的反事实探针固定同一模型、同一输入及 `mu`，将首条训练样本从原权重改为 0，检查 batch=1 的损失差。单测另有权重 1 与 3 的损失/梯度比例检查。梯度裁剪和 AdamW 会影响最终更新幅度，不能将“权重翻倍”说成“参数或质量翻倍”。

## 训练、验证与模型产物

先排除零权重，再按 groupId 的 SHA256 排序，整组留出 `max(1, groupCount // 5)` 个组。切分不依赖样本顺序，训练和验证组完全不相交；smoke 的 tokenizer 也只用训练部分拟合。平台必须提供真实分组；这不自动检测不同对话之间的语义重复或其他泄漏。

当前为 CPU float32、随机种子 42、LoRA `r=4/alpha=8/dropout=0`、AdamW、batch=2 按训练样本顺序循环、梯度裁剪上限 1。smoke 使用两层/48 隐藏维 GPT-2，目标模块为 c_attn/c_proj；lora 使用 PEFT `all-linear`。步数有限，不保证每个大型数据集样本都已被采到，不提供自动早停、超参搜索、量化、分布式或断点续训。

成功目录：

```text
request.json          平台/合成入口写入的请求，可能包含授权原文
process.json          仅正式 runner 写入的进程元数据；不是 worker 的训练成功标记
attempt.json          独占尝试标记；不是动态状态接口，完成后也保留
base/                 仅 smoke，随机基础模型 safetensors
tokenizer/            tokenizer 配置与词表
adapter/              adapter_config.json + adapter_model.safetensors
verification.json     步进损失、权重探针、排除数、tokenizer/logits 重载核验
manifest.json         模式、基础模型路径、训练/验证 groupId、synthetic 标记
metrics.json          所有验证完成后最后原子写入的成功指标
error.json            失败时尽力写入的受控 code/message；不含私人正文/原堆栈
```

重载时重新从本地读取基础模型、adapter 和保存的 tokenizer；核对完整词表及 PAD/EOS/BOS/UNK 特殊 token，再对全部训练/验证样本逐条检查编码完全一致与 logits `allclose(atol=1e-4, rtol=1e-4)`。参数无更新、非有限 loss/gradient、重载不一致、权重无作用都会失败，不放宽阈值。模型文件可能已部分写出，但失败时不会发布 metrics；推理要求完整精确指标、有限损失、正参数更新/权重作用、重载成功、非空且不重叠的分组和一致的验证组数，并且没有 error 标记。不能靠单独写一个 `reloadVerified:true` 获准推理。系统杀进程/断电/磁盘故障可能只有 attempt 或半成品，不应将“有 adapter 文件”当作完成。

任何已有 attempt、成功结果、error、模型子目录或对应 `.tmp` 半成品的 run-dir 都拒绝重跑，不覆盖旧证据；独占 attempt 创建还会拒绝同目录并发启动。失败后先核验原任务，由用户确认新操作才使用新目录。

## 指标解释

`metrics.json` 保持公共 TrainingRunSchema 的精确字段，不能随意添加字段：

| 字段 | 含义 |
| --- | --- |
| `beforeLoss` / `afterLoss` | 训练集、eval 模式、无权重的逐样本 target CE 均值，便于前后比较，不是训练时的加权 batch loss |
| `heldOutBefore` / `heldOutAfter` | 整对话留出集的同种无权重 CE；正常成功运行非 null，但不是提取准确率 |
| `parameterDelta` | 所有可训练 adapter 参数训练前后的绝对差之和，必须有限且 >0；不是效果评分 |
| `trainableParameters` / `totalParameters` | 可训练参数数量与含 adapter 的模型总参数数量 |
| `steps` | 实际优化步数 |
| `weightEffect` | 固定归一化常数的单样本原权重/零权重损失差，必须有限且 >0 |
| `reloadVerified` | 本地基础模型 + 保存的 tokenizer + adapter 在所有样本上通过重载一致性检查 |
| `validationGroups` | 独立留出的原对话组数量，必须至少 1 |

`verification.json.weightedStepLosses` 是每步加权目标，不同 batch 权重/内容不同，**不能把整条曲线的每次上升当作训练退化**。worker 不把 loss 必须下降设为完成条件；如实输出留出退化，平台应拒绝启用退化的模型。loss 下降、采用次数增加、训练通过都不等于知识正确、用户掌握或产品质量已经提高。

## 离线 LoRA 与推理

由用户事先准备且授权使用的本地预训练基础模型必须具备 `config.json`、tokenizer 与 EOS、`model.safetensors` 或包含全部本地 safetensors 分片的索引。拒绝模型仓库名、相对路径、仅 pickle 权重和 adapter 仓库充当基础模型；所有加载固定 `local_files_only=True`、`trust_remote_code=False`，基础模型加载强制 `use_safetensors=True`。adapter 也必须存在 safetensors，不能回退 pickle。

现有 `src/platform/services.ts` 已把服务端 `aiEnvironment().ZHANGDUO_TRAIN_BASE` 传给 `PythonTraining`；由 A/运行维护者配置事先准备好的绝对本地路径，不能在浏览器填写任意模型路径或 shell 命令。`pretrainedReady` 是 config/tokenizer/safetensors 的静态完整性提示，不保证实际可加载。B 不改运行环境、不启停共享服务、不替用户下载权重。

首次加载本地基础模型 tokenizer 时要求有效 EOS，缺 PAD 可明确设为 EOS；保存后重载或推理不再用该回退修补缺失 PAD。EOS/PAD 必须是词表范围内整数，文件缺失或无法在禁 remote code 条件下加载时返回受控 `INVALID_TOKENIZER`，不显示原始异常或模型路径。基础模型与 adapter 加载失败同样不透传第三方异常。

基础模型需在训练、重载与推理期间保持不变、路径可访问；模型架构、CPU 内存和 tokenizer 兼容性仍须在指定模型上实测。读取 config.json 不等于模型已可加载。本轮未加载任何真实预训练模型，也未用 smoke 的随机权重伪装 lora 验收。

保留推理协议：

```sh
printf '%s' '{"text":"authorized serialized extraction input"}' | training/.venv/bin/python -B training/worker.py infer '<absolute-completed-lora-run-dir>'
```

stdin 仅接受 `{text}`，整个 JSON 输入最多 100,000 个字符且 text 不能为空。推理与训练使用相同 prompt/分隔符，显式 `add_special_tokens=False, truncation=False`。输入超长或不留生成空间时失败；输出最多 512 个 token，且不超过实际上下文余量。输出必须是恰好包含 `candidates` 数组的 JSON 对象，元素必须是对象，空数组合法；格式错误返回 `INVALID_MODEL_OUTPUT`，不伪造候选。成功 stdout 只有一份 JSON，库诊断转入 stderr；平台仍须执行完整 CandidateOutputSchema、来源引用验证及人工确认。

## 接入、启用与停用

网页继续使用既有 `/api/intelligence`，不另开训练端口。真实流程：人选择已确认且当前有效的节点版本 -> 明确训练同意 -> 平台核验 settings revision/nodeRevisions 和来源 -> 共享函数生成 TrainingSample -> PythonTraining 写 request 并调用 worker -> 平台读取指标，异步更新 run。

训练完成不自动激活。人的 `activate` 操作只能试用 completed lora，且重载成功、至少一个独立验证组、heldOutAfter 不高于 heldOutBefore；平台还要复核节点版本、撤回和删除屏障。`deactivate` 只停用该适配器，不删除对话、Git 知识或模型文件。smoke 永远不能激活，worker 的 infer 也独立拒绝。

本轮验证了 Python 协议和现有 TS schema，未改后端或公共契约，也未直接启动网页训练。当前 runner 已实现超时先 SIGTERM、两秒宽限后必要时仅终止确切 child、等待退出，以及有限大小的 error.json 白名单文案映射；B 本轮仅静态核对这部分，未冒用 A 的历史进程测试结果。当前版本的 HTTP 联合验收交 A 排期，详见 `coordination/AI接入并行/B/接口申请.md`。

页面请求结果未知时，以原 operationId 只读 `read_operation`，或读取 overview 核验原 run；`completed` 回执不等于训练完成，`not_found/unknown` 也不证明操作未执行。不要自动重发训练或绕过 attempt。平台独立检查进程并提供 `cleanupReady`，页面不能自行根据失败文字推定可删除。

## 保留、删除与故障

训练请求含授权来源与 target，模型也可能记忆部分内容；这些都是需要管理的数据，不应放进 Git、公开演示包或日志。公共 examples 全为合成数据。平台正式产物在 `.local/<fixture|live>/training/<workspace-sha256>/<run-id>/`，由平台管理；B 合成证据只在自己的隔离目录。

worker 不自动过期或删除训练文件，也不提供页面取消训练命令。既有聊天 30 天保留约定**不自动等于训练副本也保留 30 天**。进程终止或停用模型都不会清理 request/adapter；需要明确删除操作。平台的 delete_run 按批准范围清理单次目录，只有服务端核验 `cleanupReady=true` 才允许；运行中/状态未核验任务不得删除。先核验精确进程退出，不用“页面已失败”推定进程已终止。

删除该运行目录不删除用户外部基础模型、Git/Issue 原始知识、CNB 索引、缓存、备份和磁盘物理残留；不承诺安全擦除或机器遗忘。B 不执行正式目录批量清理，也没有在本轮删除用户数据。来源撤回后应停止使用相关适配器，重新训练需要新的授权与版本核验。

| 失败码/现象 | 处理 |
| --- | --- |
| `INVALID_WEIGHT` / `INVALID_DATASET` | 核对共享权重计算和原始样本；所有权重为零时不训练，不把零悄悄改为 0.01 |
| `INVALID_JSON` / `INVALID_SAMPLE` / `INVALID_REQUEST` | 检查 UTF-8、重复字段、候选 JSON 外壳与请求范围；不补造来源或静默忽略非法数值 |
| `INVALID_DIRECTORY` / `INVALID_FILE` | 由平台确认工程 cwd、私有绝对目录、无链接、必需文件和大小限制 |
| `INSUFFICIENT_GROUPS` | 补充来自其他原始对话的已确认样本；不要伪造 groupId |
| `SAMPLE_TOO_LONG` | 重新明确授权范围或改选样本；不静默切去来源或答案 |
| `INVALID_MODEL` / `INVALID_TOKENIZER` | 核对绝对模型路径、safetensors、完整 tokenizer/EOS、架构与版本；不自动联网补文件 |
| `NONFINITE_LOSS` / `NONFINITE_GRADIENT` / `NO_PARAMETER_UPDATE` | 保留失败证据，检查模型/数值/配置；不填写常量指标冒充训练 |
| `RELOAD_MISMATCH` | 检查本地基础模型是否变化、tokenizer 与 adapter 是否完整；不能跳过重载校验启用 |
| `INCOMPLETE_RUN` | 指标或分组不完整/冲突，或有失败标记；保留原证据，不手填指标恢复 |
| `INVALID_MODEL_OUTPUT` | 模型没有输出合法候选 JSON 外壳；不得入库，继续人工流程 |
| `RUN_ALREADY_STARTED` | 只读核验原任务与进程；不覆盖、自动重跑或删除 attempt 来绕过 |
| `SMOKE_INFERENCE_FORBIDDEN` | 合成随机模型只做结构验证，不开放生产推理 |
| 超时、缺依赖、磁盘故障、非零退出 | 由 A 核验环境/精确子进程；error.json 可能来不及写，不把缺失文件当成功 |

以上为 worker 码，页面只展示 runner 已列入白名单的固定文案；其余错误保守显示通用失败，不透传 stderr 或私人正文。完整码映射不是依赖训练成功的条件。

当前限制：没有真实 CNB/付费 API/用户知识训练，没有预训练 lora 效果证据，没有 OS 级网络或本地恶意文件隔离，没有完整模型文件内容指纹绑定或机器遗忘能力。模型不保证生成合法 JSON、不保证中文提取质量、不保证来源忠实；失败时继续走人工交接，效果需独立评估。
