# ContestReplay (`cr`)

ContestReplay 把历史竞赛当作完整的一场比赛交给 Agent，而不是逐题问模型。Agent 自行读题、解题、提交和交卷；`cr` 负责隔离、计时、判题和回放记录。支持 CLI 批处理和本机 Studio；暂不提供公开榜单网页。

## 快速开始

需要 Linux、本机 Docker、`flock`（util-linux）、Node.js 24、pnpm。使用有权限发送到模型 API 的题面。

```sh
pnpm install --frozen-lockfile
pnpm build
docker build -t cr-bench:0.1.0 .
docker build -f Dockerfile.codex -t cr-codex:0.170.0 .
```

源码目录下用 `node dist/cli.js`；安装这个本地包后，命令名为 `cr`。下面示例用自制含图试卷和本地答案表。模型 API Key 可通过 Studio 的 **Providers** 页面、`cr provider add` 或旧版宿主环境变量（示例默认 `OPENAI_API_KEY`）提供。按自己的 API 账号核对 [Codex 示例](examples/demo/codex.toml) 中的模型是否可用。

```sh
node dist/cli.js bench run examples/demo/contest.json --agent examples/demo/codex.toml
node dist/cli.js studio
```

打开 Studio 打印的 `http://127.0.0.1:…`：

- **运行总览**：查看批次与最近提交摘要、展开任务格、导出已完赛结果、停止单格或整批。
- **新建批次**：三步编排（选择配置目录 → 精修稀疏矩阵/任务列表 → 核对并启动锁定计划），支持每格重复运行、1–8 路受控并行和启动前 Preflight。
- **结果分析**：按 Revision 或模型主代表查看多口径排名、检查执行覆盖率，并选择同场运行进行 Ghost Racing 同步竞速回放。
- **配置库**：检索、编辑、克隆和删除 Agent / Contest，按 effort × speed tier 派生 Agent 变体矩阵；支持多 OJ 赛事预览、题号映射、附件保留和本地判题表编辑。
- **接入与通知**：安全创建、编辑、轮换和删除模型 Provider、OJ 账号及 Push Target；Cookie、API Key 和 Webhook Secret 均只写不读，并可查看脱敏投递记录。
- **Run Inspector**：通过 SSE 查看实时赛时、逐题状态和最近活动，拖动时间轴回放可信事件，或增量读取 `stdout` / `stderr`。

关闭浏览器不会停赛；退出 `cr studio` 会中断当前运行，未启动的格子可显式续跑。Studio 只监听本机，不要把它反向代理到公网。

## 定义场次和 Agent

**Contest 是题面、题目集合、判题后端和赛规的组合。** `contest.json` v2 允许完整 PDF 加只读附件；开跑前解析稳定题号、分值、时限和提交上限。CLI、Studio 创建时自动计算材料摘要；手写清单也可省略 SHA-256，计划仍会计算并锁定它。相对材料路径相对于清单。题面或赛规变化时升级 `data_version`。旧版 PDF + 答案清单仍能读取。

```sh
cr contest init examples/demo/local.json --id demo-local --title 'Demo Final' \
  --pdf problems.pdf --answers judge.json
cr contest validate examples/demo/local.json
cr agent init codex-high.yaml --id codex-high --harness codex \
  --model gpt-5.3-codex --provider openai-production --vendor openai --reasoning-effort high
cr agent validate codex-high.yaml
```

**Agent 是确定的 harness 和配置。** 新版 Agent Manifest 支持 TOML、YAML 或 JSON，引用本机 Provider（`connection` 为兼容别名）；模型 `vendor` 与 API `provider` 分离，`vendor` 为可选研究元数据，不影响运行修订。旧版 CLI 模板仍可用：一份 TOML 描述 `id`、`harness`、`api`、`model`、`base_url`、`api_key_env`，按 harness 可选 `reasoning_effort` 或 `temperature`（`model_family_id` 保留旧版读取兼容）。只有 Responses 协议已实现；不支持的配置直接报错，不静默降级。使用旧版环境变量自定义端点时，必须在宿主将 `<api_key_env>_BASE_URL` 设为同一 URL（去掉末尾 `/`），再提供对应密钥。

