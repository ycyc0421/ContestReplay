# Studio 配置契约（后端交付）

本文记录 Studio 配置、Provider、目录与稀疏矩阵契约及其背景。后端路由见 [`runner/studio-config-api.ts`](../runner/studio-config-api.ts)，共享响应结构见 [`runner/studio-contract.ts`](../runner/studio-contract.ts)。旧接口继续兼容。后续产品演进（Agent `name`、`fast`/`ultrafast` 口径、实时进度、CF 重构、QOJ/VJudge 与大规模批量接口）见 [`docs/roadmap.md`](roadmap.md)。

## 当前实施状态

当前工作区已经实现并联调：capabilities、三格式 Agent Manifest、厂商元数据、Provider（兼容旧 Connection）引用、同源 write-only Provider CRUD 与凭据轮换、CLI 本机凭据库、托管 Agent 保存、配置目录、稀疏 cells 矩阵、`max` 推理档位、Harness 环境变量 allowlist、原生覆盖与 Effective Config 预览、PDF 上传、本地题目表和 judge.json 生成。前端已移除模型系列、locale 和 Manifest 格式编辑入口；新建批次采用「选择配置 → 调整矩阵 → 核对启动」三步流程，提供独立搜索与组合筛选、逐格/整行/整列选择、矩阵与任务列表视图，以及保存后加入批次。Providers 页面支持创建、编辑元数据、轮换秘密和删除，秘密只写不读。

仍待后续处理（详见 [`docs/roadmap.md`](roadmap.md)）：

- Agent 对外展示名（`name`）与推理速度档位（`fast` / `ultrafast`）建模。
- 实时运行进度接口（由 `events.jsonl` 派生题目状态与最近提交活动流）。
- Codeforces 账号凭据管理与交互式导入重构，以及 QOJ / VJudge 判题后端适配。
- Contest 托管保存，以及附件上传、材料替换/删除与孤儿上传清理的完整生命周期 UI 与 API。
- 将后端结构化 issues 精确映射到每个表单项；目前部分错误仍通过 Toast 汇总。
- 已有配置的查看/编辑/克隆工作流、legacy Manifest 显式迁移界面，以及面向 Coding Agent 的批量自动化接口。
- 真实 Codeforces 账号与赛事的端到端验收（当前只验证数据契约，不发起真实提交）。
- 新 Harness 所需的扩展字段类型与 native parser；当前允许的原生覆盖仍非常有限，这是有意的安全边界。

## 1. 当前问题：五层概念被混用

旧版 `agentSchema` 同时承载 Agent 身份、模型分类、API 连接、Harness 参数和部分原生配置；`loadAgent()` 又通过 `.json` / 非 `.json` 扩展名选择 legacy JSON 或 TOML 解析；`agentToml()` 将输出固定为 TOML。由此产生以下歧义：

| 层 | 应负责的内容 | 不应负责的内容 |
| --- | --- | --- |
| Agent Manifest | 稳定 ID、schema 版本、模型、厂商、连接引用、Harness 声明 | 上游密钥、Harness 最终生成规则 |
| Harness Options | 适配器公开的结构化参数，如推理档位 | 文件扩展名、其他 Harness 的字段 |
| Native Config Override | 用户提供的 Harness 原生配置覆盖及原生格式 | runner 安全边界、凭据、比赛 MCP |
| Effective Runtime Config | runner 合并 Manifest、Options、Override 和安全约束后的结果 | 用户直接任意改写 |
| Serialization | TOML、YAML、JSON 的解析与序列化 | 判断 Harness 或语义 schema |

**文件扩展名只能提示解析器，不能作为语义 schema。** Codex Manifest 也可以是 YAML；Codex 原生覆盖仍然是 TOML。Manifest 格式与 Native Config 格式是两个独立属性。

### 1.1 必须区分的版本和摘要

- `manifest.schema_version`：ContestReplay Agent 外层契约版本。
- `harness.kind` + `harness.version`：适配器及锁定的 Harness 版本。
- `native_config.format`：原生覆盖的语法格式。
- `native_config.schema`：原生工具自己的配置语义/版本（如果工具有）。
- `source_sha256`：用户原始 Manifest 文件字节。
- `profile_sha256`：规范化后的语义配置。
- `native_sha256`：原生覆盖原文。
- `effective_sha256`：最终有效配置。

