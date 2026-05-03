import { EventEmitter } from 'events'
import type { WebContents } from 'electron'

const COLLECTION_INTERVAL = 5000 // 5 seconds

/**
 * StorageCollector — Periodically collects Cookie, localStorage, and sessionStorage
 * snapshots from the target browser via CDP commands.
 */
export class StorageCollector extends EventEmitter {
  private webContents: WebContents | null = null
  private sessionId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private collecting = false

  start(sessionId: string, webContents: WebContents): void {
    this.sessionId = sessionId
    this.webContents = webContents
    this.collectAll()
    this.timer = setInterval(() => { this.collectAll() }, COLLECTION_INTERVAL)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.webContents && !this.webContents.isDestroyed()) this.collectAll()
    this.webContents = null
    this.sessionId = null
  }

  triggerCollection(): void { this.collectAll() }

  private async collectAll(): Promise<void> {
    if (this.collecting || !this.webContents || !this.sessionId) return
    if (this.webContents.isDestroyed()) return
    this.collecting = true
    const domain = this.getCurrentDomain()
    const timestamp = Date.now()
    try {
      await Promise.allSettled([
        this.collectCookies(domain, timestamp),
        this.collectLocalStorage(domain, timestamp),
        this.collectSessionStorage(domain, timestamp)
      ])
    } finally { this.collecting = false }
  }

  private async collectCookies(domain: string, timestamp: number): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) return
    try {
      const currentUrl = this.webContents.getURL()
      const result = await this.webContents.debugger.sendCommand('Network.getCookies', { urls: [currentUrl] }) as { cookies: Array<Record<string, unknown>> }
      this.emit('storage-collected', { domain, storageType: 'cookie', data: JSON.stringify(result.cookies || []), timestamp })
    } catch (err) { console.warn('[StorageCollector] collectCookies failed:', (err as Error).message) }
  }

  private async collectLocalStorage(domain: string, timestamp: number): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) return
    try {
      const result = await this.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'JSON.stringify(localStorage)', returnByValue: true }) as { result: { value?: string } }
      this.emit('storage-collected', { domain, storageType: 'localStorage', data: result.result?.value || '{}', timestamp })
    } catch (err) { console.warn('[StorageCollector] collectLocalStorage failed:', (err as Error).message) }
  }

  private async collectSessionStorage(domain: string, timestamp: number): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) return
    try {
      const result = await this.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'JSON.stringify(sessionStorage)', returnByValue: true }) as { result: { value?: string } }
      this.emit('storage-collected', { domain, storageType: 'sessionStorage', data: result.result?.value || '{}', timestamp })
    } catch (err) { console.warn('[StorageCollector] collectSessionStorage failed:', (err as Error).message) }
  }

  private getCurrentDomain(): string {
    if (!this.webContents || this.webContents.isDestroyed()) return 'unknown'
    try { return new URL(this.webContents.getURL()).hostname } catch { return 'unknown' }
  }
}
