import { EventEmitter } from 'events'
import type { WebContents } from 'electron'
import type { InteractionEventsRepo } from '../db/repositories'
import type { InteractionEvent, RawInteractionData } from '@shared/types'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * InteractionRecorder — Records user interactions (clicks, inputs, scrolls, mouse movements)
 * from the target browser and persists them to SQLite.
 */
export class InteractionRecorder extends EventEmitter {
  private sessionId: string | null = null
  private rendererWebContents: WebContents | null = null
  private recording = false
  private scriptContent: string | null = null
  private injectedWebContents: Set<WebContents> = new Set()

  constructor(private repo: InteractionEventsRepo) {
    super()
  }

  /** Start recording interactions (injection is handled separately via injectIntoWebContents) */
  start(sessionId: string, rendererWebContents: WebContents): void {
    this.sessionId = sessionId
    this.rendererWebContents = rendererWebContents
    this.recording = true
    this.loadScript()
  }

  /**
   * Inject interaction-hook script into a WebContents (for multi-tab support).
   * Called by SessionManager when tabs are attached to the capture pipeline.
   */
  injectIntoWebContents(webContents: WebContents): void {
    this.loadScript()
    if (!this.scriptContent) return
    if (webContents.isDestroyed()) return
    webContents.executeJavaScript(this.scriptContent, true).catch(() => { /* page not ready or destroyed */ })

    this.injectedWebContents.add(webContents)
    webContents.once('destroyed', () => {
      this.injectedWebContents.delete(webContents)
    })

    // Set recording state
    if (this.recording) {
      webContents.executeJavaScript(
        `window.postMessage({type:'ar-interaction-control',recording:true},'*')`,
        true
      ).catch(() => {})
    }

    // Re-inject on navigation for this tab
    const handler = () => {
      if (!this.recording || webContents.isDestroyed()) return
      webContents.executeJavaScript(this.scriptContent!, true).catch(() => {})
      webContents.executeJavaScript(
        `window.postMessage({type:'ar-interaction-control',recording:true},'*')`,
        true
      ).catch(() => {})
    }
    webContents.on('did-navigate', handler)
    webContents.on('did-navigate-in-page', handler)
  }

  /** Pause recording (keeps session active) */
  pause(): void {
    this.recording = false
    this.setRecordingState(false)
  }

  /** Resume recording */
  resume(): void {
    this.recording = true
    this.setRecordingState(true)
  }

  /** Stop recording and clean up */
  stop(): void {
    this.recording = false
    this.sessionId = null
    this.rendererWebContents = null
    this.injectedWebContents.clear()
  }

  /** Process interaction data from page injection script */
  handleInteraction(data: RawInteractionData): void {
    if (!this.recording || !this.sessionId) return

    let sequence: number
    try {
      sequence = this.repo.getNextSequence(this.sessionId)
    } catch (err) {
      console.warn('[InteractionRecorder] getNextSequence failed:', (err as Error).message)
      return
    }

    const event: Omit<InteractionEvent, 'id'> = {
      session_id: this.sessionId,
      sequence,
      type: data.type,
      timestamp: data.timestamp,
      x: data.x ?? null,
      y: data.y ?? null,
      viewport_x: data.viewportX ?? null,
      viewport_y: data.viewportY ?? null,
      selector: data.selector ?? null,
      xpath: data.xpath ?? null,
      tag_name: data.tagName ?? null,
      element_text: data.elementText ?? null,
      attributes: data.attributes ? JSON.stringify(data.attributes) : null,
      bounding_rect: data.boundingRect ? JSON.stringify(data.boundingRect) : null,
      input_value: data.inputValue ?? null,
      key: data.key ?? null,
      scroll_x: data.scrollX ?? null,
      scroll_y: data.scrollY ?? null,
      scroll_dx: data.scrollDX ?? null,
      scroll_dy: data.scrollDY ?? null,
      url: data.url,
      page_title: data.pageTitle ?? null,
      path: data.path ? JSON.stringify(data.path) : null,
      created_at: Date.now(),
    }

    try {
      this.repo.insert(event)
    } catch (err) {
      console.warn('[InteractionRecorder] Insert failed:', (err as Error).message)
      return
    }

    // Notify renderer (lightweight event, no heavy data)
    if (this.rendererWebContents && !this.rendererWebContents.isDestroyed()) {
      this.rendererWebContents.send('interaction:recorded', {
        type: data.type,
        sequence,
        timestamp: data.timestamp,
      })
    }
    this.emit('interaction', event)
  }

  isRecording(): boolean {
    return this.recording
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private loadScript(): void {
    if (this.scriptContent) return
    try {
      const scriptPath = join(__dirname, '../preload/interaction-hook.js')
      this.scriptContent = readFileSync(scriptPath, 'utf-8')
    } catch {
      this.scriptContent = `console.log('[AnythingAnalyzer] Interaction hook script not found')`
    }
  }

  private setRecordingState(recording: boolean): void {
    for (const wc of this.injectedWebContents) {
      if (wc.isDestroyed()) continue
      wc.executeJavaScript(
        `window.postMessage({type:'ar-interaction-control',recording:${recording}},'*')`,
        true
      ).catch(() => {})
    }
  }
}
