# 本地售后客服验证项目

这是一个真正执行工具调用与本地业务状态写入的确定性 Workflow 测试项目，未调用语言模型。它用于先验证 EvalPi 的执行、证据、复核与报告链路。

它包含 4 条用例，每条重复 3 次：正常提交、多轮补齐信息应通过；工具超时后宣称成功、重复提交会暴露两个故意保留的缺陷。预期结果为 6 次通过、6 次失败。

每次运行的 `cwd`、用户目录、临时目录和 sessionId 都独立。多轮对话在同一个用例内部保留上下文。后台记录写入当前工作目录的 `business-state.json`，评测器独立读取并保留快照。

## 接入自己的 Node Workflow

在项目根目录提供 `evalpi.json`，声明 `version: 1`、`entry`、测试输入、预期行为、可选的明确检查规则。入口读取 stdin 的一行 JSON：

```json
{"input":{"messages":["..."]},"caseId":"CS-001","trial":1,"sessionId":"独立 ID"}
```

向 stdout 输出一个 JSON 对象，至少包含业务输出，建议提供 `reply` 和 `trace`。日志写 stderr。可在独立 cwd 写入 manifest 的 `stateFile`，该文件会成为 `output.observedState`。检查规则支持 `equals`、`includes` 和 `exists`，路径使用点分隔。

进程隔离用于减少测试状态相互影响。它不构成对恶意代码的操作系统沙箱；仅执行用户选择并确认的可信项目。外部数据库、远程账号、绝对路径存储等共享状态需要项目适配器自行重置或分配独立测试租户。
