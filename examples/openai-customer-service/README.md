# OpenAI 官方客服 Agent 的 EvalPi 适配

被测项目来自 [openai/openai-agents-js 的 customer-service 示例](https://github.com/openai/openai-agents-js/tree/58b08f846c28ef070118f628c4fb0e84d52ca110/examples/customer-service)，固定提交 `58b08f846c28ef070118f628c4fb0e84d52ca110`，SDK `0.18.0`，MIT 授权见 `upstream/LICENSE`。

原项目有分流、FAQ、改座三个 Agent。每一步决策由真实模型完成，转接和工具执行继续使用官方 Agents SDK Runner。FAQ 是上游固定知识，改座工具修改上游 context；没有连接真实航空后台。

## 保留与适配

- `upstream/index.ts.txt` 保存完整上游原文件；`upstream/agents.mjs` 仅去除 TypeScript 类型、移除交互式 CLI 段并导出 Agent。提示词、工具、业务逻辑和转接关系完整保留。
- `workflow.mjs` 把 CLI 包装为 EvalPi JSON stdin/stdout 协议，采集工具事件和执行后的 context。源文件哈希会在每次启动时核对。
- `pi-model.mjs` 实现官方 Model 接口，使用当前应用的 ChatGPT 订阅完成推理。此次更换模型传输方式与模型选择，未复现上游默认 API 模型配置。
- 每次 Trial 使用新进程、空 context、新历史和独立模型会话；同一 Case 内的多轮共享必要上下文。每个用户轮次最多 6 个模型轮次，每例最多 180 秒，每个模型请求最多 60 秒，不自动重试目标调用。
- SDK 云端 tracing 已关闭。模型输入仍会发送至已连接的模型服务；工具和业务状态仅使用虚构测试数据。

## 准备与运行

在仓库根目录执行，Node.js 需为 22.19 或以上版本：

```text
npm ci
node scripts/prepare-openai-customer-service.mjs
node scripts/configure-openai-customer-service.mjs
npm run desktop
```

准备脚本从固定官方提交下载源码和许可证；配置脚本要求用户已在 EvalPi 完成 ChatGPT 订阅登录。它只在被 Git 忽略的 `.evalpi-local.json` 保存应用凭据存储的路径和模型选择，不复制凭据。请勿将该本机配置分享给其他机器。此适配只面向已审查的官方示例，不给任意第三方项目自动分配模型访问权限。

在 EvalPi 中读取本文件夹，通过对话把方案改为 LLM 评分，核对后确认并开始。`evalpi.json` 包含 5 个案例，每例 2 次：行李 FAQ、完整信息改座、多轮补齐、缺确认号追问、未知宠物政策。最后一项明确属于产品可用性探索，评测要求包括避免循环转接。

评分需要同时检查回复、工具参数、工具结果和运行器读取的 `business-state.json`。该状态文件是上游模拟 context 的快照，不能作为真实订单后台变更的证明。目标 Agent 与 Judge 在本轮使用同一型号模型，但采用独立上下文；结果不构成对 Judge 准确率的校准。

## 验证

```text
npm test
npm run build
```

根目录 npm workspace 包含本示例依赖，模型适配器测试通过官方 Runner 检查 handoff、工具调用与结果回传，无需消耗模型额度。真实执行记录另存于 `output/open-source-verification/`，本次评测结论见该目录的验证记录和报告。
