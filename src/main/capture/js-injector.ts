import { EventEmitter } from "events";
import type { WebContents } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * JsInjector — Manages hook script injection into a target browser WebContents.
 * Only handles script injection and re-injection on navigation.
 * IPC hook data listening is handled externally (SessionManager).
 */
export class JsInjector extends EventEmitter {
  private webContents: WebContents | null = null;
  private hookScriptContent: string | null = null;
  private navigationHandler: (() => void) | null = null;

  start(webContents: WebContents): void {
    this.webContents = webContents;
    this.loadHookScript();
    this.injectHooks();

    this.navigationHandler = () => {
      this.injectHooks();
    };
    webContents.on("did-navigate", this.navigationHandler);
    webContents.on("did-navigate-in-page", this.navigationHandler);
  }

  stop(): void {
    if (this.webContents && this.navigationHandler) {
      this.webContents.removeListener("did-navigate", this.navigationHandler);
      this.webContents.removeListener(
        "did-navigate-in-page",
        this.navigationHandler,
      );
    }
    this.webContents = null;
    this.navigationHandler = null;
  }

  private loadHookScript(): void {
    if (this.hookScriptContent) return;
    try {
      const scriptPath = join(__dirname, "../preload/hook-script.js");
      this.hookScriptContent = readFileSync(scriptPath, "utf-8");
    } catch {
      this.hookScriptContent = `console.log('[AnythingAnalyzer] Hook script not found')`;
    }
  }

  private injectHooks(): void {
    if (!this.webContents || !this.hookScriptContent) return;
    if (this.webContents.isDestroyed()) return;
    this.webContents.executeJavaScript(this.hookScriptContent, true).catch(() => {
      /* not ready or destroyed */
    });
  }
}
