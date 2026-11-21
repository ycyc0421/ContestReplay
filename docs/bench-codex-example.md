# CLI 输入示例：`problems.pdf` + Codex（历史参考）

> **文档状态**：早期输入契约草案，保留作背景参考。Codex `0.170.0` 已完成禁网 Docker、逐页 PNG 题面、宿主 Responses 中继与比赛 MCP 的实测接入；实际可运行样例见 [`examples/demo/`](../examples/demo/)，新版 Agent Manifest（TOML/YAML/JSON + Provider 引用）与命令用法见 [README](../README.md) 和 [Studio 配置契约](studio-contract-gaps.md)。

## 准备场次和 Agent

```text
example/
  contest/
    problems.pdf
    judge.json
    contest.json
  agent/
    config.toml
    agent.json
```

`contest/contest.json` 声明场次并引用题面和判题数据。只有 `problems.pdf` 时还不能跑可计分 bench：还要从可信来源准备一份覆盖全场计分题的 `judge.json`。不从模型回复猜标准答案，也不默认用零分代替缺失的判题数据。

```json
{
  "schema_version": 1,
  "contest_id": "demo-final",
  "data_version": 1,
  "title": "示例决赛",
  "source": {"name": "填写实际试卷来源"},
  "statement": {
    "path": "problems.pdf",
    "sha256": "<替换为 problems.pdf 的 SHA-256>",
    "redistribution": "unknown"
  },
  "judge": {
    "path": "judge.json",
    "sha256": "<替换为 judge.json 的 SHA-256>",
    "redistribution": "restricted"
  }
}
```

摘要占位符需替换成真实值，可用 `sha256sum example/contest/{problems.pdf,judge.json}` 计算。是否允许把题面发给模型 API 另行确认，与再分发许可无关。`judge.json` 的字段见 [Bench 数据契约](bench-v1.md#4-数据契约)，题号和分值应与试卷一致。判题文件不进容器。

`agent/agent.json` 只描述一个 Agent，不重复抄模型参数：

```json
{
  "schema_version": 1,
  "agent_id": "codex-demo",
  "harness": {"kind": "codex", "version": "0.170.0"},
  "config": "config.toml"
}
```

两个清单里的相对路径分别从各自所在目录解析。`config.toml` 用你提供的 Codex 原生配置，在其中明确指定支持的 API 模型；例如 `model = "gpt-5.3-codex"` 仅演示字段写法，不表示该模型已获准或已实测；正式评测使用协议支持的 ID，能固定快照时固定，拿不到快照时不能把别名当成固定权重。支持的行为参数（如推理档位）可以保留；中继、比赛 MCP、联网权限和审批策略由 runner 管。适配器应拒绝与比赛限制冲突或不能解释的配置，避免无声丢弃。它在全新的 `CODEX_HOME` 里生成有效配置，不修改原始文件，也不挂载个人 `~/.codex`、登录态、额外 MCP 或 hooks。API Key 只在宿主中继中可用。

候选运行命令（从 `example/` 的父目录执行）：

```sh
cr bench run example/contest/contest.json \
  --agent example/agent/agent.json \
  --out runs/
```

`--out` 可省略。每次都写新的 `runs/<run_id>/`；`agent_id` 保持不变，变更有效配置或锁定的 harness 时记录不同 `agent_revision`。配置助手只需填场次清单路径、选择 Codex、填版本和 Agent ID、引用已有 `config.toml`、选填输出目录。它生成外层清单和命令，不需要重写现成 TOML。

## Codex 接入还要验证什么

- **模型中继**：Codex 不能直接连公网。若它只接受 HTTP provider，候选方案是容器内的回环 HTTP 桥，跨边界仍走单次运行的 Unix socket；桥不持有密钥。宿主中继限制目标模型与请求能力。需用固定 Codex 版本实测 Responses 请求与流式响应能否按预期通过。提交和交卷用比赛提供的 stdio MCP 桥，不接受用户自带的服务器配置。
- **PDF 输入**：本机 `codex exec --help` 显示图片附件选项，不代表能原生附 PDF。把 PDF 文件放进容器，不等于模型已经看到图页。若原生 PDF 不通，可在协议允许的情况下按固定参数把**全页按序**渲染成图片并附加，原 PDF 仍只读交给 Agent。能否在实际输入限额内传完整场是验收项；逐页图方案单独记协议，不静默裁剪，也不与原生 PDF 结果当作同一协议。
