import { defineStore } from 'pinia'
import type { DuelAction, DuelCommandResult, DuelStateEvent, DuelView } from '../../../shared/duel'

// 角斗场在主进程只保留一份内存会话；渲染层是它的只读投影 + 命令代理。
// 事件先订阅再拉初始快照，避免启动瞬间错过邀请。

let stopDuelState: (() => void) | null = null
let eventCount = 0

export const useDuelStore = defineStore('duel', {
  state: () => ({
    view: null as DuelView | null,
    initialized: false
  }),
  getters: {
    pendingInvite(state): DuelView | null {
      return state.view?.phase === 'incoming' ? state.view : null
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      stopDuelState = window.pantry.onDuelState((event: DuelStateEvent) => {
        eventCount += 1
        this.view = event.view
      })
      const initial = await window.pantry.getDuel()
      // 初始化期间若已收到实时事件，以事件为准（可能比快照更新）。
      if (eventCount === 0) this.view = initial
    },

    async invite(peerNodeId: string): Promise<DuelCommandResult> {
      return window.pantry.duelInvite(peerNodeId)
    },

    async respond(matchId: string, accept: boolean): Promise<DuelCommandResult> {
      return window.pantry.duelRespond(matchId, accept)
    },

    async move(matchId: string, action: DuelAction): Promise<DuelCommandResult> {
      return window.pantry.duelMove(matchId, action)
    },

    async quit(matchId: string): Promise<DuelCommandResult> {
      return window.pantry.duelQuit(matchId)
    },

    async close(matchId: string): Promise<DuelCommandResult> {
      return window.pantry.duelClose(matchId)
    },

    dispose(): void {
      stopDuelState?.()
      stopDuelState = null
    }
  }
})
