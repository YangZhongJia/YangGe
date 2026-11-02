import { defineStore } from 'pinia'
import type {
  AgentPermissionDecision,
  AgentPermissionRequestView,
  AgentSessionUpdate,
  AgentSessionView,
  AgentUpdateEvent,
  AgentView
} from '../../../shared/ipc'
import { tr } from '../utils/i18n'

// Agent 面板状态。订阅放在 store 内，切换 Tab 后返回仍保留本轮转录；
// 主进程是唯一状态源，这里只做事件投影与乐观用户消息。

export type AgentTranscriptKind = 'user' | 'agent' | 'thought' | 'tool' | 'plan' | 'system'

export interface AgentTranscriptItem {
  id: string
  kind: AgentTranscriptKind
  text: string
  messageId: string
  toolCallId: string
  title: string
  status: string
  at: number
}

let seq = 0
function nextId(): string {
  seq += 1
  return `ui_${Date.now().toString(36)}_${seq}`
}

function toolContentText(update: AgentSessionUpdate): string {
  const content = update.content as unknown
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const nested = (item as Record<string, unknown>)['content']
        if (nested && typeof nested === 'object') {
          const block = nested as Record<string, unknown>
          return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
        }
        return (item as Record<string, unknown>)['type'] === 'text' &&
          typeof (item as Record<string, unknown>)['text'] === 'string'
          ? String((item as Record<string, unknown>)['text'])
          : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const block = content as Record<string, unknown>
    return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
  }
  return ''
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    agents: [] as AgentView[],
    sessions: [] as AgentSessionView[],
    activeSessionId: null as string | null,
    transcripts: {} as Record<string, AgentTranscriptItem[]>,
    pendingPermissions: [] as AgentPermissionRequestView[],
    busy: false,
    scanning: false,
    initialized: false,
    error: ''
  }),
  getters: {
    activeSession(state): AgentSessionView | null {
      return state.sessions.find((session) => session.id === state.activeSessionId) ?? null
    },
    activeTranscript(state): AgentTranscriptItem[] {
      return state.activeSessionId ? state.transcripts[state.activeSessionId] ?? [] : []
    },
    activePermission(state): AgentPermissionRequestView | null {
      return state.pendingPermissions.find(
        (request) => request.sessionId === state.activeSessionId
      ) ?? state.pendingPermissions[0] ?? null
    },
    canSend(state): boolean {
      const active = state.sessions.find((session) => session.id === state.activeSessionId)
      return active?.status === 'idle' && !state.busy
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      window.pantry.onAgentUpdate((event) => this.applyUpdate(event))
      window.pantry.onAgentStatus((event) => {
        this.upsertSession(event.session)
      })
      window.pantry.onAgentPermissionRequest((request) => {
        if (!this.pendingPermissions.some((item) => item.requestId === request.requestId)) {
          this.pendingPermissions.push(request)
        }
      })
      window.pantry.onAgentPermissionResolved((event) => {
        this.pendingPermissions = this.pendingPermissions.filter(
          (item) => item.requestId !== event.requestId
        )
      })
      window.pantry.onAgentExit((event) => {
        const session = this.sessions.find((item) => item.id === event.sessionId)
        if (session) {
          session.status = event.expected ? 'closed' : 'failed'
        }
        if (!event.expected) {
          this.appendSystem(event.sessionId, tr('Agent 已退出：{0}', { 0: event.message }))
        }
      })
      window.pantry.onAgentError((event) => {
        this.error = event.message
        if (event.sessionId) this.appendSystem(event.sessionId, event.message)
      })
      await this.refresh()
    },

    async refresh(): Promise<void> {
      const [agents, sessions] = await Promise.all([
        window.pantry.listAgents(),
        window.pantry.listAgentSessions()
      ])
      this.agents = agents
      const activeIds = new Set(sessions.map((session) => session.id))
      for (const session of sessions) {
        if (!this.transcripts[session.id]) this.transcripts[session.id] = []
      }
      this.sessions = sessions
      if (!this.activeSessionId || !activeIds.has(this.activeSessionId)) {
        const firstLive = sessions.find(
          (session) => session.status !== 'closed' && session.status !== 'failed'
        )
        this.activeSessionId = firstLive?.id ?? sessions[0]?.id ?? null
      }
    },

    async scan(): Promise<void> {
      if (this.scanning) return
      this.scanning = true
      this.error = ''
      try {
        const result = await window.pantry.scanAgents()
        if (!result.ok) {
          this.error = result.error
          return
        }
        this.agents = result.value.agents
        if (result.value.failures.length > 0) {
          this.error = tr('有 {0} 个 Agent 探测失败：{1}', {
            0: result.value.failures.length,
            1: result.value.failures[0].error
          })
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.scanning = false
      }
    },

    async addByPath(path: string): Promise<void> {
      this.error = ''
      const result = await window.pantry.probeAgent(path)
      if (!result.ok) {
        this.error = result.error
        return
      }
      const index = this.agents.findIndex((agent) => agent.id === result.agent.id)
      if (index === -1) this.agents.push(result.agent)
      else this.agents[index] = result.agent
    },

    async newSession(agentId: string, cwd?: string): Promise<void> {
      this.error = ''
      this.busy = true
      try {
        const result = await window.pantry.newAgentSession(agentId, cwd)
        if (!result.ok) {
          this.error = result.error
          return
        }
        this.upsertSession(result.value)
        this.activeSessionId = result.value.id
        if (!this.transcripts[result.value.id]) this.transcripts[result.value.id] = []
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.busy = false
      }
    },

    selectSession(sessionId: string): void {
      this.activeSessionId = sessionId
      this.error = ''
    },

    async send(text: string): Promise<void> {
      const sessionId = this.activeSessionId
      const value = text.trim()
      if (!sessionId || value.length === 0 || this.busy) return
      this.error = ''
      this.busy = true
      this.appendItem(sessionId, {
        id: nextId(),
        kind: 'user',
        text: value,
        messageId: '',
        toolCallId: '',
        title: '',
        status: '',
        at: Date.now()
      })
      try {
        const result = await window.pantry.sendAgentPrompt(sessionId, value)
        if (!result.ok) {
          this.error = result.error
          this.appendSystem(sessionId, result.error)
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.busy = false
      }
    },

    async stop(): Promise<void> {
      if (!this.activeSessionId) return
      await window.pantry.cancelAgent(this.activeSessionId)
    },

    async closeSession(): Promise<void> {
      if (!this.activeSessionId) return
      const sessionId = this.activeSessionId
      await window.pantry.closeAgentSession(sessionId)
      const session = this.sessions.find((item) => item.id === sessionId)
      if (session) session.status = 'closed'
    },

    async respondPermission(requestId: string, decision: AgentPermissionDecision): Promise<void> {
      const result = await window.pantry.respondAgentPermission(requestId, decision)
      if (!result.ok) this.error = result.error
      this.pendingPermissions = this.pendingPermissions.filter(
        (item) => item.requestId !== requestId
      )
    },

    applyUpdate(event: AgentUpdateEvent): void {
      this.applySessionUpdate(event.sessionId, event.update)
    },

    applySessionUpdate(sessionId: string, update: AgentSessionUpdate): void {
      if (!this.transcripts[sessionId]) this.transcripts[sessionId] = []
      const list = this.transcripts[sessionId]
      const kind = update.sessionUpdate
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' ||
        kind === 'user_message_chunk') {
        const text = update.content?.type === 'text' ? update.content.text ?? '' : ''
        if (!text) return
        const targetKind: AgentTranscriptKind = kind === 'agent_thought_chunk'
          ? 'thought'
          : kind === 'user_message_chunk' ? 'user' : 'agent'
        const messageId = typeof update.messageId === 'string' ? update.messageId : ''
        let target: AgentTranscriptItem | undefined
        if (messageId) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].kind === targetKind && list[i].messageId === messageId) {
              target = list[i]
              break
            }
          }
        } else {
          const last = list[list.length - 1]
          if (last && last.kind === targetKind && !last.messageId) target = last
        }
        if (target) target.text += text
        else {
          this.appendItem(sessionId, {
            id: nextId(),
            kind: targetKind,
            text,
            messageId,
            toolCallId: '',
            title: '',
            status: '',
            at: Date.now()
          })
        }
        return
      }

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
        if (!toolCallId) return
        let target = list.find(
          (item) => item.kind === 'tool' && item.toolCallId === toolCallId
        )
        const extra = toolContentText(update)
        if (target) {
          if (typeof update.title === 'string' && update.title) target.title = update.title
          if (typeof update.status === 'string') target.status = update.status
          if (extra) target.text = extra
        } else {
          target = {
            id: nextId(),
            kind: 'tool',
            text: extra,
            messageId: '',
            toolCallId,
            title: typeof update.title === 'string' ? update.title : toolCallId,
            status: typeof update.status === 'string' ? update.status : 'pending',
            at: Date.now()
          }
          list.push(target)
        }
        return
      }

      if (kind === 'plan') {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const text = entries
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return ''
            const row = entry as Record<string, unknown>
            const content = typeof row['content'] === 'string' ? row['content'] : ''
            const status = typeof row['status'] === 'string' ? row['status'] : ''
            return content ? `${status ? `[${status}] ` : ''}${content}` : ''
          })
          .filter(Boolean)
          .join('\n')
        if (text) {
          this.appendItem(sessionId, {
            id: nextId(),
            kind: 'plan',
            text,
            messageId: '',
            toolCallId: '',
            title: '',
            status: '',
            at: Date.now()
          })
        }
      }
    },

    appendSystem(sessionId: string, text: string): void {
      this.appendItem(sessionId, {
        id: nextId(),
        kind: 'system',
        text,
        messageId: '',
        toolCallId: '',
        title: '',
        status: '',
        at: Date.now()
      })
    },

    appendItem(sessionId: string, item: AgentTranscriptItem): void {
      if (!this.transcripts[sessionId]) this.transcripts[sessionId] = []
      this.transcripts[sessionId].push(item)
    },

    upsertSession(session: AgentSessionView): void {
      const index = this.sessions.findIndex((item) => item.id === session.id)
      if (index === -1) this.sessions.unshift(session)
      else this.sessions[index] = session
    }
  }
})
