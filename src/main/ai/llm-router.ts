import type { LLMProviderConfig } from '@shared/types'

interface LLMResponse {
  content: string
  promptTokens: number
  completionTokens: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const DEFAULT_TIMEOUT = 120000 // 2 minutes for initial connection + first response

/**
 * LLMRouter — Unified interface for calling different LLM providers.
 * Supports OpenAI, Anthropic, and OpenAI-compatible APIs.
 */
export class LLMRouter {
  constructor(private config: LLMProviderConfig) {}

  async complete(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<LLMResponse> {
    if (this.config.name === 'anthropic') {
      return this.completeAnthropic(messages, onChunk)
    }
    if (this.config.apiType === 'responses') {
      return this.completeResponses(messages, onChunk)
    }
    return this.completeOpenAI(messages, onChunk)
  }

  private async completeOpenAI(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const stream = !!onChunk
    const body = { model: this.config.model, messages, max_tokens: this.config.maxTokens, stream }

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body)
    })

    if (stream) return this.parseOpenAIStream(response, onChunk!)

    const data = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }
    return { content: data.choices[0]?.message?.content || '', promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0 }
  }

  private async completeResponses(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/responses`
    const stream = !!onChunk
    const systemMsg = messages.find(m => m.role === 'system')
    const inputMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
    const body: Record<string, unknown> = { model: this.config.model, input: inputMessages, max_output_tokens: this.config.maxTokens, stream }
    if (systemMsg) body.instructions = systemMsg.content

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body)
    })

    if (stream) return this.parseResponsesStream(response, onChunk!)

    const data = await response.json() as { output_text?: string; usage?: { input_tokens: number; output_tokens: number } }
    return { content: data.output_text || '', promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 }
  }

  private async completeAnthropic(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<LLMResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/messages`
    const stream = !!onChunk
    const systemMsg = messages.find(m => m.role === 'system')
    const userMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
    const body: Record<string, unknown> = { model: this.config.model, max_tokens: this.config.maxTokens, messages: userMessages, stream }
    if (systemMsg) body.system = systemMsg.content

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    })

    if (stream) return this.parseAnthropicStream(response, onChunk!)

    const data = await response.json() as { content: Array<{ type: string; text: string }>; usage?: { input_tokens: number; output_tokens: number } }
    const content = data.content.filter(c => c.type === 'text').map(c => c.text).join('')
    return { content, promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 }
  }

  private async parseOpenAIStream(response: Response, onChunk: (chunk: string) => void): Promise<LLMResponse> {
    let fullContent = '', promptTokens = 0, completionTokens = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as any
          const chunk = parsed.choices?.[0]?.delta?.content || ''
          if (chunk) { fullContent += chunk; onChunk(chunk) }
          if (parsed.usage) { promptTokens = parsed.usage.prompt_tokens; completionTokens = parsed.usage.completion_tokens }
        } catch { /* skip */ }
      }
    }
    return { content: fullContent, promptTokens, completionTokens }
  }

  private async parseResponsesStream(response: Response, onChunk: (chunk: string) => void): Promise<LLMResponse> {
    let fullContent = '', promptTokens = 0, completionTokens = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) { currentEvent = ''; continue }
        if (trimmed.startsWith('event: ')) { currentEvent = trimmed.slice(7); continue }
        if (!trimmed.startsWith('data: ')) continue
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as any
          if (currentEvent === 'response.output_text.delta' && parsed.delta) {
            fullContent += parsed.delta
            onChunk(parsed.delta)
          }
          if (currentEvent === 'response.completed' && parsed.response?.usage) {
            promptTokens = parsed.response.usage.input_tokens || 0
            completionTokens = parsed.response.usage.output_tokens || 0
          }
        } catch { /* skip malformed JSON */ }
      }
    }
    return { content: fullContent, promptTokens, completionTokens }
  }

  private async parseAnthropicStream(response: Response, onChunk: (chunk: string) => void): Promise<LLMResponse> {
    let fullContent = '', promptTokens = 0, completionTokens = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as any
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) { fullContent += parsed.delta.text; onChunk(parsed.delta.text) }
          if (parsed.type === 'message_start' && parsed.message?.usage) promptTokens = parsed.message.usage.input_tokens
          if (parsed.type === 'message_delta' && parsed.usage) completionTokens = parsed.usage.output_tokens || 0
        } catch { /* skip */ }
      }
    }
    return { content: fullContent, promptTokens, completionTokens }
  }

  private async fetchWithRetry(url: string, options: RequestInit, retries = 1): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      // Clear timeout once we get the response headers — streaming can take much longer
      clearTimeout(timeout)
      if (response.status === 429 && retries > 0) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10)
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        return this.fetchWithRetry(url, options, retries - 1)
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(`LLM API error ${response.status}: ${errorBody}`)
      }
      return response
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  }
}