| Harness | 题面 | 判题 |
| --- | --- | --- |
| `codex` 0.170.0 | 完整 PDF 的全部逐页 PNG，原 PDF 与附件在只读目录 | 本地答案、Codeforces/Gym、QOJ、VJudge、Hydro |
| `builtin-responses` | 原生 PDF；不支持附件 | 本地答案 |

Codex 在每场新建的无外网容器中自己跑一个会话，可在临时工作区编译和运行程序。`cr` 生成本场原生配置，通过宿主受限中继调用模型，不挂载用户的 `auth.json`、API Key 或 OJ 凭据。比赛 MCP 提供 `submit`、`status`、`finish`。正常退出或到时可有效完赛；交卷后最多等 120 秒已受理的判定，未确认则作废，不计作 WA。Codex 上游需要支持 Responses SSE 和该 CLI 发出的工具格式。

### Codeforces

只用于有权限的历史题 Practice 提交。运行前需要准备四样东西：

1. **完整题面 PDF**：自行放置或上传到场次目录（题号与平台题号不一致时在 `contest.json` 中配置 `problem_map`）。
2. **已结束的赛事 ID**：支持普通 Round 与 Gym；用于拉取题号并校验提交归属。
3. **OJ 账号与语言映射**：在 Studio「接入与通知 → OJ 账号池」登记 write-only Cookie 或授权 submitter，Contest 只引用账号 ID / pool；`languages` 将 Agent 语言标识映射到 Codeforces `programTypeId`（例如 `{"cpp17":54}`），前端提供常见语言预设。运行期间不得在别处使用同一账号提交。
4. **题号映射**：在 Contest 向导中先拉取赛事信息，结合 PDF 识别结果核对 `problem_map`。旧版 `CR_CODEFORCES_COOKIE` / `CR_CODEFORCES_SUBMITTER` 宿主通道仍可读取，但新配置推荐使用账号池，不要把秘密写入清单。

```sh
cr contest import-codeforces cf4.json --contest 4 --pdf cf4.pdf \
  --handle YOUR_DEDICATED_HANDLE --languages '{"cpp17":54}'
```

`cr` 通过 `user.status` 按提交 ID 验证账号、比赛和题号并跟踪 verdict。提交时间以 `cr` 受理为准，不使用远端排队时间，也不复刻官方榜单公式。上传结果不明确时不会自动重交。QOJ、VJudge 与 Hydro 使用同一账号池和题号映射模型；评分、故障分类及协议细节见 [路线思考](docs/roadmap.md)。

## 批处理与结果

`Batch Spec` 支持两种格式：

- **v1（全矩阵）**：`{ "schema_version": 1, "agents": [...], "contests": [...] }`，展开完整笛卡尔积；
- **v2（稀疏矩阵）**：`{ "schema_version": 2, "cells": [{ "agent": "...", "contest": "...", "repeats": 2 }] }`，只展开显式选中的单元格（最多 1,000 格）；`repeats` 可省略（默认 1，最大 20），用于同格重复运行，展开后最多 5,000 个任务。

路径相对于 Spec 文件。`Plan` 锁定输入摘要、协议和每格镜像；选中格若不兼容会阻止计划生成。执行计划会创建一个批次，格子开跑才分配 Run ID、容器和计时器。单格失败不影响后续格；同一 Studio 进程一次执行一个批次，批次内可选择 1–8 路受控并行，同一 OJ 账号仍互斥。输入变化时重新生成计划，不能用旧计划悄悄换版本。

```sh
cr batch plan examples/demo/batch.json --out runs-plan.json
cr batch run runs-plan.json --json
# 在另一终端查询、看日志和停止：
cr batch status --json
cr run logs RUN_ID --follow
cr run logs RUN_ID --stream stderr --follow
cr run cancel RUN_ID
cr batch stop BATCH_ID
cr batch resume BATCH_ID
```

默认工作区 `runs/`，各批次和运行命令可用 `--workspace` 选同一个目录；单场快捷命令用 `--out`。`resume` 只执行未开始的格，重新运行某格需新执行计划或单场命令。取消不保证撤回已上传到 OJ 的提交。`cr --help` 列出全部命令。

```sh
cr results export --batch BATCH_ID --out results.json
cr results merge results.json other-results.json --out combined.json
cr results rank combined.json --vendor openai
```

