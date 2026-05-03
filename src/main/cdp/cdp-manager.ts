import { EventEmitter } from 'events'
import type { WebContents } from 'electron'

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

// Binary content types that should not have their body stored
const BINARY_CONTENT_TYPES = [
  'image/', 'font/', 'audio/', 'video/',
  'application/octet-stream', 'application/pdf', 'application/zip'
]

interface RequestInfo {
  method: string
  url: string
  headers: Record<string, string>
  postData: string | null
  timestamp: number
  initiator: unknown
  isOptions: boolean
}

/**
 * CdpManager — Chrome DevTools Protocol manager for network interception.
 * Attaches to a WebContents debugger and intercepts all Fetch/XHR requests.
 */
export class CdpManager extends EventEmitter {
  private webContents: WebContents | null = null
  private pendingRequests = new Map<string, RequestInfo>()
  private running = false
  private messageHandler: ((event: Electron.Event, method: string, params: Record<string, unknown>) => void) | null = null
  private detachedHandler: (() => void) | null = null

  async start(webContents: WebContents): Promise<void> {
    this.webContents = webContents

    if (webContents.isDestroyed()) {
      throw new Error('Cannot start CDP on destroyed WebContents')
    }

    // Detach if already attached (e.g. leftover from a previous session)
    if (webContents.debugger.isAttached()) {
      try { webContents.debugger.detach() } catch { /* ignore */ }
    }

    try {
      webContents.debugger.attach('1.3')
    } catch (err) {
      throw new Error(`Failed to attach CDP debugger: ${(err as Error).message}`)
    }

    this.messageHandler = (_event, method, params) => {
      this.handleCdpMessage(method, params)
    }
    this.detachedHandler = () => {
      this.running = false
      this.emit('detached')
    }

    webContents.debugger.on('message', this.messageHandler)
    webContents.debugger.on('detach', this.detachedHandler)

    await Promise.all([
      this.send('Fetch.enable', {
        patterns: [
          { urlPattern: '*', requestStage: 'Request' },
          { urlPattern: '*', requestStage: 'Response' }
        ]
      }),
      this.send('Network.enable', {}),
      this.send('Page.enable', {})
    ])

    this.running = true
  }

  async stop(): Promise<void> {
    if (!this.running || !this.webContents) return
    this.running = false
    if (this.webContents.isDestroyed()) return
    try {
      await this.send('Fetch.disable', {})
    } catch { /* ignore */ }
  }

  detach(): void {
    if (!this.webContents) return
    if (!this.webContents.isDestroyed()) {
      if (this.messageHandler) {
        this.webContents.debugger.removeListener('message', this.messageHandler)
      }
      if (this.detachedHandler) {
        this.webContents.debugger.removeListener('detach', this.detachedHandler)
      }
      try { this.webContents.debugger.detach() } catch { /* already detached */ }
    }
    this.pendingRequests.clear()
    this.webContents = null
  }

  /**
   * Send a raw CDP command. Exposed for advanced use cases (e.g. stealth injection).
   */
  async sendCommand(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.webContents || this.webContents.isDestroyed()) throw new Error('No WebContents attached')
    return this.webContents.debugger.sendCommand(method, params) as Promise<Record<string, unknown>>
  }

  private async send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendCommand(method, params)
  }

  private handleCdpMessage(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Fetch.requestPaused':
        this.handleRequestPaused(params)
        break
      case 'Network.webSocketFrameSent':
        this.emit('websocket-frame', { direction: 'sent', ...params })
        break
      case 'Network.webSocketFrameReceived':
        this.emit('websocket-frame', { direction: 'received', ...params })
        break
      case 'Network.webSocketCreated':
        this.emit('websocket-created', params)
        break
      case 'Network.webSocketClosed':
        this.emit('websocket-closed', params)
        break
      case 'Page.frameNavigated':
        this.emit('frame-navigated', params)
        break
    }
  }

  private async handleRequestPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string
    const responseStatusCode = params.responseStatusCode as number | undefined

    if (responseStatusCode === undefined) {
      await this.handleRequestStage(requestId, params)
    } else {
      await this.handleResponseStage(requestId, params)
    }
  }

  private async handleRequestStage(requestId: string, params: Record<string, unknown>): Promise<void> {
    const request = params.request as Record<string, unknown>
    const method = (request.method as string) || 'GET'
    const url = (request.url as string) || ''
    const headers = (request.headers as Record<string, string>) || {}
    const postData = (request.postData as string) || null
    const isOptions = method.toUpperCase() === 'OPTIONS'

    const info: RequestInfo = {
      method, url, headers, postData,
      timestamp: Date.now(),
      initiator: params.initiator || null,
      isOptions
    }
    this.pendingRequests.set(requestId, info)

    this.emit('request-captured', {
      requestId, method, url,
      headers: JSON.stringify(headers),
      body: postData,
      timestamp: info.timestamp,
      initiator: params.initiator ? JSON.stringify(params.initiator) : null,
      isOptions
    })

    try { await this.send('Fetch.continueRequest', { requestId }) } catch { /* cancelled */ }
  }

  private async handleResponseStage(requestId: string, params: Record<string, unknown>): Promise<void> {
    const requestInfo = this.pendingRequests.get(requestId)
    const statusCode = params.responseStatusCode as number
    const responseHeaders = (params.responseHeaders as Array<{ name: string; value: string }>) || []

    const headersObj: Record<string, string> = {}
    for (const h of responseHeaders) {
      headersObj[h.name.toLowerCase()] = h.value
    }

    const contentType = headersObj['content-type'] || null
    const isBinary = contentType ? BINARY_CONTENT_TYPES.some(t => contentType.includes(t)) : false

    let responseBody: string | null = null
    let truncated = false

    if (!isBinary) {
      try {
        const bodyResult = await this.send('Fetch.getResponseBody', { requestId })
        const body = bodyResult.body as string
        const base64Encoded = bodyResult.base64Encoded as boolean
        responseBody = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body

        if (responseBody && responseBody.length > MAX_BODY_SIZE) {
          responseBody = responseBody.substring(0, MAX_BODY_SIZE) + '\n[TRUNCATED]'
          truncated = true
        }
      } catch { responseBody = null }
    }

    const durationMs = requestInfo ? Date.now() - requestInfo.timestamp : null
    const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|map)(\?|$)/i

    const isStreaming = contentType ? contentType.includes('text/event-stream') : false
    const isWebSocket = requestInfo
      ? Object.entries(requestInfo.headers).some(([key, value]) =>
          key.toLowerCase() === 'upgrade' && value.toLowerCase() === 'websocket')
      : false

    this.emit('response-captured', {
      requestId,
      method: requestInfo?.method || 'UNKNOWN',
      url: requestInfo?.url || '',
      requestHeaders: requestInfo ? JSON.stringify(requestInfo.headers) : '{}',
      requestBody: requestInfo?.postData || null,
      statusCode, responseHeaders: JSON.stringify(headersObj),
      responseBody, contentType,
      initiator: requestInfo?.initiator ? JSON.stringify(requestInfo.initiator) : null,
      durationMs,
      isOptions: requestInfo?.isOptions || false,
      isStatic: requestInfo ? STATIC_EXTENSIONS.test(requestInfo.url) : false,
      isStreaming,
      isWebSocket,
      truncated, timestamp: requestInfo?.timestamp || Date.now()
    })

    this.pendingRequests.delete(requestId)
    try { await this.send('Fetch.continueResponse', { requestId }) } catch { /* cancelled */ }
  }
}
