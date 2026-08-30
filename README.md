# 审鉴 Review Orbit

面向 GitHub PR 与 GitLab MR 的可恢复、可审计、可控预算的代码评审 Agent。它面向中文研发团队：管理界面、模型提示词、Markdown 报告与回评内容均使用简体中文。

## 核心能力

- **可恢复**：LangGraph.js 将每个 review 的执行状态持久化到 PostgreSQL；`pg-boss` 提供可靠入队与重试。服务中断后以同一 `thread_id` 继续未完成节点。
- **预算可控**：持久化单任务预算、用量与成本。接近预算时自动切到降级模型，并按文件数与 diff 行数限制截断输入。
- **全链路可观测**：每条评论关联 trace，保存工具调用、加密原始 diff、脱敏 Prompt、模型响应、Token 用量和成本。
- **置信度分级**：确定性规则命中标记为“高置信度，可直接采纳”；模型推断统一标记为“仅供参考”。
- **安全边界**：仅接受 GitHub/GitLab HTTPS 链接；敏感信息在进入模型前脱敏；不 clone 仓库、不安装依赖、不运行脚本或测试；原始 diff 使用 AES-256-GCM 加密保存。
- **声明式工具**：工具的 ID、默认开关、语言、网络/代码执行权限与超时均在 manifest 声明。新增工具无需改变 LangGraph 主流程。
- **网络容错**：GitHub/GitLab 的读取请求在网络异常或 `429/5xx` 响应时最多自动重试 4 次，并使用递增退避；回评写入请求不自动重试，避免网络响应丢失造成重复评论。

## 技术架构

```text
GitHub PR / GitLab MR
          |
   拉取 diff 与元数据
          |
       敏感信息脱敏
          |
  声明式静态 / 沙箱工具
          |
  LLM 中文评审与预算路由
          |
  聚合、置信度判定、审计 trace
          |
Markdown 报告 或 回评到 PR / MR
```

主工作流固定为 `ingest -> redact -> tools -> model_review -> finalize`。模型没有任意网络访问、执行仓库代码或直接写入 Git 平台的能力；这些行为都由受控节点和 provider adapter 执行。

## 快速开始

要求：Node.js 22+、Docker 与 Docker Compose。

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
docker compose up --build
```

访问 `http://localhost:3000`，在“服务商与策略”中添加：

1. GitHub fine-grained token（至少具备 Pull requests 读取权限），或 GitLab `read_api` token。
2. OpenAI 或兼容 OpenAI 协议的模型服务 token。使用兼容网关时再填写 Base URL。

随后新建形如 `https://github.com/owner/repository/pull/123` 的任务。任务详情页可查看中文 Markdown 报告和每条评论的审计 trace；选择“回评到代码托管平台”会将汇总中文评审评论发回 PR/MR。

开发模式：

```bash
docker compose up db
cp .env.example .env
npm install
npm run dev
```

`.env` 中必须配置真实的 32 字节 Base64 `APP_ENCRYPTION_KEY`，用于加密审计 Trace 中的原始 Diff。密钥应保持稳定，避免历史 Trace 无法解密。

## Web 管理界面

- **概览**：活跃任务、完成量、模型消耗与最近评审。
- **评审任务**：创建、追踪、查看中文发现、下载 Markdown 报告与审计 trace。
- **代码平台连接**：单独管理 GitHub/GitLab token，仅用于获取 diff 与发布回评。
- **LLM 服务与预算**：单独管理模型 token、模型名称、输入/输出单价与单任务预算。
- **工具管理**：按工具启停，清晰展示网络、代码执行和超时权限。

## 安全说明

- 只接受 `https://github.com/.../pull/...` 与 `https://gitlab.com/.../-/merge_requests/...`。
- GitHub/GitLab Token 与 LLM API Key 以明文存储在本机 PostgreSQL 中，API 不会返回凭证明文；仅适用于可信的单机部署，数据库备份与主机访问应受控。
- 原始 diff 只会加密保存在 trace；模型与普通输出仅接收脱敏版本。
- `typecheck` 默认关闭；在接入固定版本、无网络、只读的沙箱执行器前，它不会运行任何仓库内容。
- 生产部署应在 `/api` 前配置 OIDC 或会话认证网关，并只向授权审计人员开放 trace API。

## 计费与预算

LLM 服务商配置的输入、输出单价单位均为 **CNY / 百万 Token**。每次模型调用按实际 Token 用量计算并写入 trace 与任务账本；例如输入单价为 `2.5` 时，输入 100 万 Token 记为 `￥2.50`。

单次评审预算同样以 CNY 设置：

- 预算大于 `0` 时，累计消耗超过 70% 会使用配置的降级模型。
- 预算设为 `0` 时表示**不限制预算**，不会因费用触发模型降级或停止。
- 某个方向单价设为 `0` 时，该方向不计费，适用于内部模型或未提供价格信息的服务。

## 扩展工具

在 `src/server/tools.ts` 中实现 `ReviewTool` 并声明 manifest。主工作流只通过持久化的开关配置调用 `runEnabledTools`，不包含任何工具特有分支。每个工具必须声明名称、适用语言、默认启用状态以及网络/代码执行权限。

## 验证

```bash
npm run build
npm test
```

当前测试覆盖敏感信息脱敏、Git URL 白名单、工具安全声明和确定性高置信度规则。建议 CI 增加短生命周期 PostgreSQL 与 Git/LLM HTTP mock 的集成测试。

## 许可证

[MIT](LICENSE)