Agent Revision 应由实际影响运行的 Harness、模型、有效配置、镜像和协议计算。厂商标签和凭据引用不参与 Revision；原生覆盖必须参与。

## 2. 建议的 Agent Manifest

以下仅表达结构，YAML/TOML/JSON 必须能够表达同一语义：

```yaml
kind: contestreplay.dev/agent
schema_version: 1
id: codex-gpt53-high
vendor: openai                 # 可选研究元数据，不参与 Revision
model: gpt-5.3-codex
provider: openai-production    # 本机 Provider 引用，不是秘密；connection 为 legacy alias
harness:
  kind: codex
  version: 0.170.0
  options:
    reasoning_effort: high
  native_config:
    format: toml
    content: |
      model_verbosity = "high"
```

约束：

- 不再设置或要求 `model_family_id` 作为默认比较维度；保留 legacy 输入的读取兼容即可。
- `vendor` 是模型制造方，不等于 API 连接提供方，也不决定协议。
- `harness.options` 只能包含该 Harness 在 capabilities 中声明的字段。
- `native_config.content` 是可选覆盖，不是完整有效配置。
- 可以同时支持外部原生文件引用；需要明确路径、摘要和文件大小上限。
- 解析 Manifest 时先识别 `kind` / `schema_version`，legacy 识别不能只看 `.json` 扩展名。
- 保存时保留用户选择的 Manifest 格式，不得一律调用 TOML stringify。

## 3. 能力发现契约

### `GET /api/capabilities`

前端已实现按此结构消费；404 时进入明确隔离的 legacy 兼容适配器。新后端实现后不应再让前端硬编码 Harness 字段。

```json
{
  "schema_version": 1,
  "features": {
    "agent_vendor": true,
    "agent_manifests": true,
    "connections": true,
    "native_overrides": true,
    "contest_authoring": true,
    "contest_upload": true,
    "judge_authoring": true
  },
  "manifest_formats": ["toml", "yaml", "json"],
  "harnesses": [
    {
      "id": "codex",
      "label": "Codex",
      "version": "0.170.0",
      "native_format": "toml",
      "supports_overrides": true,
      "fields": [
        {
          "id": "reasoning_effort",
          "label": "推理强度",
          "kind": "select",
          "required": false,
          "default": "default",
          "options": [
            { "value": "default", "label": "使用模型默认值" },
            { "value": "none", "label": "none" },
            { "value": "minimal", "label": "minimal" },
            { "value": "low", "label": "low" },
            { "value": "medium", "label": "medium" },
            { "value": "high", "label": "high" },
            { "value": "xhigh", "label": "xhigh" },
            { "value": "max", "label": "max" }
          ]
        }
      ]
    }
  ],
  "judge_backends": [
    { "kind": "local", "label": "本地精确答案", "supports_authoring": true },
    { "kind": "codeforces", "label": "Codeforces", "supports_authoring": false }
  ]
}
```

要求：

- `max` 只有在锁定的 Harness 实测支持后才加入 options；前端不自行猜测。
- fields 后续可以扩展 `text`、`number`、`boolean`、`string_list` 和非敏感 `env` 类型。
- 每个字段可以补充 `description`、`placeholder`、`min`、`max`、`group`。
- 能力描述必须由适配器生成，并与实际 Zod/JSON Schema 校验共享来源。
- 不支持的功能返回 `false`，前端不会伪造保存成功或静默丢弃字段。

## 4. Agent 校验、预览和保存

### `POST /api/agents/validate`

输入 Manifest 语义对象、Manifest 格式及可选原生覆盖。返回结构化字段错误、警告及规范化结果，不能只返回拼接后的字符串错误。

### `POST /api/agents/preview`

返回：

- 规范化 Manifest
- 最终 Effective Config 文本及格式
- 被忽略/拒绝的覆盖（拒绝优先，不静默忽略）
- 脱敏后的连接信息
- 将计入 Agent Revision 的摘要

预览不得包含真实凭据。Effective Config 至少以下字段由 runner 保留：

- Model provider 和 Relay 地址
- 比赛 MCP 和工具注入
- 网络权限、审批策略、沙盒边界
- 判题数据、事件日志和运行目录
- 凭据及凭据文件路径

