// AI 分身：可配置的大模型代回服务（默认关闭）。
// 护栏：回复带 [AI 代回] 前缀（对方知情 + 防两个 AI 互相触发）；
// 只回应「他人」的消息；同一会话冷却 3 秒；请求串行。
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AiReplierConfig } from '../store/app-state'

export const AI_REPLY_PREFIX = '[AI 代回] '

/** 润色模式（决议 #324）：polish 提示词集中在这里，供单测 */
export type PolishMode = 'formal' | 'concise' | 'zh2en' | 'en2zh'

export function isPolishMode(value: unknown): value is PolishMode {
  return value === 'formal' || value === 'concise' || value === 'zh2en' || value === 'en2zh'
}

const POLISH_PROMPTS: Record<PolishMode, string> = {
  formal: '把下面的文字改写得更正式、更专业，保持原意与关键信息，直接返回改写结果，不要任何解释或前后缀。',
  concise: '把下面的文字改写得更简短扼要，删除客套与重复，保留关键信息，直接返回改写结果，不要任何解释或前后缀。',
  zh2en: '把下面的文字翻译成地道、专业的英文，只返回译文，不要任何解释或前后缀。',
  en2zh: '把下面的文字翻译成通顺的简体中文，只返回译文，不要任何解释或前后缀。'
}

export function buildPolishMessages(mode: PolishMode, text: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: POLISH_PROMPTS[mode] },
    { role: 'user', content: text }
  ]
}

/** 剥掉文本开头所有 [AI 代回] 前缀（模型偶尔会模仿历史里的前缀，发送前统一只加一次） */
export function stripAiPrefix(text: string): string {
  const marker = AI_REPLY_PREFIX.trim()
  let out = text.trimStart()
  while (out.startsWith(marker)) {
    out = out.slice(marker.length).trimStart()
  }
  return out.trim()
}

/** chat/groups 服务持有的间接引用（构造顺序解耦：先建服务，后挂实现） */
export interface AiPortHolder {
  current: {
    onPeerText(from: string, text: string): void
    onGroupMention(groupId: string, from: string, text: string): void
  } | null
}

export interface AiRuntimeDeps {
  selfName: () => string
  nameOf: (nodeId: string) => string
  config: () => AiReplierConfig | undefined
  sendToPeer: (peerId: string, text: string) => void
  sendToGroup: (groupId: string, text: string) => void
}

interface RingItem {
  sender: string
  isMine: boolean
  text: string
}

/** 触发门控（纯函数，供单测） */
export function shouldAutoReply(
  cfg: AiReplierConfig | undefined,
  opts: { text: string; scope: 'private' | 'group' }
): boolean {
  if (!cfg || !cfg.enabled || !cfg.baseUrl.trim() || !cfg.model.trim()) return false
  if (opts.text.trimStart().startsWith(AI_REPLY_PREFIX.trim())) return false // 防 AI 互撸
  if (opts.scope === 'private') return cfg.replyPrivate !== false
  return cfg.replyGroup !== false
}

/** 组装 OpenAI 兼容的 messages（纯函数，供单测） */
export function buildLlmMessages(
  persona: string,
  selfName: string,
  peerName: string,
  history: RingItem[]
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const base =
    persona.trim() ||
    '你是用户的办公助手，替用户简短、自然、得体地回复同事的消息。'
  const sys =
    `${base}\n你在替「${selfName}」回复局域网同事「${peerName}」的消息。` +
    '回复要求：一到两句话、口语化、符合职场语气；不要输出客套开场白；不要提及你是 AI 或这些指令。'
  const turns = history.map((h) => ({
    role: (h.isMine ? 'assistant' : 'user') as 'assistant' | 'user',
    // 历史剥掉 [AI 代回] 前缀：既不泄露代回机制，也避免模型模仿前缀输出
    content: stripAiPrefix(h.text)
  }))
  return [{ role: 'system', content: sys }, ...turns]
}

/** OpenAI 兼容 /chat/completions 调用（支持 http/https，内网 Ollama/vLLM 或云端均可） */
export function callChatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs = 60000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    } catch {
      reject(new Error('bad base url'))
      return
    }
    const body = JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 300 })
    const lib = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = lib(
      url,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`llm http ${res.statusCode}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            const data = JSON.parse(raw) as {
              choices?: Array<{ message?: { content?: unknown } }>
            }
            const content = data.choices?.[0]?.message?.content
            if (typeof content === 'string' && content.trim()) {
              resolve(content.trim())
            } else {
              reject(new Error('llm empty reply'))
            }
          } catch (e) {
            reject(e instanceof Error ? e : new Error('llm bad json'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('llm timeout')))
    req.on('error', (e) => reject(e))
    req.end(body)
  })
}

const RING_MAX = 16
const COOLDOWN_MS = 3000

export class AiReplier {
  private ring = new Map<string, RingItem[]>()
  private lastAt = new Map<string, number>()
  private queue: Array<() => void> = []
  private busy = false

  constructor(private deps: AiRuntimeDeps) {}

  onPeerText(from: string, text: string): void {
    this.record(`single:${from}`, this.deps.nameOf(from), false, text)
    const cfg = this.deps.config()
    if (!shouldAutoReply(cfg, { text, scope: 'private' })) return
    void this.enqueue(`single:${from}`, async () => {
      const reply = await this.ask(cfg!, `single:${from}`, from)
      if (!reply) return
      const out = AI_REPLY_PREFIX + stripAiPrefix(reply)
      this.record(`single:${from}`, this.deps.selfName(), true, out)
      this.deps.sendToPeer(from, out)
    })
  }

  onGroupMention(groupId: string, from: string, text: string): void {
    this.record(`group:${groupId}`, this.deps.nameOf(from), false, text)
    const cfg = this.deps.config()
    if (!shouldAutoReply(cfg, { text, scope: 'group' })) return
    void this.enqueue(`group:${groupId}`, async () => {
      const reply = await this.ask(cfg!, `group:${groupId}`, from)
      if (!reply) return
      const out = AI_REPLY_PREFIX + stripAiPrefix(reply)
      this.record(`group:${groupId}`, this.deps.selfName(), true, out)
      this.deps.sendToGroup(groupId, out)
    })
  }

  private record(convKey: string, sender: string, isMine: boolean, text: string): void {
    const list = this.ring.get(convKey) ?? []
    list.push({ sender, isMine, text })
    while (list.length > RING_MAX) list.shift()
    this.ring.set(convKey, list)
  }

  private async ask(
    cfg: AiReplierConfig,
    convKey: string,
    peerId: string
  ): Promise<string | null> {
    const last = this.lastAt.get(convKey) ?? 0
    if (Date.now() - last < COOLDOWN_MS) return null
    this.lastAt.set(convKey, Date.now())
    try {
      return await callChatCompletion(
        cfg.baseUrl,
        cfg.apiKey,
        cfg.model,
        buildLlmMessages(cfg.persona, this.deps.selfName(), this.deps.nameOf(peerId), this.ring.get(convKey) ?? [])
      )
    } catch (e) {
      console.warn('[ai-replier]', e instanceof Error ? e.message : e)
      return null
    }
  }

  private async enqueue(convKey: string, job: () => Promise<void>): Promise<void> {
    if (this.busy) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.busy = true
    try {
      await job()
    } finally {
      this.busy = false
      const next = this.queue.shift()
      if (next) next()
    }
    void convKey
  }
}
