# ContestReplay Bench CLI v1 草案（历史参考）

> **文档状态**：早期架构草案，保留作背景参考。当前实际命令、Agent Manifest v2、本机 Studio 与测试说明以 [README](../README.md) 和 [Studio 配置契约](studio-contract-gaps.md) 为准；后续演进见 [路线思考](roadmap.md)，静态公开榜单提案见 [统一 Web 与结果文件](bench-web.md)。

目标仓库：`ycyc0421/ContestReplay`。可运行入口见 [README 快速开始](../README.md#快速开始)。

## 技术栈

| 层 | 首版选型 |
| --- | --- |
| CLI 与监督器 | Node.js 24 LTS、TypeScript（strict，`tsc` 编译）、pnpm；用 `node:util` 的 `parseArgs` 解析命令，`node:child_process` 管理容器，内置适配器通过 Docker stdio 做本地 IPC。 |
| 配置与数据契约 | JSON + Zod 校验场次、Agent 描述和 IPC 消息；各适配器自己解释原生配置，首个内置适配器用 TOML。 |
| MCP 与判题 | 官方 MCP TypeScript SDK；MCP 工具只是入口，计时和判题维护在独立的 TypeScript 模块。 |
| 模型中继 | 官方 OpenAI JavaScript SDK（`openai`），只在沙盒外调用指定的 Responses API；沙盒内的适配器只通过本地 IPC 调中继。 |
| 隔离与产物 | Linux + Docker；TypeScript 不承担隔离。产物仍是 `run.json` 和 `events.jsonl`，不引入数据库。 |
| 测试 | `node:test` + fake 模型与可注入时钟；Docker 隔离另做集成测试。 |

先建一个 runner package。静态 Web 与 runner 共用可分享结果的数据契约，不依赖 runner 的执行代码。

## 1. 一次 bench 是一场比赛

**一次 bench 评的是一个完整 Agent 跑完一场比赛，不是裸模型回答若干题。** 场次提供完整的原始题面 PDF，Agent 由明确版本的 harness 和它的原生配置组成；配置固定一个多模态 API 模型。Bench 不拆题、不逐题提示、不替 Agent 规划顺序，也不从聊天内容提取答案。Agent 自行阅读、选题、求解和提交。首版只选择全场计分题都能自动判定的场次。

### 首发模型与输入路径

- 首发只接一个已登记的 harness 适配器。沿用首跑建议：**OpenAI Responses API / `gpt-4.1-2025-04-14`**，用自制图题实测原生 PDF 与函数工具。若快照不可用，显式修订 Agent，不静默退回浮动别名。
- 首版把完整 PDF 作为原生文件输入交给 API，不转成纯文本，不挑页；超出限制则拒跑，不裁剪。换成逐页图片等做法会改变模型可见的输入，需用不同协议。只支持 API 模型；测试用 mock 不进真实榜单。

## 2. CLI 分层

```text
cr bench run <contest.json> --agent <agent.json> [--out <dir>]
cr bench export <run-dir> --out <result.json> [--id <result-id>]  # 后续
```

`bench run` 是唯一必做命令。`contest.json` 引用完整 PDF 和私有判题数据；`--agent` 指定可运行的 Agent；`--out` 指定**原始运行产物根目录**（默认 `runs/`），每次在其下新建 `<run_id>/`，不覆盖旧运行。v1 使用项目固定的版本化协议，Agent 不选择或覆盖赛规；需要多套赛规后，再加显式 `--protocol`。

流程是预检 → 分配运行 ID 和输出目录 → 启动隔离环境 → 运行并落盘。另见 [`problems.pdf` + Codex 的完整填写示例](bench-codex-example.md)，其中 Codex 仍是待验证的候选适配器。预检不调模型；开始后打印运行 ID 和目录，结束后打印状态。不做自动重试、断点续跑、SQLite 或后台服务。`--out` 产物不是可直接发布的导出。

校验、导入、批跑、回放、公开导出和排名属于上层。导出可用调用方指定的 `result_id` 标识发布条目（默认沿用 `run_id`）；这个 ID 不替换运行记录中的 Agent 身份。回放和重排不修改原始事件，也不要求再调 API。

建议退出码：`0` 有效完赛（可零分、可有题未提交），`1` 开跑前预检失败，`2` 已开跑但作废。用户中断尽量写作废事件；进程硬退出时，缺少终止事件的日志也不参与排名。

## 3. Agent 描述、适配层与比赛环境

### 统一外层，不统一原生配置

`agent.json` / `agent.v1` 是稳定入口。`config` 指向所选 harness 的原生配置，格式由登记的适配器解释，不强迫不同 harness 使用相同字段。示例：

```json
{
  "schema_version": 1,
  "agent_id": "baseline-gpt41",
  "harness": {"kind": "builtin-responses", "version": "0.1.0"},
  "config": "responses.toml"
}
```

- **Bench supervisor** 负责协议、沙盒、计时、判题和日志，不解析各家配置。**适配器**根据 `harness.kind` 和版本读取、校验原生配置，解析实际模型及设置，接入只读 PDF、本地比赛工具与受限模型通道，并报告结束原因。首版只登记内置适配器，不接受描述文件传入任意宿主命令。不能落实隔离或比赛契约的 harness 不接入。
- `agent_id` 是维护者选定的稳定名称，记录同一 Agent 系列的表现；`agent_revision` 由 runner 根据锁定的 harness/适配器版本、解析后的非密钥配置及影响行为的制品摘要计算。同名但换模型、配置或 harness 是不同修订。配置不嵌凭据；首版只允许明确纳入记录的配置与依赖，不继承用户目录或全局配置。API 实际报告的模型 ID 另记（未给则 `null`）。
- `run_id` 由 runner 生成，唯一指向一次尝试；同一 Agent 修订可有多次 run。发布侧可按 `agent_id` 展示历史，但不把不同修订自动合并成同一次评测。`result_id` 只做发布索引，不替代这些身份。

### 沙盒与 API 边界

- 沙盒里运行 harness 和它调用的本地工具，默认禁止外连。协议可允许在临时工作区无交互执行工具（YOLO）；这是免逐次确认，**不是关闭隔离**。v1 不允许宿主目录、凭据、容器管理 socket 或私有判题数据进入沙盒。仅提供只读题面、所需配置与程序、临时可写工作区，以及显式批准的本地通信通道。监督器在外侧限制时间、进程与资源，并独占可信日志和输出目录。
- **无互联网并不等于不能调用比赛指定的模型。** 内置 harness 在沙盒内驱动轮次；宿主中继负责保存对话上下文、附上完整 PDF、构建固定的 Responses 请求。容器不能传 URL、模型名或工具定义。只有中继持有 API Key；它不提供通用转发、服务端搜索、远程工具或 URL 文件抓取。依赖公网的现成 harness 要先适配受限通道。
- 本地资源纳入协议：可用程序、文件范围和是否允许 shell 都影响可比性。首版可以先只开放提交和交卷，把本地 shell 放到明确允许它的协议里；沙盒不可用时不降级为宿主直跑。

### 沙盒后端：复用现成运行时

| 方案 | 建议用途 | 取舍 |
| --- | --- | --- |
| [Docker](https://docs.docker.com/engine/) / [Podman](https://podman.io/) | 首版用一个现成 OCI 运行时，先验证 Docker 后端，优先 rootless | 可固定镜像摘要，限制网络、挂载、CPU、内存和进程数。两者不必在 v1 同时适配。 |
| [Bubblewrap](https://github.com/containers/bubblewrap) | Linux 上轻量的本地备选 | 可做进程和文件系统隔离，但需要自行配齐运行环境、资源限制及清理，不作为首发。 |
| [gVisor (`runsc`)](https://gvisor.dev/) | 需要在共享机器上跑更不可信的 Agent 时，作为加强隔离的候选 | 可沿用 OCI 镜像，但需额外验证部署支持和工具兼容性；普通容器与宿主共享内核，不能当作虚拟机边界。多租户部署不沿用首版的信任假设。 |

ContestReplay 不自写隔离机制。首版只封装启动、限额、超时终止和清理；固定本机运行时及镜像摘要，记入运行元数据。镜像预先构建或拉取，同一镜像摘要可以复用；**每个 run 都新建一个容器、临时工作区、Agent home 和 IPC 端点**，不复用上次的容器、可写卷或会话。完赛、作废或可处理的中断均由 supervisor 清理；强制退出时可能留下孤儿容器，需按 run 标识回收，下一次仍从新容器开始。比赛时使用 `--network=none`、只读根文件系统、非 root 用户和有大小限制的临时工作区；不挂载容器管理 socket 或宿主项目目录。内置适配器以 `docker run -i` 的 stdio 做单次运行 IPC，代理推理与提交；容器只发送轮次和工具调用索引，不自行透传 API 请求。需要接入现成 Agent 时可以再增加 Unix socket 桥，不为 IPC 放开容器联网。是否有隔离不能只看启动参数：用自制样本验证外连失败、题面只读、判题和日志不可访问、受限中继及提交仍能走通，以及超时能回收整个容器。先做一次 Linux 本地验证再锁定后端，不在 `agent.json` 增加自由配置沙盒的入口。

### 提交接口

同一个比赛会话保留模型与工具的交互历史。开局只提供完整 PDF、比赛规则及协议规定的工具，不提供标准答案、逐题提示或联网搜索。比赛统一提供两个本地 MCP 工具：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `submit` | `problem_id: string`, `answer: string` | 按 PDF 上的题号提交，返回 `accepted`、`wrong_answer`、`invalid_submission` 或 `already_accepted` 等固定反馈。不返回标准答案。 |
| `finish` | 无 | 主动交卷，关闭提交入口。 |

可信判题器和 MCP 服务由 supervisor 在沙盒外管理，不部署对外 HTTP 服务。内置适配器的宿主侧以 MCP SDK 的内存 transport 调用 MCP 服务，将白名单工具映射成 API 函数。模型不直接连接 MCP 服务；Codex 等原生 MCP 客户端的桥接不在当前实现中。私有判题数据只给判题器，不进沙盒、PDF 附件、提示词或工具返回。首版建议协议限制推理轮数和**总提交次数**，由中继和判题器分别在沙盒外执行，不能由 Agent 的原生配置放宽。仅限模型轮数不足以防止可执行本地工具的 Agent 直接反复调用 `submit`。首版关闭并行工具调用；如仍收到多个调用则按收到顺序处理，交卷后的调用不再判分。单题上限和罚时留给具体赛规。

### 计时与终止

- `t=0` 在预检及沙盒启动完成后、supervisor 放行题面并允许推理前开始。Supervisor 用自己的单调时钟给提交盖章，记录 `elapsed_ms` 和递增 `seq`；不采用 Agent 自报时间。时间包含 Agent 本地执行、API 等待、PDF 传输和工具往返，不代表纯推理用时。
- 以 supervisor 接收并受理 `submit` 的时间为提交时间；`elapsed_ms >= time_limit_ms` 的调用不接受。截止后不发新请求、不接受迟到调用；对截止时仍在等待的请求尽力取消。已接受的提交应判完，判题器故障则仍作废。
- `finish`、适配器确认 Agent 正常结束、由 supervisor 确认达到协议预算，都算 `completed`；未解题不是运行失败。限流、连接错误、在赛时截止前触发传输超时、沙盒异常退出、工具或判题器故障均作 `void`；若仍在等待请求时正常到达比赛截止时间，则为 `completed`。首版关闭客户端自动重试，保留已记事件；复跑开新 `run_id`。
- 首版判题用确定性的答案匹配：裁剪首尾空白后与评分数据中的允许答案比对，不用模型判题。每题首次 `accepted` 计该题满分，后续提交记 `already_accepted` 不改变得分；保留所有尝试以便以后抉择罚时。未知题号或无效提交的事件也保留，不与已判错误或基础设施失败混淆。

## 4. 数据契约

先写出可读 JSON 示例和语义校验，再固化 schema。所有路径引用相对于所属声明文件，不进入公开结果。

### 场次（`contest.json` / `contest.v1`）

```json
{
  "schema_version": 1,
  "contest_id": "demo-2025-final",
  "data_version": 1,
  "title": "自制样例 · 2025 · 决赛",
  "source": {"name": "ContestReplay 自制样例"},
  "statement": {
    "path": "contest.pdf",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "redistribution": "allowed"
  },
  "judge": {
    "path": "judge.json",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "redistribution": "restricted"
  }
}
```

摘要为占位。开跑前校验 PDF 和判题文件摘要；`contest_id` 与题号保持稳定。换题面、答案、分值或计分题集合时提升 `data_version`，不覆盖旧修订。PDF 和评分材料分别记录来源及授权（`allowed` / `restricted` / `unknown`）；再分发许可与允许向 API 发送材料是两回事，跑分者须另行确认。题面 PDF 不得附答案或赛后解析。

### 私有判题（`judge.json` / `judge.v1`）

```json
{
  "schema_version": 1,
  "problems": [
    {"id": "1", "max_points": 3, "accepted_answers": ["B"]},
    {"id": "2", "max_points": 5, "accepted_answers": ["12"]}
  ]
}
```

`problems` 非空，题号唯一、对应 PDF 的题号，满分为正整数，允许答案为非空字符串列表。全场满分从题目求和。不能用自动匹配完整判定的赛事不作为首发。判题文件只在本地使用；公开导出不得包含标准答案或模型提交的答案内容。

### 评测协议与本地日志

- 协议声明 `protocol_id` / `protocol_version`、统一比赛提示、PDF 输入方式、模型可用资源和工具、工具反馈、判题规则、赛时、模型轮数及输出预算。影响可比性的协议变更要升版本。Agent 自身设置若未由协议统一，就披露实际设置；这种同榜比较的是整套 Agent，不是单独比较模型。
- `<out>/<run_id>/run.json` 保存固定运行元数据：场次和协议 ID/版本及内容摘要、`agent_id`、`agent_revision`、模型标识及实际请求参数、runner/harness/adapter/judge 版本、沙盒环境版本及资源限制、允许使用的工具、起始 UTC 时间等。保存可回放的本地输入引用及摘要；不保存密钥、授权头或凭据。私有判题材料仅保存在本地受控位置。
- `<out>/<run_id>/events.jsonl` 逐条追加：每条含 `schema_version`、`seq`、`elapsed_ms`、`type`。至少记录中继观察到的模型请求/响应（含可取得的请求 ID、报告模型、用量与完成原因）、比赛工具调用、判定与失败、终止状态及原因。Agent 的本地输出若收集，应单独标为不可信，不用它推导成绩。日志可保留模型原始可见输出和提交内容；附件用引用和摘要，不在每个请求事件重复写入 PDF。不要求 API 提供未公开的推理内容。先落盘已收到的提交，再追加关联判定，避免只留聚合结果。

例如，同一题错一次、再通过（仅摘录提交、判定和终止事件）：

```jsonl
{"schema_version":1,"seq":4,"elapsed_ms":12000,"type":"submission_received","submission_id":"s01","problem_id":"1","answer":"A"}
{"schema_version":1,"seq":5,"elapsed_ms":12004,"type":"submission_judged","submission_id":"s01","verdict":"wrong_answer","points_awarded":0}
{"schema_version":1,"seq":9,"elapsed_ms":27000,"type":"submission_received","submission_id":"s02","problem_id":"1","answer":"B"}
{"schema_version":1,"seq":10,"elapsed_ms":27004,"type":"submission_judged","submission_id":"s02","verdict":"accepted","points_awarded":3}
{"schema_version":1,"seq":14,"elapsed_ms":30000,"type":"run_ended","status":"completed","reason":"finish"}
```

**罚时现在只采事实，不写死榜单公式。** 例如上层可以用首次通过时间 + 通过前错误提交次数算罚时，也可以只按分数排；无效提交是否算罚时由排名策略另定。回放使用提交事件的时间，不用判题完成时间。将来公开结果契约独立版本化，只导出经允许的字段（如运行配置、题号、分数与允许发布的时间/判定摘要），不直接发布日志、模型原文或受限材料。同榜至少要求相同 `contest_id`、`data_version`、`protocol_id`、`protocol_version` 且运行有效完成；纯排序变化另记排名规则版本。若改变模型当时可见的反馈或比赛规则，则必须换评测协议，不能靠事后回放补齐。

## 5. 首个验收

用一份含图、至少两题的自制完整 PDF，和脚本化模型响应测试：所有题面只在开局由完整文件引入；模型可以先做后面的题、错后重交；按提交时间回放；没提交也可正常交卷；达到时限后拦截迟到提交；中途 API 故障作废且保留已有事件。还要验证沙盒无法外连、读取判题文件或写可信日志，中继拒绝非指定模型和远程工具；更改 Agent 配置生成新修订，重复运行生成新 run ID。再经中继用指定模型快照做一次真实小样本，确认 PDF 图题可读和提交工具正常。赛事系列、正式赛时和是否设单题提交上限待选定样本后再定。
