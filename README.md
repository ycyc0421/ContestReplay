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

源码目录下用 `node dist/cli.js`；安装这个本地包后，命令名为 `cr`。下面示例用自制含图试卷和本地答案表。模型 API Key 由宿主环境提供，示例默认使用 `OPENAI_API_KEY`。按自己的 API 账号核对 [Codex 示例](examples/demo/codex.toml) 中的模型是否可用。

```sh
node dist/cli.js bench run examples/demo/contest.json --agent examples/demo/codex.toml
node dist/cli.js studio
```

打开 Studio 打印的 `http://127.0.0.1:…`：新建或填写已有的 Contest、Agent 配置，生成矩阵计划，启动后监看 stdout/stderr，必要时停止当前格或整批，最后导出已完赛结果。关闭浏览器不会停赛；退出 `cr studio` 会中断当前运行，未启动的格子可显式续跑。Studio 只监听本机，不要把它反向代理到公网。

## 定义场次和 Agent

**Contest 是题面、题目集合、判题后端和赛规的组合。** `contest.json` v2 允许完整 PDF 加只读附件；开跑前解析稳定题号、分值、时限和提交上限。CLI、Studio 创建时自动计算材料摘要；手写清单也可省略 SHA-256，计划仍会计算并锁定它。相对材料路径相对于清单。题面或赛规变化时升级 `data_version`。旧版 PDF + 答案清单仍能读取。

```sh
cr contest init examples/demo/local.json --id demo-local --title 'Demo Final' \
  --pdf problems.pdf --answers judge.json
cr contest validate examples/demo/local.json
cr agent init codex-high.toml --id codex-high --harness codex \
  --model gpt-5.3-codex --reasoning-effort high --family gpt-5-codex
cr agent validate codex-high.toml
```

**Agent 是确定的 harness 和配置。** 一份 TOML 描述 `id`、`harness`、`api`、`model`、`base_url`、`api_key_env`，按 harness 可选 `reasoning_effort` 或 `temperature`。`model_family_id` 是显式研究标签，不参与计分，也不改变 Agent 修订。只有 Responses 协议已实现；不支持的配置报错，不静默从一个 harness 或推理档切到另一个。自定义端点必须在宿主将 `<api_key_env>_BASE_URL` 设为同一 URL（去掉末尾 `/`），再提供对应密钥。

| Harness | 题面 | 判题 |
| --- | --- | --- |
| `codex` 0.170.0 | 完整 PDF 的全部逐页 PNG，原 PDF 与附件在只读目录 | 本地答案、Codeforces |
| `builtin-responses` | 原生 PDF；不支持附件 | 本地答案 |

Codex 在每场新建的无外网容器中自己跑一个会话，可在临时工作区编译和运行程序。`cr` 生成本场原生配置，通过宿主受限中继调用模型，不挂载用户的 `auth.json`、API Key 或 OJ 凭据。比赛 MCP 提供 `submit`、`status`、`finish`。正常退出或到时可有效完赛；交卷后最多等 120 秒已受理的判定，未确认则作废，不计作 WA。Codex 上游需要支持 Responses SSE 和该 CLI 发出的工具格式。

### Codeforces

只用于有权限的历史题 Practice 提交。先放好题面 PDF，再导入赛事和题号（程序题默认每题一分）：

```sh
cr contest import-codeforces cf4.json --contest 4 --pdf cf4.pdf \
  --handle YOUR_DEDICATED_HANDLE --languages '{"cpp17":54}'
```

请按目标赛事实际语言 ID 修改例子。在宿主用专用账号，运行期间不要在别处用同一账号提交。可配置 `CR_CODEFORCES_COOKIE` 使用网页提交，或设置 `CR_CODEFORCES_SUBMITTER` 为获准使用的提交程序绝对路径。后者接收 `contest_id problem_index language_id source_file handle` 五个参数，stdout 只返回 `{"submission_id":123}`；不要将会话或适配器凭据写入配置。`cr` 通过 `user.status` 按提交 ID 验证账号、比赛和题号、跟踪 verdict。提交时间以 `cr` 受理为准，不使用远端排队时间，也不复刻官方榜单公式。上传结果不明确时不会自动重交。

## 批处理与结果

`Batch Spec` 包含 `agents` 和 `contests` 两个列表，路径相对于该文件。`Plan` 展开笛卡尔积，锁定输入摘要、协议和每格镜像；不兼容格会阻止计划生成。执行计划会创建一个批次，格子开跑才分配 Run ID、容器和计时器。单格失败不影响后续格；同工作区一次只运行一格。输入变化时重新生成计划，不能用旧计划悄悄换版本。

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
cr results rank combined.json --family gpt-5-codex
```

只有有效完赛结果可以导出。榜单按场次修订和评测协议分组，每个 Agent 修订取最好一局，默认按分数降序、最后一次首解的时间升序。不同 harness 的题面呈现协议可能不同，不自动混榜；模型族可过滤，未跑场次不算零分。`runs/` 中的原始事件、stdout/stderr、提交源码和本机路径是私有记录，不随结果导出。历年题可能进入训练数据；成绩不代表未见题表现。

## 测试

```sh
pnpm test
pnpm test:docker  # 先构建 cr-bench 镜像
pnpm test:codex   # 先构建 cr-codex 镜像
```

Codex 集成测试运行真实 CLI，用模拟 Responses 上游验证逐页题面、MCP 提交与交卷。Codeforces 判题测试不向真实账号写入；真实付费模型和 Codeforces 写入仍需用你的账号做首次验收。
