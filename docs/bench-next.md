# 下一版设计：真实 Harness 与 OJ 判题（历史参考）

> **文档状态**：真实 Codex 适配、MCP 异步提交（`submit`/`status`/`finish`）与 Codeforces Practice 适配已落地，Agent Manifest v2 与 Provider 凭据库取代了文中的早期单文件 TOML 草案。当前实现以 [README](../README.md) 和 [Studio 配置契约](studio-contract-gaps.md) 为准；Codeforces 配置重构以及 QOJ / VJudge 适配计划见 [路线思考](roadmap.md)。

## 1. 当前 MVP 和目标架构的区别

当前宿主 `runner/run.ts` 构造消息历史，附 PDF，调用模型，解析函数工具并把结果追加到下一轮。容器内的 `runner/worker.ts` 只验证 PDF 文件头，再发送 `ready`、`next` 和 `tool(index)` 信号；它没有会话历史，也没收到模型答案或工具参数。它验证了隔离和 IPC，但不是可以替换成 Codex 的真实 Agent 入口。

目标是把完整的 Codex 进程放进容器。它自己组装提示词、调用模型、管理上下文、选择本地工具并通过 MCP 提交。`cr` 不接管其对话循环，只准备输入、注入临时配置、启动/回收容器、监督比赛并记录可信事件。宿主模型中继负责调用指定 API，不规定 Codex 怎么管理对话。内置 Responses 以后也可以遵循这个边界。

### 默认整场交给一个 Agent 会话

- 开场只发一次完整比赛任务。一次 harness turn 可以包含多次模型调用和工具往返；`cr` 不按题或按模型调用插入新指令，也不因一次提交或某题通过而打断 Agent。Agent 自己决定做题顺序、何时看判定和是否重交。
- 首版用单次启动模式，不做 daemon。`finish()` 主动交卷；若 harness 正常退出但未调用 `finish()`，记录为 `agent_ended`，停止接收新提交，按已提交的结果结算。赛时或约定预算耗尽也停止接收提交；进程、模型或判题基础设施异常与正常退出分开记录。
- 如果实测常见 harness 会在还没想交卷时提前结束 turn，再考虑显式的「只认 `finish`」协议：仅在前一 turn 已结束且未交卷时，用该 harness 支持的方式续接**同一会话**，不重置比赛时钟、不丢上下文、不逐题提示，也不把异常退出当成可重试的 turn。续接受总时限和协议预算约束，不能无限拉起；不支持可靠续接的 harness 不使用这个模式。这会影响成绩，需单独标记评测协议。

## 2. 一个用户配置入口，一类 Harness 一个适配器

建议保留场次和 Agent 两个入口，分别复用，不再要求 `agent.json` 包一层日常 `config.toml`。拟议用法：

```sh
cr bench run contest.json --agent codex.toml --out runs/
```

```toml
id = "codex-high"
harness = "codex"
model = "gpt-5.3-codex"        # 例子；以实际接入和验证为准
api = "responses"             # 请求协议，不等于 URL
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY" # 指定凭据来源，不存 Key 值
reasoning_effort = "high"
```

- `cr` 校验共用入口；每个 harness 的适配器解释自己支持的协议、模型和参数，生成原生配置并启动锁定版本的 harness。不支持的值直接报错，不静默降级。版本默认由适配器锁定，实际版本、模型和非密钥设置写入运行记录。原生配置覆写只在确有需求时作为受控的适配器特有选项，不先设计通用原生配置层。
- `base_url` 是**宿主中继的上游地址**，不是让容器访问的地址。运行者应明确配置可信上游并让凭据与该地址绑定，不能让题面、Agent 运行时或未经信任的导入配置替换端点并带走默认 Key。容器只访问本次运行的本地模型通道。
- Codex 的原生 `config.toml`、provider URL、是否要求 `auth.json`，取决于锁定的 CLI 版本和 provider/认证路径，需要实测。优先使用它支持的自定义 API provider 接本地通道；若需要为该通道提供本地认证文件，由适配器在新 `CODEX_HOME` 中生成本次运行所需的本地认证材料。不得复制个人 `~/.codex/auth.json` 或把真实上游凭据放进容器。若版本只有带真实凭据/登录态才能走通，则这条路径暂不支持，而不是放宽禁网或凭据隔离。

## 3. `judge` 是判题后端，不等同于本地答案文件

场次仍从完整 PDF 开始，选用一种判题方式。字段示意（省略其他场次元数据）：

```json
{
  "statement": "problems.pdf",
  "judge": { "kind": "codeforces", "contest_id": 1234 }
}
```

如果试卷题号和平台题号一致，不再列一遍题目；不一致时加映射，例如 `"problem_map": { "1": "A", "2": "B" }`。具体 OJ 决定赛事定位、语言映射和判定状态如何转换。`judge: {kind: "local", ...}` 仍可引用私有判题数据；自动化测试可用假 OJ，模拟排队、编译失败和通过，不实际提交。

程序题由 Agent 通过比赛 MCP 提交，例如 `submit({problem_id, language, file})`。`file` 只能指向容器工作区里的源码；由沙盒内 MCP 桥读取并以有大小限制的内容交给宿主，不能让宿主凭 Agent 提供的路径读文件。宿主选用仓库登记的 OJ adapter/脚本、持有独立的 OJ 凭据，把源码提交到已配置的具体赛事和题目；不执行源码、不向容器开放 OJ 网页。适配器只集成平台明确允许的提交路径，在授权的环境测试；目前不假设 Codeforces 有可用的通用提交 API，也未验证任何真实写入流程。无获准提交方式时使用自建/本地 judge，不做未授权自动提交。

## 4. MCP 工具与比赛结算

| 工具 | 行为 |
| --- | --- |
| `submit({problem_id, language, file})` | 受理源码并返回本地 `submission_id`；远端还没出 verdict 时返回 `pending`，不阻塞 Agent 继续做其他题。 |
| `status({submission_id?})` | 指定 ID 时查这一笔在本次运行中的状态；省略时返回剩余赛时、已通过题号和待判提交 ID。只读、不消耗提交次数；只返回 runner 已知且赛规允许的反馈，不让 Agent 直接轮询 OJ。 |
| `finish()` | 主动交卷，关闭提交入口；不会撤销已受理的提交，也不用 Agent 等待这些提交全部出判定。 |

- 提交时间和判题时间分开记。事件关联本地 ID、远端 ID、受理/送达/最终判定时间和 verdict；受理必须早于比赛截止，远端判定可以晚于截止。比赛结束后由 `cr` 在有限时间内独立收齐已受理提交的判定，不为了等 OJ 再唤起 Agent。反馈策略也属于评测协议。
- 建议用 runner 受理且最终确认送达的提交时间作为 `cr` 计算罚时的基准；若要复刻原 OJ 官方排名，远端记录和该场计分规则另行处理，不能把两套时间混用。`AC`/`WA`/`TLE`/`CE` 等是平台判定；上传失败、无法确认是否已上传、超时仍未出 verdict 都不是 `WA`。默认在有限等待后把结果标记为未完成或作废，不盲目重试可能已经形成的远端提交。

实现优先级：先把比赛监督和真实 harness 的对话循环拆开，用 fake OJ 验证异步提交；再验证一个锁定 Codex 版本的本地模型通道及完整 PDF/全页图输入；真实 OJ 写入等确认允许的提交路径后再接。CLI 参数准备、结果查看和结果交换使用同一套 [静态 Web](bench-web.md)，不另建配置站。
