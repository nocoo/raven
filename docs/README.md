# raven — docs

| # | Document | Description |
|---|----------|-------------|
| 02 | [Key Management](./02-key-management.md) | 多 Key 管理系统：数据库 + Dashboard UI + Proxy 验证 |
| 03 | [Unified Logging](./03-unified-logging.md) | 统一日志系统：LogEmitter 事件总线 + 三路 fan-out |
| 04 | [Proxy Rewrite](./04-proxy-rewrite.md) | Proxy 重写：基于 copilot-api 的整体替换方案 |
| 05 | [Test Coverage](./05-test-coverage.md) | 测试覆盖率提升：Hot Path → 全量 95%+ |
| 06 | [Dashboard Test Plan](./06-dashboard-test-plan.md) | Dashboard 测试计划 |
| 07 | [Session Tracking](./07-session-tracking.md) | Session 识别 + 并行会话统计 UI |
| 08 | [Local Auth Mode](./08-dev-auth-mode.md) | Dashboard local 模式：无 Google OAuth 时跳过认证 |
| 09 | [Unified Auth](./09-unified-auth.md) | 统一认证架构：分离 AI API 认证与 Dashboard 管理认证 |
| 10 | [Request Optimizations](./10-request-optimizations.md) | 可配置的请求优化项：协议兼容性修复，Settings 页面逐一开关 |
| 11 | [Custom Upstream Routing](./11-custom-upstream-routing.md) | AI Providers：多 provider 模型路由 + Copilot 查重 + Dashboard 管理 |
| 12 | [Quality System Upgrade](./12-quality-system-upgrade.md) | 质量体系升级：A- → S 级，D1 隔离 + 文档同步 |

## Archive

| # | Document | Description |
|---|----------|-------------|
| 01 | [MVP](./archive/01-mvp.md) | 初始 MVP 设计文档（已被 04-proxy-rewrite 取代） |
