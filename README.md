<p align="center">
  <img src="public/evalpi.svg" width="128" alt="EvalPi logo" />
</p>

<h1 align="center">EvalPi</h1>

<p align="center">一句话完成 Agent 的评测与调优。</p>
<p align="center">Evaluate and optimize agents with a single instruction.</p>

EvalPi 面向 AI 产品经理，希望让用户结合 PRD 和评测标准，用一句话完成 Agent 的评测、问题分析、调优与效果验证。

## 当前可用能力

当前已实现第一条本地评测链路：Electron 桌面应用与 React 工作区、Pi 模型连接、项目读取、方案确认、实际执行、批量复核和报告交付。

- **模型连接**：Pi SDK 提供 ChatGPT OAuth 登录与 API Key 配置，支持选择模型和 OpenAI 兼容服务。2026-10-02 已用用户完成授权的 ChatGPT 订阅验证 `gpt-6.1-sol` 主 Agent 生成方案、8 次批量独立 Judge 评分及基于保存证据的结果复述；其他账号、模型及额度仍需分别验证。
- **对话与方案**：主 Agent 根据应用提供的项目摘要和用户目标交流，提交未确认的评测草案。执行由应用控制，用户确认当前方案后才能开始。
- **本地项目执行**：读取项目的 `evalpi.json`，调用既有 Node Workflow 入口。任意文件夹尚不能自动变成可运行的评测项目，需要提供适配协议与入口。
- **重复与隔离**：使用 Promptfoo 调度；每次尝试使用独立子进程、session ID 和临时工作目录，采集输出、Trace 与可选业务状态。同一 Case 内的多轮上下文由入口负责处理。
- **判定与复核**：支持明确规则检查和独立 LLM Judge；明确业务规则失败保留为失败。执行证据在模型评分前保存，评分失败、取消和业务失败分别记录；未完成评分可基于原证据重试，无需重新执行被测项目。人工批量判定、评分重试与自动复核单独留档。
- **报告**：根据实际执行生成 HTML 预览、PDF、CSV、JSONL 和 JSON 快照，区分原始规则、模型评分、人工判断与重试结果。报告入口显示在对话中，重开页面可恢复当前批次预览；PDF 排版失败时保留 HTML 与附录。
- **本机保存**：保存项目、方案、运行和复核状态；恢复时读取较新的运行快照，运行中批次标记为中断，已有执行证据保留。主 Agent 与 Judge 支持超时和取消。API Key 仅保存在当前进程内存，OAuth 凭据使用本应用独立的本机目录。

自动修改代码、持续调优、独立盲测及任意 Agent 自动适配尚未实现。当前报告描述本批实际执行，不生成尚未发生的调优效果或费用。

## 启动

需要 Node.js 22.19 或更高版本、npm。Windows 请使用 PowerShell 7（`pwsh.exe`）。首次安装依赖：

```text
npm install
```

浏览器开发模式，同时启动 Vite 与本机运行服务：

```text
npm run dev:full
```

