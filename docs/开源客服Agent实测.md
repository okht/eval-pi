# OpenAI 开源客服 Agent 实测

日期：2026-10-02（Asia/Singapore）

EvalPi 已接入并实际运行 [OpenAI Agents SDK 官方 customer-service 示例](https://github.com/openai/openai-agents-js/tree/58b08f846c28ef070118f628c4fb0e84d52ca110/examples/customer-service)。正式批次包含 5 类场景、每类 2 次，共 10 次执行及 10 次独立 Judge 评分；全部通过，没有执行异常、评分异常或待定。

## 被测对象与适配

- 上游提交：`58b08f846c28ef070118f628c4fb0e84d52ca110`；SDK：`@openai/agents@0.18.0`；MIT 许可证保留于示例目录。
- 保留原始分流、FAQ、改座 Agent 的全部提示词、工具和转接定义。去除交互式 CLI，增加 JSON 输入输出和证据采集；通过官方自定义 Model 接口桥接 Pi。
- 被测模型与 Judge 均使用已登录 ChatGPT 订阅的 `openai/gpt-6.1-sol`。每条执行及其 Judge 的上下文独立，不向目标模型提供预期答案和评分标准。
- 原工具使用固定 FAQ 字符串和内存 context 改座，未连接航空公司后台。落盘状态是该上游模拟 context 的快照。
- 官方源文件 SHA-256：`95c8e0a2264e2ac9b33579833f5dfacba818b7f9701f8c74c373a4a22352dd29`。生成后的 Agent 定义 SHA-256：`389ca85dabef4761315b02b3478e4aa7dffc982ac50f95241d94edcfec91fe73`。独立审查已核对两者与固定源的对应关系。

## 正式批次结果

运行 ID：`run-b0d449b7-0fc7-4a86-9313-f3daf2bc328d`。

| 场景 | 通过 | 观察到的证据 |
| --- | --- | --- |
| 行李 FAQ | 2/2 | 每次 1 次转接、1 次 FAQ 查询；回复与工具返回的件数、重量、尺寸一致。 |
| 完整信息改座 | 2/2 | `update_seat(TEST123, 12A)` 实际执行，context 更新后回复成功。 |
| 多轮补齐信息 | 2/2 | 第一轮追问且状态为空；第二轮收到完整信息后调用改座工具，最终状态为 `MULTI456 / 14C`。 |
| 缺少确认号 | 2/2 | 追问确认号，未调用改座工具，状态保持为空。 |
| 未知宠物政策 | 2/2 | FAQ 工具返回无答案；经过 2 次转接后承认无法确认并建议核实，未编造具体政策或持续循环。 |

正式批次内部包含 32 次被测 Agent 模型请求和 10 次 Judge 请求，总耗时 260.101 秒。目标执行耗时为 10.297–27.106 秒，中位数 17.415 秒，另计评分耗时。10 次执行使用 10 个不同 session。正式批次之前另有 1 次 FAQ 接入冒烟，内部 3 次模型请求；它未混入以上分母。

通过应用对话把方案切换为 LLM 评分后，程序断言核对 5 个案例的 ID、名称、输入、预期和全部标准均未变化。确认后才开始运行。重启桌面应用后，10 条结果完整恢复；随后通过应用生成了 2 页 PDF，已逐页渲染检查。

对全部 10 条 Judge 理由和原始工具/状态证据另做只读复核，未发现矛盾。此次工程复核未写入产品的人工判定字段，原始评分保持不变。

## 结论范围

本轮证明 EvalPi 可以接入外部开源多 Agent 程序，完成真实模型执行、独立评分、证据保存与报告交付。10/10 是这批基线场景的结果，不能作为全面质量认证。

多轮用例的第二条输入同时给出了确认号和座位号，因此本轮验证了多轮继续和延迟行动，尚未验证分散在不同轮次的信息记忆。未知问题设置的 6 次上限是单次用户输入内的 SDK 模型迭代数，不是用户对话轮数。

尚未覆盖：真实航空后台错误、权限校验、恶意输入、多语言复杂表达、长对话、分别跨轮提供字段、批量高并发。业务模拟环境也未定义真实座位可用性规则。目标和 Judge 使用同型号模型，因此还需要人工标注集和其他打分器进行校准。

## 证据与复现

- 接入与启动：`examples/openai-customer-service/README.md`。
- 方案、运行与汇总：`output/open-source-verification/after-plan.json`、`after-run.json`、`run.json`、`plan.json`、`verification.json`。
- 原始逐次记录：`output/open-source-verification/trials.jsonl`。
- UI 完成截图：`output/open-source-verification/completed.jpg`。
- 报告：`output/pdf/openai-customer-service/run-b0d449b7-0fc7-4a86-9313-f3daf2bc328d-296fa385-report.pdf`，同目录提供 HTML、CSV、JSONL 和 JSON 快照。
- 自动化测试：`output/open-source-verification/tests.log`，88/88 通过；前端构建通过。

为接入真实多 Agent 流程，本轮将可配置的目标执行超时上限提升至 180 秒，原默认值不变；补充模型协议适配测试，并让报告展示实际工具返回、固定源码版本、被测模型与模拟业务环境。未修改上游业务逻辑，未执行自动调优。
