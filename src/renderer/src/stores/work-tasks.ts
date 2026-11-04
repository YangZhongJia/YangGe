import { defineStore } from 'pinia'
import type {
  WorkTaskCreateInput,
  WorkTaskFilter,
  WorkTaskPatch,
  WorkTaskProjectView,
  WorkTaskResult,
  WorkTaskView
} from '../../../shared/ipc'
import { localTodayIso } from '../../../shared/work-task'

let stopTaskUpdates: (() => void) | null = null

interface MutationTarget {
  error: string
  refresh(): Promise<void>
}

async function runMutation<T>(
  store: MutationTarget,
  action: () => Promise<WorkTaskResult<T>>
): Promise<boolean> {
  store.error = ''
  try {
    const result = await action()
    if (!result.ok) {
      store.error = result.error
      return false
    }
    await store.refresh()
    return true
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    return false
  }
}

export const useWorkTasksStore = defineStore('workTasks', {
  state: () => ({
    projects: [] as WorkTaskProjectView[],
    tasks: [] as WorkTaskView[],
    filter: { scope: 'all' } as WorkTaskFilter,
    selectedTaskId: null as string | null,
    loading: false,
    error: '',
    initialized: false,
    todayIso: localTodayIso()
  }),
  getters: {
    activeTask(state): WorkTaskView | null {
      return state.tasks.find((task) => task.id === state.selectedTaskId) ?? null
    },
    isSharedTask: () => {
      // 归属由主进程按 appState.nodeId 判定并通过 isShared 下发；渲染层不再缓存身份，
      // 避免身份读取失败/为空时把全部本机任务误标成“共享给我”的只读副本。
      return (task: WorkTaskView): boolean => task.isShared === true
    },
    projectNameOf: (state) => {
      return (projectId: string): string =>
        state.projects.find((project) => project.id === projectId)?.name ?? ''
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      // 同一时刻只保留一个任务页订阅；新 store 初始化会替换旧订阅。
      stopTaskUpdates?.()
      stopTaskUpdates = window.pantry.onWorkTaskUpdated((task) => {
        this.upsertTask(task)
        void this.refreshProjects()
      })
      await this.refresh()
    },

    async refresh(): Promise<void> {
      this.loading = true
      this.error = ''
      this.todayIso = localTodayIso()
      try {
        const [projects, tasks] = await Promise.all([
          window.pantry.listWorkTaskProjects(),
          window.pantry.listWorkTasks({ ...this.filter })
        ])
        this.projects = projects
        this.tasks = tasks
        if (this.selectedTaskId && !tasks.some((task) => task.id === this.selectedTaskId)) {
          this.selectedTaskId = tasks[0]?.id ?? null
        } else if (!this.selectedTaskId) {
          this.selectedTaskId = tasks[0]?.id ?? null
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    async refreshProjects(): Promise<void> {
      try {
        this.projects = await window.pantry.listWorkTaskProjects()
      } catch {
        // 事件刷新失败不覆盖已有列表；用户下次手动刷新会重试。
      }
    },

    async setFilter(patch: Partial<WorkTaskFilter>): Promise<void> {
      this.filter = { ...this.filter, ...patch }
      await this.refresh()
    },

    selectTask(taskId: string | null): void {
      this.selectedTaskId = taskId
    },

    upsertTask(task: WorkTaskView): void {
      const index = this.tasks.findIndex(
        (item) => item.id === task.id && item.ownerNodeId === task.ownerNodeId
      )
      if (!task.active) {
        if (index >= 0) this.tasks.splice(index, 1)
        if (this.selectedTaskId === task.id) this.selectedTaskId = this.tasks[0]?.id ?? null
        return
      }
      if (index >= 0) this.tasks[index] = task
      else this.tasks.unshift(task)
    },

    async createTask(input: WorkTaskCreateInput): Promise<boolean> {
      this.error = ''
      try {
        const result = await window.pantry.createWorkTask(input)
        if (!result.ok) {
          this.error = result.error
          return false
        }
        await this.refresh()
        this.selectedTaskId = result.value.id
        return true
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        return false
      }
    },

    async updateTask(taskId: string, patch: WorkTaskPatch): Promise<boolean> {
      return runMutation(this, () => window.pantry.updateWorkTask(taskId, patch))
    },

    async deleteTask(taskId: string): Promise<boolean> {
      return runMutation(this, () => window.pantry.deleteWorkTask(taskId))
    },

    async shareTask(taskId: string, peerIds: string[]): Promise<boolean> {
      // Pinia 的响应式数组是 Proxy，结构化克隆无法复制；先转成普通数组。
      return runMutation(this, () => window.pantry.shareWorkTask(taskId, [...peerIds]))
    },

    async unshareTask(taskId: string, peerId: string): Promise<boolean> {
      return runMutation(this, () => window.pantry.unshareWorkTask(taskId, peerId))
    },

    async createProject(name: string): Promise<boolean> {
      return runMutation(this, () => window.pantry.createWorkTaskProject(name))
    },

    async renameProject(projectId: string, name: string): Promise<boolean> {
      return runMutation(this, () => window.pantry.renameWorkTaskProject(projectId, name))
    },

    async deleteProject(projectId: string): Promise<boolean> {
      return runMutation(this, () => window.pantry.deleteWorkTaskProject(projectId))
    }
  }
})