### `POST /api/agents`

创建 Agent Manifest。输入包含 `document` 和可选的 `format`、`file`、`native_config`。省略后两者时，后端以默认格式保存到 `agents/<id>.toml`，Studio 主流程不要求用户选择格式或路径。返回保存路径、格式、解析后的元数据和 Revision。若本机尚无对应镜像，保存和预览仍可进行，但不会伪造 Revision：返回警告，待生成计划时锁定。

要求：

- 文件名扩展由用户选择的格式决定；YAML 同时接受 `.yaml` / `.yml`。
- 解析与序列化由格式适配器负责，不允许在 UI 或 save handler 中写死 TOML。
- 输出冲突、非法路径和不安全覆盖返回结构化错误。
- 旧 `api_key_env` / `base_url` Manifest 仍可读取；迁移必须显式，不静默改写用户文件。

## 5. Provider 与本机凭据库

旧版 `base_url`、`api_key_env` 和 `<KEY>_BASE_URL` 是 runner 环境契约，不适合作为每个 Agent 的编辑模型。Provider 表示可复用的 API 接入配置；模型 Vendor 与 API Provider 可以不同：

```yaml
id: openai-production
label: OpenAI 生产环境
protocol: responses
base_url: https://api.openai.com/v1
credential_ref: cred_01J...
approved_origin: https://api.openai.com
```

| 路由 | 请求 JSON | 成功响应 |
| --- | --- | --- |
| `GET /api/providers` | — | `200`，`{ providers: Provider[] }` |
| `POST /api/providers` | `{ id?, label, protocol, base_url, secret }` | `201`，`Provider` |
| `PATCH /api/providers/:id` | `{ label?, protocol?, base_url? }` | `200`，`Provider` |
| `POST /api/providers/:id/rotate` | `{ secret }` | `200`，`Provider` |
| `DELETE /api/providers/:id` | — | `200`，`{ deleted: true }` |

`Provider` 包含上例元数据及 `backend: 'secret-service' | 'file'`、`credential_available: boolean`。后者表示凭据可在本机读取，不表示上游已验证。当前只支持 `responses` 协议。写操作要求同源且携带 `X-CR-Studio: 1`。跨 origin 修改、引用中删除返回 `409`。同 origin 路径修改会使旧计划失效；标签和密钥轮换不会。

旧 `/api/connections` 的 GET、PATCH、DELETE 保持原响应结构。`cr provider add/rotate` 和旧 `cr connection add/rotate` 均可通过 `--secret-stdin` 管理同一凭据库。没有上游连接测试接口。

安全约束：

- 秘密只能写入，任何 GET、预览、日志和错误响应均不得回显。
- 优先 OS 凭据库；后备存储必须明确权限和位置，不能放入 `runs/` 或公开构建产物。
- Relay 在沙盒外读取秘密；沙盒内仍只看到本地 Relay。
- 凭据引用和标签不参与 Agent Revision；Base URL 和协议是否参与由有效运行语义决定。
- 自定义 origin 的授权与连接绑定，不再要求用户理解 `*_BASE_URL` 环境变量。
- Studio 可在同源的只写接口录入或轮换凭据。浏览器只能读元数据与可用状态，不能读回密钥。

## 6. Harness 原生覆盖与环境变量

- 原生覆盖采用合并 patch，并经过适配器校验；不能让用户覆盖 runner 保留字段。当前 Codex 放行 TOML 的 `model_verbosity`，外部覆盖文件须提供 `path` 和 `sha256`，相对于 Manifest 解析（上限 64 KB）。
- 最终配置由服务端生成，前端只展示只读预览。
- 当前 Codex 已在隔离容器内自动执行，不再暴露含义模糊的 YOLO 开关。
- `harness.env` 采用适配器声明的 allowlist。当前 Codex 只允许 `LANG` / `LC_ALL`，值限 `C`、`C.UTF-8` 或 `POSIX`。
- 禁止覆盖 `HOME`、`CODEX_HOME`、`PATH`、`NODE_OPTIONS`、`LD_*`、Proxy、Relay、API Key 和判题内部变量。
- 环境变量注入由 supervisor 明确执行并计入有效配置摘要，不能借原生 TOML 绕过。

