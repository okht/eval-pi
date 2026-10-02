# EvalPi 打分器公开人工标签基准

当前数据集 `ragtruth-qa.json` 含 48 条 RAGTruth QA 回复，用于验收打分器对「回复是否忠实于提供的资料」的判断。原始问题、资料与回复保留英文，不翻译、不改写。当前数据不覆盖客服业务成功、工具 Trace 归因或综合回答质量。

## 来源与标注

- [RAGTruth 官方仓库](https://github.com/ParticleMedia/RAGTruth)，固定 revision `c103204b9ce28d6bbad859304bf30de72b8ed8fe`。
- [论文与人工标注方法](https://arxiv.org/html/2401.00396v2#S3.SS3)：每条回复由两位人员独立标注幻觉片段，显著分歧由第三人复核。回复由语言模型生成，幻觉标签来自人工。
- 官方文件为 `dataset/response.jsonl` 与 `dataset/source_info.jsonl`，通过 `source_id` 关联。
- 官方仓库采用 MIT，原许可证原样保存在 `LICENSE.RAGTruth`。QA 原资料来自 MARCO；保留源数据的权利边界，仓库 MIT 不视为对底层来源内容新增授权。
- 逐个源文件 URL、字节数、SHA256、样本选择算法、最终数据 SHA256 记录于 `ragtruth-qa.lock.json`。

## 可重现准备

在仓库根目录运行：

```shell
node scripts/prepare-judge-benchmark.mjs
node scripts/prepare-judge-benchmark.mjs --check
node --test tests/judge-dataset.test.mjs
```

原始大文件仅缓存至 `output/cache/ragtruth/<revision>/`。准备器读取缓存或从固定 revision 下载，对三个源文件进行 SHA256 与字节数校验；校验失败即停止，不静默接受变化。`--check` 重建并比较输出，不改动已固定的基准文件。

## 筛选、划分与标签映射

1. 仅取官方 `test`、QA、`quality === good`，剔除含 `implicit_true` 或 `due_to_null` 的回复。首版避免争议定义影响小样本验收；这些边界可另建专项集合。
2. `labels` 为空映射为 pass，否则为 fail。pass 仅表示人工未标出资料忠实性问题，不证明回复全面、有用或适合上线。
3. 筛选后有 837 条候选回复：715 pass、122 fail。固定种子 `evalpi-ragtruth-qa-v1`，按 SHA256 确定性排列，优先保留 24 个 fail 来源，再选 24 个未使用的 pass 来源；每个来源只取一条回复。若无法满足数量即报错。
4. 每类按独立的 SHA256 排序划分为 development 12 条、heldout 12 条，共 24 development + 24 heldout。所有 48 条 `source_id` 互不重复。排列与划分均不依据本次 Judge 输出。
5. 平衡抽样方便观察误报与漏报；其错误比例不代表线上分布，成绩也不能称为完整 RAGTruth benchmark 得分。

## 输入与真值隔离

每条记录的顶层与 `reference` 保存人工标签、片段、来源 ID、生成模型及 revision，只供比较结果与复核证据。**调用 Judge 时只传 `request`**。`request` 通过白名单构建，仅包含匿名 Case ID、通用名称与预期、原问题/资料、通用评判标准、原回复和空 Trace；不包含 gold verdict、标注片段、来源 ID、原生成模型或 split。

`expected` 和 `criteria` 对全部样本相同。输入采用通用资料忠实性任务，不使用人工标注答案提示本次结论，也不伪造工具 Trace。待测输出与资料中的任何指令都应作为证据内容处理。

heldout 仅在本轮实现及提示词固定后执行一个验收批次，批次内允许预先声明的独立重复（默认 2 次）。不要根据 heldout 的错例调提示词后再把同批结果称为独立验收；后续修改应冻结新保留集。数据公开多年，无法排除基础模型训练接触过这些样本，本结果属于公开基准初验。

## 指标边界

以 fail 为需要发现的问题，分别统计错误放行（漏判）、错误拦截（误报）、全样本准确率、有效判定覆盖率和 pending 弃判率。pending 不自动算正确，不从总样本分母隐去；同时记录调用错误与取消，避免把未完成调用合并为待定。该集没有人工 pending 标签，不能借此宣称验收了证据不足待定能力。

独立性来自公开人工标签与隔离的评测请求。后续还需要新收集的中文业务案例、业务专家复核以及带真实 Trace 的工具成功/失败样本。

## 构造的证据契约探针

`contract-probes.json` 为 12 条构造案例，pass/fail/pending 各 4 条。退款、知识查询、多轮座位变更和物流查询各组成一组三条证据对照，同组只改变 Trace，任务、标准与回复保持相同；物流组还包含被测输出评分指令注入。

这些标签由明确契约推导，记录 `labelOrigin: constructed`、`humanReviewed: false`。它们用于发现基础证据处理缺陷，不能充当独立人工标注。组内高度相关，因此报告不展示此组 Wilson 区间。对照组只覆盖有限的中文工具证据场景，不代表全面注入防护能力。

## 运行与复核

工程入口复用桌面应用的 `models.judge()`，通过 Promptfoo 调度，不启动被测项目，也不更改现有工作区项目与运行。每次调用使用独立上下文、禁用缓存，无自动重试；模型连接沿用本机 EvalPi 配置。API Key 若仅存在另一个应用进程内存中，独立 CLI 无法读取；当前已验证的是本机订阅登录路径。

```shell
npm run benchmark:judge
npm run benchmark:judge -- --run --output output/judge-benchmark/my-baseline
node scripts/report-judge-benchmark.mjs output/judge-benchmark/my-baseline output/pdf/my-judge-report --pdf
```

第一条为干跑，只显示案例数和调用预算，不调用模型。默认 60 条、每条 2 次，共 120 次，最大并发 2。可用 `--split development|heldout|contract` 选择集合，`--repeats 1-5`、`--concurrency 1-4` 调整预算。Windows 默认读取 `%APPDATA%/EvalPi/workspace` 的模型连接；其他位置用 `--data-dir <workspace目录>`。输出目录必须不存在，拒绝覆盖历史证据。Ctrl+C 取消后保留已有结果，错误和取消不会自动变为待定或通过。

运行目录包含 `manifest.json`（数据和请求哈希、打分器提示词/配置指纹、预算）、`cases.json`（完整固定输入和参考）、`calls.jsonl`（调用开始记录）、`trials.jsonl`（逐次原始判定）、`run.json` 和 `summary.json`。报告器从逐条日志重建指标；日志存在不完整 JSON 行时停止并报错，避免静默丢弃证据。

`review-queue.json` 收集分歧、重复变化及缺失轮次，默认待人工复核。CSV 包含未运行轮次。人工确认应保存为新增复核记录，不能修改原始标签或 Judge 结果。当前验收入口为 CLI，尚未接入应用内自然语言任务和批量复核界面。
