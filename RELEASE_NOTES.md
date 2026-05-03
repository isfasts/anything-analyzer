# Anything Analyzer v3.6.5

## 修复

- **应用闪退（原生崩溃）** — 重写标签页切换机制，使用 `setBounds` 隐藏/显示标签页替代 `removeChildView`/`addChildView`，避免 Chromium Mojo IPC 通道断裂导致的原生级崩溃（`blink.mojom.WidgetHost` 消息拒绝 → 访问地址 0xFFFFFFFFFFFFFFFF）
- **渲染进程崩溃恢复** — 新增 `render-process-gone` 和 `destroyed` 事件处理，渲染进程意外终止时自动替换为崩溃恢复页面，而非整个应用崩溃
- **全局 isDestroyed 防护** — 在 30+ 处 WebContents 操作点添加 `isDestroyed()` 检查，覆盖 CDP、IPC、MCP、Capture、Session、Replay 等全部模块，防止操作已销毁的 WebContents 引发异常
- **事件监听器溢出** — WebContents 设置 `setMaxListeners(30)` 消除 MaxListeners exceeded 警告
- **浏览器标签页安全沙盒** — 目标浏览器标签页启用 `sandbox: true`，与 Chromium 标准安全模型一致
- **会话组切换泄漏** — 切换会话组时正确分离所有标签页视图（非仅当前活跃页），避免跨分区视图残留

## 改进

- **原生崩溃报告** — 启用 Crashpad 崩溃报告，转储文件保存至 `userData/Crashpad/`，便于崩溃分析
- **Replay 引擎健壮性** — 重写 CDP 和 loadURL 调用，每次操作前检查 WebContents 状态
- **未处理 Promise 拒绝** — 主进程捕获未处理的 Promise rejection 并记录日志

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.5.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.5-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.5-x64.dmg |
| Linux | Anything-Analyzer-3.6.5.AppImage |