## 7. Contest 上传与判题制作

### `POST /api/contests/materials`

前端以 `multipart/form-data` 上传 `file`、`contest_id`、`kind`（`entrypoint` / `attachment`）。返回 `{ path, name, size, sha256, kind }`；`path` 是保存 Contest 时使用的受管理引用，不是下载地址。

要求：

- 流式处理，不使用当前 64KB JSON body。
- PDF 上限沿用 40MB；附件单文件 16MB、合计 32MB。
- 校验 PDF header、常规文件、扩展名、重复名称和路径穿越。
- 私有材料不能通过 Studio 静态资源路径公开。
- 默认存入受管理目录；不覆盖已有文件，冲突需要显式操作。

### `POST /api/contests`

支持上传后的 Manifest 创建，包括：

- 基本信息、来源、授权、数据版本
- 主 PDF 与附件
- `rules.time_limit_ms`、`rules.max_submissions`
- Judge backend 与题目表

请求为 `{ file, document }`，输出目录须已存在且位于 Studio 启动目录内。`document.judge = { kind: "local", problems: [...] }` 时同时生成：

- `contest.json` 的 `problems` 和 `judge.kind = local`
- `judge.json` 的 `problems[].accepted_answers`

两边题号、分值和总分必须一致。当前评分语义为去除提交答案首尾空白后，与任一 accepted answer 精确匹配。

Codeforces 继续使用 `contest.json` 中的远端判题配置，**不生成 `judge.json`**。语言 ID 和专用账号必填；题号与远端不一致时提供 `problem_map`。若省略 `problems`，后端尝试从历史赛导入题号。

新判题类型必须先定义版本化评分契约；不能接受任意宿主脚本路径并直接执行。

## 8. 兼容与迁移

前端保留一个 legacy adapter，只用于当前接口：

- `/api/config/agent`
- `/api/config/contest`
- `/api/config/codeforces`

兼容层可以知道旧后端只接受 TOML 和现有 Harness 字段，但这些知识不能泄漏到通用表单组件。新后端实现 capabilities 后：

- 新功能按 feature flag 启用。
- 未启用功能显示明确说明，不静默丢弃用户输入。
- 旧 Manifest 继续可读；是否升级由用户显式确认。CLI 使用 `cr agent init --provider <id>` 创建新版 Manifest，未指定 Provider 时保留旧版 TOML 行为；`--connection` 和 `cr connection` 继续作为兼容别名。
- 新导出的结果清单使用 `schema_version: 2`，可选的 `model.vendor` 支持 `cr results rank --vendor`；合并与排名继续读取旧版 v1，`--family` 只用于旧分类。旧计划需重新生成；历史批次仍可读取。

## 9. 配置目录与稀疏矩阵

- `GET /api/catalog/agents`、`GET /api/catalog/contests` 返回可用于选择器的元数据、有效性和 Provider 就绪状态，不返回答案、秘密或私有材料内容。
- `POST /api/matrix` 对所选轴执行轻量兼容校验，不检查镜像、不调用模型上游。
- Batch Spec v2 使用 `cells: [{ agent, contest }]` 表达稀疏组合；v1 的 `agents × contests` 继续表达完整笛卡尔积。
- cells 不得重复，最多 1000 个；只校验实际选中的组合，未被选中的不兼容格不阻断计划。
- Plan 仍锁定原有完整 Job 结构，目录路径只是输入引用，不改变最终运行语义。

## 10. 后端验收清单

- 同一 Codex Agent 分别以 JSON/YAML/TOML Manifest 表达时，规范化语义与 Revision 一致。
- 扩展名与内容不符时返回明确错误，不静默换 parser。
- `max` 仅在支持它的 Harness 版本中出现且能实际运行。
- 非法原生覆盖无法改 Relay、MCP、网络、凭据和沙盒边界。
- Effective Config 不含秘密，原生覆盖改变会改变 Revision。
- 厂商和凭据引用改变不改变 Revision。
- PDF/附件上传不可穿越路径、覆盖文件或通过静态路由读取。
- 本地题目表生成的 Contest/Judge 完全一致，重复导入可预测。
- Codeforces 不生成 judge.json。
- 新旧 Manifest、CLI 和 Studio 均有契约测试。
