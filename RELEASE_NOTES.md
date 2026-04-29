# Anything Analyzer v3.5.4

## 修复

- **MCP Server 模式第三方客户端连接报错** — 修复多个导致第三方 MCP 客户端（如 Claude Desktop、Cursor 等）连接失败的问题：
  - 批量 JSON-RPC 请求（数组格式）初始化时被错误拒绝
  - per-session McpServer 实例未被正确注册，导致后续工具调用无法路由
  - DELETE 请求绕过 SDK 内部状态清理，造成会话残留
  - 会话过期后返回 400 而非 404，客户端无法正确触发重新初始化

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.5.4.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.5.4-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.5.4-x64.dmg |
| Linux | Anything-Analyzer-3.5.4.AppImage |
