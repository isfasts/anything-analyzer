import log from "electron-log/main";
import { app } from "electron";
import { join } from "path";

/**
 * Initialize electron-log for persistent file logging.
 * Log files are stored in the app's userData/logs directory.
 *
 * Must be called after app.whenReady() since it uses app.getPath().
 */
export function initLogger(): void {
  // Store logs in userData/logs/
  const logDir = join(app.getPath("userData"), "logs");
  log.transports.file.resolvePathFn = () => join(logDir, "main.log");

  // Keep max 5MB per file, rotate up to 3 old files
  log.transports.file.maxSize = 5 * 1024 * 1024;

  // Log level: info and above go to file, all go to console in dev
  log.transports.file.level = "info";
  log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";

  // Format: [timestamp] [level] message
  log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";

  // Override console methods so existing console.log/warn/error
  // statements throughout the codebase are automatically captured.
  log.initialize();

  log.info("=== Application started ===");
  log.info(`Version: ${app.getVersion()}, Platform: ${process.platform} ${process.arch}`);
  log.info(`Electron: ${process.versions.electron}, Node: ${process.versions.node}`);
}

/**
 * Get the directory containing log files.
 */
export function getLogPath(): string {
  return join(app.getPath("userData"), "logs", "main.log");
}

export default log;