只有有效完赛结果可以导出（当前导出为 `schema_version: 2`，兼容读取 v1）。榜单按场次修订和评测协议分组，每个 Agent 修订取最好一局，默认按分数降序、最后一次首解的时间升序。不同 harness 的题面呈现协议可能不同，不自动混榜；结果可按模型厂商（`--vendor`）或旧模型族（`--family`）过滤，未跑场次不算零分。`runs/` 中的原始事件、stdout/stderr、提交源码和本机路径是私有记录，不随结果导出。历年题可能进入训练数据；成绩不代表未见题表现。

## Studio 配置契约与 Provider 凭据库

Studio 的能力接口声明支持的 harness 版本、选项和原生格式。Agent Manifest 和 harness 原生覆盖格式彼此独立；Codex 当前只允许 TOML 覆盖 `model_verbosity`，预览与实际运行共用同一套生成逻辑。Codex 0.170.0 的 `max` 已用真实 CLI 对模拟 Responses 服务验证；上游是否接受仍取决于模型和服务。

本机 Provider 凭据库位于 `${XDG_CONFIG_HOME:-$HOME/.config}/contestreplay`。Linux 有可用的 Secret Service 时优先使用；否则秘密存于该目录下的 `credentials/`，权限为 0600，**不加密**。可用 `CR_CONNECTIONS_DIR` 指定私有目录。Studio 的 Providers 页面可创建、编辑、轮换和删除接入配置；同源 Provider API 支持录入和轮换密钥，但不会返回密钥，CLI 也可以操作同一凭据库。切换 origin 必须新建 Provider；同 origin 更改 API 路径后需重新生成受影响的运行计划。旧环境变量配置继续可用，不会自动迁移。

在 Bash 中，也可以隐藏输入并将凭据通过 stdin 传给 CLI，不把密钥写入命令参数：

```sh
read -rs api_key
printf '%s' "$api_key" | cr provider add openai-production --base-url https://api.openai.com/v1 --secret-stdin
unset api_key
```

轮换时将同样的输入交给 `cr provider rotate openai-production --secret-stdin`（旧别名 `cr connection` 继续可用）。上传的比赛材料保留在工作区的 `.materials/`，不能通过静态路由访问。完整接口见 [Studio 配置契约](docs/studio-contract-gaps.md)。

## Studio 前端开发

Studio 使用 React、Vite、Tailwind CSS、TanStack Query/Router、shadcn/ui（Radix primitives）和 Motion；生产构建由现有 Node 回环服务直接托管，不需要额外后端。视觉与动效约定见 [DESIGN.md](DESIGN.md)。先构建 runner 并在 3000 端口启动本地 API，再启动 Vite 开发服务器：

```sh
pnpm build
node dist/cli.js studio --port 3000
# 在另一终端
pnpm dev:studio
```

打开 Vite 输出的地址即可热更新界面；写请求通过同源代理发送到 Studio。使用 `STUDIO_ORIGIN` 可指定其他本地 Studio 地址。`pnpm build` 会同时完成 Node 与前端类型检查，并把页面拆包构建到 `dist/studio/`。

## 测试

```sh
pnpm test
pnpm exec playwright install chromium && pnpm test:e2e  # 浏览器 E2E 测试
pnpm test:docker  # 先构建 cr-bench 镜像
pnpm test:codex   # 先构建 cr-codex 镜像
```

Codex 集成测试运行真实 CLI，用模拟 Responses 上游验证逐页题面、MCP 提交与交卷。Codeforces 判题测试不向真实账号写入；真实付费模型和 Codeforces 写入仍需用你的账号做首次验收。

## 文档导航

- [AGENTS.md](AGENTS.md)：仓库开发约定与架构安全边界。
- [DESIGN.md](DESIGN.md)：Studio 炭黑档案视觉与动效规范。
- [docs/studio-contract-gaps.md](docs/studio-contract-gaps.md)：Studio 后端配置、Provider、目录与矩阵接口契约。
- [docs/roadmap.md](docs/roadmap.md)：后续路线思考（Agent 展示名、`fast`/`ultrafast` 口径、实时进度、CF 重构、QOJ/VJudge、大规模自动化接口）。
- 历史架构与早期提案：[Bench v1 草案](docs/bench-v1.md)、[真实 Harness 与 OJ 判题设计](docs/bench-next.md)、[统一 Web 与结果文件提案](docs/bench-web.md)、[Codex 输入示例](docs/bench-codex-example.md)、[配置界面早期草案](docs/bench-config-ui.md)。
