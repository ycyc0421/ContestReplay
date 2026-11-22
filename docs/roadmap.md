# ContestReplay 路线思考与演进规划

本文记录 ContestReplay 在完成 CLI MVP、配置契约与本机 Studio 重写后的产品路线思考、已知问题诊断与待讨论的设计口径。已实现契约见 [Studio 配置契约](studio-contract-gaps.md)，当前用法见 [README](../README.md)。

> **实施状态更新**：下文第 1、3、4、5、6、7 节的核心本机能力已落地：Agent 展示名与速度档位、SSE 实时进度、增量日志、时间轴回放、Ghost Racing、多口径排名、CF/Gym + QOJ + VJudge + Hydro、OJ 账号池、配置编辑/克隆/变体、Preflight、受控并行、SQLite 覆盖率索引、自动化 CLI 与窄权限 MCP。Studio 结果分析、配置库和 Push Target 管理也已接入。剩余讨论主要涉及公开榜单默认展示口径、真实 OJ 账号验收与更大规模的样本积累。

---

## 1. Agent 身份与展示名（`id` 与 `name` 分离）

### 背景与问题

当前 Agent Manifest 只有 `id`（受限于 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`），同时承担内部引用键、托管文件名（`agents/<id>.toml`）和界面/榜单展示名三种职责。真实跑分中，对外展示需要更自然的名称（例如 `GPT-6.2 Astra (High · Fast)`、`Claude 4.5 Sonnet / Codex`），往往包含空格、括号、中文或版本注记，不适合塞进稳定 ID 或文件名。

### 规划方案

- **`id`（`agent_id`）**：稳定机器标识，用于 Manifest 引用、文件托管路径、CLI 参数和历史序列归组。
- **`name`（可选展示名）**：面向 Studio 界面与公开榜单的可读名称；未填写时默认回退为 `id`。
- **Revision 边界**：`name` 属于展示元数据，**修改 `name` 不改变 `agent_revision`**，不使已有执行计划失效；但 `name` 会写入可导出的 `results.json`（作为快照展示名）。
- **UI 呈现**：Studio 目录、矩阵行列头、批次任务条、运行详情和后续公开榜单优先展示 `name`，次级等宽文字显示 `id` 与 `agent_revision` 前 8 位。

---

## 2. 推理速度档位（`fast` / `ultrafast`）与成绩统一口径（待定讨论）

### 背景与问题

除推理深度（`reasoning_effort`：`low` / `medium` / `high` / `xhigh` / `max`）外，不少模型服务与 Harness 还提供速度或服务档位（例如 `fast`、`ultrafast`、priority / speculative service tier）。

ContestReplay 评测的是**完整限时比赛**而非无时限单题问答。Supervisor 使用真实挂钟记录提交时间（包含模型推理等待、工具往返和本地编译运行）：

- 推理速度直接影响赛时内能解出的题数（吞吐率）；
- 推理速度直接影响每题首次 AC 时间与罚时（ICPC / CF 罚时公式）。

因此，`effort` 与 `fast` / `ultrafast` 都会实质改变比赛结果，不能视作无关标签。

### 已确认底层原则

1. **纳入有效配置与 Revision**：任何影响输出或延迟的选项（`reasoning_effort`、速度/服务档位参数等）都必须通过 Harness 能力契约显式建模，并计入 `effective_sha256` 与 `agent_revision`。
2. **结果中结构化披露**：`run.json` 与公开导出的 `results.json` 必须结构化记录 `effort`、`speed_tier`（如 `standard` / `fast` / `ultrafast`）等参数，**绝不把不同档位的成绩无标注混成同一配置**。
3. **只声明实测支持的能力**：延续 `max` 档位的约定，只有在锁定版本的 Harness 实测可用后才进入 capabilities，不静默忽略或降级。

### 待讨论：公开榜单与对比口径

如何跨不同 `effort` 与是否开启 `fast` / `ultrafast` 统一比较成绩，仍需结合首批真实赛事样本敲定。当前候选方案：

| 口径方案 | 做法 | 优点 | 权衡 |
| --- | --- | --- | --- |
| **A. 按完整配置独立上榜（默认事实层）** | 每个 `(model, harness, effort, speed_tier)` 作为独立条目，榜单用标签注明并支持筛选 | 零信息损失，完全诚实反映真实配置 | 同模型可能出现多条记录，主榜较长 |
| **B. 赛道分轨（Standard vs Fast/Unrestricted）** | 将默认标准档与 `fast` / `ultrafast` 分为不同赛道或默认过滤开关 | 避免“靠硬件加速/高价通道压过同档模型”的争议 | 需要明确界定哪些服务档位算 `standard`（不同厂商命名不统一） |
| **C. 模型主代表 + 展开变体** | 榜单默认按每个模型展示主配置或最高分配置，并标注所用 `effort` / `speed_tier`，点击可展开全部变体 | 兼顾主榜简洁与研究可追溯性 | 需要定义“主配置”规则，避免人为偏置 |
| **D. 补充拆解耗时指标（辅助研究视图）** | 主成绩仍以真实挂钟为准；同时记录模型等待耗时、工具/本地执行耗时、Token 吞吐 | 能看清提分来自更强推理还是更快出字 | 不能直接替代真实赛时（因为 Agent 会根据剩余时间动态决策） |

**建议方向**：数据层先坚持方案 A（完整记录、独立 Revision、结构化字段），榜单展示层在积累真实样本后再决定默认视图采用 B 还是 C，并用 D 作为分析辅助指标。

---

## 3. 模型工作进度的实时展示

### 背景与问题

当前 `cr studio` 的运行详情页（`/runs/$runId`）只展示原始 `stdout` / `stderr` 文本日志。比赛运行期间，操作者无法一眼看清：

- Agent 当前是否还在正常工作，还是卡在某个步骤；
- 最近提交了哪道题、用了什么语言、拿到了什么 verdict（`pending` / `AC` / `WA` / `TLE` / `CE`）；
- 当前总分、已通过题号、剩余赛时与剩余提交次数。

### 规划方案

后端已有 supervisor 实时追加的可信事件日志 `runs/<run_id>/events.jsonl` 与运行元数据 `run.json`。规划在不暴露标准答案与秘密的前提下增加结构化实时进度视图：

1. **后端接口**：新增 `GET /api/runs/:runId/progress`（或 SSE `/api/runs/:runId/events`），实时汇总并脱敏：
   - 赛时进度：`started_at`、`elapsed_ms`、`time_limit_ms`、剩余时间；
   - 预算进度：`submissions_used / max_submissions`、模型调用轮次/最近活跃时间；
   - 逐题状态表：每题的尝试次数、当前状态（未交 / `pending` / `wrong_answer` / `accepted`）、首次 AC 时间与得分；
   - 最近活动流：按时间倒序展示最近 N 条关键事件（例如 `04:12 · 提交 B (cpp17) → pending`、`04:19 · B 判定 WA`、`08:35 · 提交 A → AC (+1)`、`finish`）。
2. **前端展示**：
   - **运行总览**：当前运行中的任务行直接显示紧凑摘要（如 `2/5 题通过 · 最近提交 C (WA) · 剩余 42m`）；
   - **Run Inspector**：在炭黑日志终端上方增加实时进度带、逐题状态格子与最近提交时间线，日志区保留为下层详细诊断。

---

## 4. Codeforces 当前配置问题诊断与重构

### 现状问题

当前 Codeforces 配置入口（`studio/src/features/configs/contest-form.tsx`、`runner/codeforces.ts`、`runner/cf-web.ts`）对使用者不直观，主要存在四个断层：

1. **字段晦涩、缺少上下文**：表单直接要求输入 `Codeforces 赛事 ID`、`专用账号名` 和裸 JSON 格式的 `语言映射 JSON`（默认 `{"cpp17":54}`）。用户无从得知 `54` 是 Codeforces 内部的 `programTypeId`，不知道 key 给谁使用，也不知道常见语言对应的 ID，更不清楚为何必须使用“专用账号”。
2. **提交通道与凭据完全隐藏在环境变量里**：实际运行还需要宿主设置 `CR_CODEFORCES_COOKIE` 或外部程序 `CR_CODEFORCES_SUBMITTER`，但 Studio 既没有录入入口、也没有就绪状态提示，导致保存 Contest 时看似成功，直到开跑预检才失败。
3. **题面 PDF 与题号映射断层**：向导第一步就要求上传完整 PDF，却未说明 PDF 准备方式；表单也没有 `problem_map` 入口，一旦 PDF 题号与 CF 题号（如 `1/2/3` vs `A/B/C`）不一致，无法在前端修正。
4. **导入反馈过晚且保存路径未托管**：表单在最后点击保存时才在线请求 `codeforces.com/api/contest.standings` 拉取题号，无法在配置过程中先预览赛名和题目列表；同时 Contest 仍要求手填保存路径（默认 `contest.json`），创建多场容易冲突。

### 重构计划

1. **独立的 OJ 账号 / 提交通道注册表（复用 Provider 安全模式）**：
   - 新增与 Provider 类似的本机 OJ 账号管理（如 `/oj-accounts` 或归入配置凭据页），通过同源 write-only 接口录入/轮换会话 Cookie 或登记经授权的 submitter 路径，只回显 handle、平台、通道类型和本机就绪状态；
   - `contest.json` 只引用账号 ID（或声明默认通道），不再把账号细节和隐藏环境变量混在每个场次表单里。
2. **交互式 CF 导入步骤**：
   - 输入 Contest ID 后提供「拉取赛事信息」按钮，即时预览赛名、`FINISHED` 状态、题号列表与分值；
   - 用可视化语言多选预设替代手写 JSON（例如内置 C++20 / C++17 / Python 3 / PyPy 3 / Rust 常见 `programTypeId`），高级用户才展开自定义 JSON；
   - 提供 `problem_map` 对照编辑表（PDF 题号 ↔ 平台题号）。
3. **Contest 托管保存**：与 Agent 一致，默认托管保存到 `contests/<id>.json`，消除路径填写和默认文件名冲突。

---

## 5. 多 OJ 判题平台：Codeforces、QOJ 与 VJudge

### 平台定位

算法竞赛评测中最常用的两个原生题库是 **Codeforces** 与 **QOJ**；同时大量区域赛、校赛与多平台历史题分散在 AtCoder、UOJ、SPOJ、Codeforces Gym 等不同 OJ 上，逐个维护原生适配器的边际成本很高。**VJudge** 可以作为多平台聚合层显著降低适配成本。

### 抽象与接入路线

当前 `runner/codeforces.ts` 已经沉淀出最小 `ProgramJudge` 接口（`submit` 返回远端提交 ID，`verdicts` 按 ID 轮询并核对身份与终态）。后续将其升级为通用的可登记 OJ 适配器层：

1. **第一步：修复并固化 Codeforces 适配器与账号模型**
   - 完成第 4 节的配置重构、账号凭据隔离与真实账号首次端到端验收。
2. **第二步：原生接入 QOJ（高优先级）**
   - QOJ 汇聚了大量 ICPC / CCPC / 区域赛和训练赛，且自带高质量完整题面 PDF，非常契合 ContestReplay 的“整场完整 PDF 赛制”。
   - 需明确契约：QOJ 场次/题号结构、语言映射表、专用账号会话/submitter 通道、提交 ID 精确关联（不盲目重试不确定写入）以及 verdict 归一化（`AC` / `WA` / `TLE` / `MLE` / `RE` / `CE` / `Pending`）。
3. **第三步：评估并接入 VJudge（多平台聚合层）**
   - **收益**：一套提交/状态适配即可覆盖众多上游 OJ，也天然支持按 VJudge Contest 组织混合题单。
   - **必须明确处理的工程边界**：
     - **延迟与结算窗口**：VJudge 转发到目标 OJ 会带来额外排队与回写延迟；提交时间仍严格以 `cr` supervisor 受理时间为准，交卷后等待最终 verdict 的超时窗口需支持按判题后端配置。
     - **故障归类**：VJudge 同步失败、上游 OJ 不可用、会话过期或验证码拦截必须标记为基础设施故障（`void`），不能误判为 `WA`。
     - **身份与授权边界**：仅在遵守平台规则与授权前提下使用专用账号，不把 Cookie/密码写入配置、事件或结果；公开结果如实记录 `judge.kind = "vjudge"` 及上游源信息，保持可审计性。

---

## 6. 前端配置易用性改进

除上述 CF 向导与实时进度外，Studio 配置体验仍需补齐以下高频工作流：

- **已有配置的查看、编辑、克隆与删除**：从目录直接打开已有 Agent / Contest 查看或编辑；支持“克隆并派生变体”（例如从一个基础模型快速派生 `low` / `medium` / `high` / `fast` 多个 Agent）。
- **Contest 托管保存与完整材料生命周期**：Contest 默认托管保存到 `contests/<id>.json`；补齐附件上传、替换、删除以及未引用孤儿材料的清理机制。
- **表单级结构化错误映射**：将后端返回的 `issues[].path` 精确绑定到对应字段下方，而不是仅靠顶部 Toast 汇总。
- **常用预设与引导**：提供常见 Provider 模板（OpenAI、OpenRouter、本机兼容网关等）、OJ 语言预设，以及旧版 legacy Manifest 的显式一键迁移预览。
- **目录与矩阵扩展能力**：支持在目录中展开查看无效配置的具体原因并跳转修复；大规模场次下支持按标签/来源/年份/未跑状态过滤。

---

## 7. 大规模自动化与面向 Coding Agent 的编程接口

### 背景

当评测规模扩展到几十上百个 Agent 变体（多模型 × 多 `effort` × `standard`/`fast`/`ultrafast` × 多 Harness）和数百乃至数千场历史赛（例如全量 Codeforces Rounds + QOJ 区域赛）时，手工在表单里逐个点选既低效又容易出错。这类批量整理、核对、导入与配置生成非常适合交给 **Coding Agent 或自动化脚本** 完成，前提是系统提供清晰、确定、安全的编程接口。

### 接口与底层规划

1. **稳定、非交互、机器可读的 CLI 契约**
   - 所有命令统一支持 `--json` 结构化输出、确定性退出码与结构化错误类型（区分校验失败、冲突、缺失凭据、上游不可达），绝不在自动化路径中阻塞等待交互输入。
   - 提供批量操作与幂等入口（例如 `cr agent batch-apply`、`cr contest batch-import`、`--dry-run`、`--if-exists skip|error|bump-version`），先全量校验再落盘。
   - 提供机器可读的 Schema 导出（例如 `cr schema export` 或 JSON Schema / 扩展版 `/api/capabilities`），让 Coding Agent 直接依据 schema 校验字段、枚举与版本约束，而不靠猜测文档。
2. **完整的本机配置管理 API 与安全隔离**
   - 补齐 Agent / Contest 的查询详情、更新、克隆、删除、批量校验和批量导入接口。
   - **严格密钥边界**：自动化脚本和 Coding Agent **永远只引用已登记的 Provider ID / OJ Account ID**，不得通过批量脚本、Manifest 或上下文接触真实 API Key 或 OJ Cookie。
3. **大规模目录与队列底层演进（SQLite 索引层）**
   - 当前目录靠递归扫描工作区文件、批次查询靠遍历 `.batches/` JSON、单份执行计划受限于每轴 100 项与总计 1,000 格。
   - 面向数千场规模时，引入本机 **SQLite 索引层**：
     - 索引赛事目录、来源映射、修订版本与去重；
     - 索引批次、任务状态与运行摘要，支持高效查询「某 Agent 尚未跑过哪些赛事」的差集并自动生成补跑批次；
     - 突破单计划 1,000 格限制或支持分片批次调度；
   - 原始 `run.json`、`events.jsonl` 与可分享的 `results.json` 仍保留透明的文件系统契约，不绑定数据库方可验证或导出。

---

## 8. 建议优先级

| 阶段 | 重点 | 产出 |
| --- | --- | --- |
| **近期（体验与可观测性）** | 1) Agent `name` 字段<br>2) 运行实时进度接口与 UI<br>3) Codeforces 配置与账号管理重构<br>4) 已有配置编辑/克隆与 Contest 托管保存 | 日常跑分不再需要看裸日志或手写 CF JSON |
| **中期（多平台与口径）** | 1) `fast` / `ultrafast` 能力建模与榜单口径敲定<br>2) 通用 `ProgramJudge` 抽象 + QOJ 适配<br>3) VJudge 多平台聚合适配 | 覆盖 CF + QOJ + 主流长尾 OJ，统一计时与披露口径 |
| **规模化（自动化与公开展示）** | 1) 面向 Coding Agent 的批量 CLI/API 与 Schema 导出<br>2) SQLite 目录/覆盖率索引与大规模批次调度<br>3) 静态公开榜单（`results.json` 展示与导入） | 支持百级 Agent、千级 Contest 的自动化维护与公开发布 |