访问 [本地工作区](http://127.0.0.1:5173/)。Vite 使用端口 5173，本机服务使用端口 4317。桌面模式会先构建前端，再启动 Electron 与独立后台进程：

```text
npm run desktop
```

检查命令：

```text
npm test
npm run build
```

2026-10-02 最新验证结果为 111 项自动化测试通过，前端构建通过。测试覆盖原有 HTTP、模型、报告、执行器、运行时和开源模型适配器，以及新增的 Judge 数据来源、标签隔离、指标分母、重复稳定性、取消与验收报告边界。`npm run dev` 仅启动前端，适合查看静态演示；实际工作区操作需要 `dev:full` 或桌面模式。

## 先跑通内置客服项目

1. 在真实工作区选择内置客服验证项目，或选择 `examples/customer-service` 文件夹。
2. 查看方案并确认，点击「开始评测」。这个确定性项目无需模型账号。
3. 观察 4 个 Case 各重复 3 次，共 12 次执行；预期为 6 次通过、6 次失败。
4. 批量复核问题，在对话中输入「生成评测报告」，查看本批 HTML、PDF 与附录。

该项目实际启动进程并写入测试业务状态，故意保留虚假成功承诺和重复提交两个缺陷，适合验证链路；结果不能代表真实大模型质量。接入自己的项目请参考 [Node Workflow 适配协议](examples/customer-service/README.md) 和 [示例 manifest](examples/customer-service/evalpi.json)。

连接模型后，已通过自然语言将同一批 4 个案例改为 LLM 评分、每例重复 2 次，案例输入、预期与标准保持不变。主 Agent 生成待确认草案，经确认后实际执行 8 次并完成 8 次 `gpt-6.1-sol` 评分：4 次通过、4 次失败、0 次待定、0 次异常，8 个独立 session。对应三页 PDF 已逐页目视验收。被测对象仍为上述确定性程序，主 Agent 和 Judge 使用真实模型；此验证不代表 Judge 准确率或真实客服模型质量已验收。评分失败重试、取消及恢复通过受控模拟测试，未人为制造真实服务故障。

评测器会在每次启动前核对入口文件指纹，发现变更后停止剩余执行。进程和工作目录隔离不提供操作系统级沙箱；外部数据库、共享账号和远程服务的状态需要适配器自行隔离。依赖文件及外部服务版本尚未冻结。

产品方向见 [产品定义](docs/产品定义.md)，早期框架讨论见 [技术选型建议](docs/技术选型建议.md)，本轮实现与验证边界见 [真实评测链路验收](docs/真实评测链路验收.md)。

## 评测真实开源 Agent

已加入 [OpenAI 官方客服多 Agent 示例的适配](examples/openai-customer-service/README.md)，固定上游提交与 SDK 版本，保留三个 Agent 的提示词、工具和转接逻辑。通过现有 ChatGPT 订阅运行真实模型，业务工具沿用上游模拟实现；每条用例及重复均独立。准备步骤、测试范围和证据边界见示例说明。较长的 Agent 流程现在可配置每例最多 180 秒，原默认超时不变。

已通过应用完成 5 类场景各 2 次的正式批次：10/10 通过，目标内部真实调用模型 32 次，另有 10 次独立 Judge 评分；报告为 2 页。完整结果和覆盖边界见 [开源客服 Agent 实测](docs/开源客服Agent实测.md)。这批小样本基线结果不表示真实航空业务或全面模型质量已经验收。

## 验收打分器自身

已加入固定版本的 RAGTruth QA 人工标注子集（48 条独立来源）与 12 条构造的证据契约探针。工程入口直接复用应用现有 Judge，输出误报、漏判、待定、异常、混淆矩阵与重复稳定性。参考标签不进入模型上下文；开发集、保留集与构造案例分开统计，重复调用不增加独立样本数。

```text
npm run benchmark:judge
npm run benchmark:judge -- --run --output output/judge-benchmark/my-baseline
node scripts/report-judge-benchmark.mjs output/judge-benchmark/my-baseline output/pdf/my-judge-report --pdf
```

第一条仅预览预算；显式加 `--run` 才调用模型。默认 60 Case × 2 次，复用本机 EvalPi 订阅连接，不修改当前项目批次。详细来源、过滤口径、CLI 参数和证据边界见 [Judge 基准说明](benchmarks/judge/README.md)。该能力目前通过 CLI 使用，尚未接入应用内聊天与批量复核界面。

已完成 120 次真实评分：人工开发集首轮匹配 18/24，保留验收集 22/24，构造探针 12/12；8 个参考标签分歧进入待人工复核清单。完整人工组为 40/48，不能只据保留组的 91.7% 宣布 Judge 合格。测量条件、引用口径缺口和最终两页报告见 [Judge 可靠性验收](docs/Judge可靠性验收.md)。

## 真实工作区与历史视觉演示

| 路径 | 用途与数据 |
| --- | --- |
| `/` | 真实工作区，连接本机服务，显示实际项目、执行记录与报告。 |
| `/demo` | 原前端交互演示，使用模拟客服数据和模拟调优进度，不调用运行服务。 |
| `/report-preview` | 三页客服报告的独立视觉演示，使用固定示例数据。 |

`/demo` 保留对话、侧栏、批量复核、暂停与调优进度的早期设计。演示中可输入「生成评测报告」「生成 HTML 报告」或「生成 Markdown 报告」体验文件交付；这些命令及模拟进度不表示真实工作区已具备相同的调优和 Markdown 导出能力。演示状态保存在浏览器内，可通过工作区菜单重新开始。

## 报告视觉预览

在开发服务中访问 [报告视觉演示](http://127.0.0.1:5173/report-preview)，可单独阅读 Pi 风格的固定示例报告，并从页面文件链接生成 PDF。`/demo` 侧栏使用同一套静态报告组件。

运行 `node scripts/export-report-preview.mjs` 会在 `output/pdf` 生成三页 PDF、嵌入字体的离线 HTML 和两份对应附录。报告仍使用客服 Agent 示例数据。

静态演示的字体来源与使用记录见 `public/fonts/SOURCES.md`。演示中文字体随应用提供，浏览器预览和示例 PDF 无需依赖本机安装的字体。

报告视觉规范的来源为私有仓库 [eval-pi-design-system](https://github.com/okht/eval-pi-design-system/tree/main/reports)，约束字体、颜色、Logo 和排版。根据材料自适应组织报告内容与篇幅属于产品后续方向；当前实测报告使用证据驱动的确定性模板，三页客服报告用于视觉演示。

在有权限的环境中检出设计系统后，同步并校验本地资源：

```text
node scripts/sync-report-design.mjs ../eval-pi-design-system
node scripts/sync-report-design.mjs ../eval-pi-design-system --check
```

静态演示的网页预览、离线 HTML 与 PDF 使用 `src/design-system/reports/` 的主题和本地字体，浏览器无需访问私有仓库。中文字体目前是示例字符子集，不能直接覆盖任意项目正文。

真实工作区的报告由 `server/reports.mjs` 根据本批记录生成 HTML，再由 Electron 排版为 PDF。当前采用本机可用的中文系统字体（如 Microsoft YaHei、SimSun）及字体回退，延续相近的纸色、配色和研究报告层级，与静态演示的品牌字体子集实现分开。不同机器的字体可能影响分页；报告页数根据实际案例和证据长度变化。
