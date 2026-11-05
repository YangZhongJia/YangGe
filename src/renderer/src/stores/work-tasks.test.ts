import { createPinia, setActivePinia } from 'pinia'
import { isProxy, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkTaskCreateInput,
  WorkTaskFilter,
  WorkTaskPatch,
  WorkTaskProjectView,
  WorkTaskResult,
  WorkTaskView
} from '../../../shared/ipc'
import { useWorkTasksStore } from './work-tasks'

const project: WorkTaskProjectView = {
  id: 'project-1',
  ownerNodeId: 'node-self',
  name: '五期',
  isShared: false,
  createdAt: 1,
  updatedAt: 1
}

const task: WorkTaskView = {
  id: 'task-1',
  ownerNodeId: 'node-self',
  projectId: 'project-1',
  title: '回归测试',
  description: '',
  startDate: null,
  dueDate: '2026-11-05',
  status: 'in_progress',
  assigneeNodeId: null,
  assignmentState: null,
  assignedToMe: false,
  revision: 1,
  active: true,
  isShared: false,
  createdAt: 1,
  updatedAt: 1,
  shares: []
}

function installApi() {
  let updateListener: ((next: WorkTaskView) => void) | null = null
  const api = {
    getAppInfo: vi.fn(async () => ({ nodeId: 'node-self' })),
    listWorkTaskProjects: vi.fn(async () => [project]),
    listWorkTasks: vi.fn(async (_filter?: WorkTaskFilter) => [task]),
    createWorkTask: vi.fn(
      async (input: WorkTaskCreateInput): Promise<WorkTaskResult<WorkTaskView>> => ({
        ok: true,
        value: { ...task, ...input }
      })
    ),
    updateWorkTask: vi.fn(async (_taskId: string, patch: WorkTaskPatch) => ({
      ok: true as const,
      value: { ...task, ...patch }
    })),
    deleteWorkTask: vi.fn(async () => ({ ok: true as const, value: null })),
    shareWorkTask: vi.fn(async (_taskId: string, _peerIds: string[]) => ({
      ok: true as const,
      value: task
    })),
    unshareWorkTask: vi.fn(async () => ({ ok: true as const, value: task })),
    createWorkTaskProject: vi.fn(async (name: string) => ({
      ok: true as const,
      value: { ...project, name }
    })),
    renameWorkTaskProject: vi.fn(async (_id: string, name: string) => ({
      ok: true as const,
      value: { ...project, name }
    })),
    deleteWorkTaskProject: vi.fn(async () => ({ ok: true as const, value: null })),
    onWorkTaskUpdated: vi.fn((listener: (next: WorkTaskView) => void) => {
      updateListener = listener
      return () => {
        updateListener = null
      }
    })
  }
  vi.stubGlobal('window', { pantry: api })
  return { api, emitUpdate: (next: WorkTaskView) => updateListener?.(next) }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('work task store', () => {
  it('初始化时加载项目与任务，并只订阅一次更新事件', async () => {
    const { api } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    expect(store.projects).toEqual([project])
    expect(store.tasks).toEqual([task])
    expect(api.listWorkTasks).toHaveBeenCalledWith({ scope: 'all' })
    expect(api.onWorkTaskUpdated).toHaveBeenCalledTimes(1)
    // 渲染层不再读取 appInfo 自行判定归属，避免身份为空时全量误判共享。
    expect(api.getAppInfo).not.toHaveBeenCalled()
  })

  it('筛选变化会重新请求列表并保留筛选条件', async () => {
    const { api } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    await store.setFilter({ scope: 'shared', projectId: 'project-1', dueFrom: '2026-11-01' })
    expect(store.filter).toEqual({
      scope: 'shared',
      projectId: 'project-1',
      dueFrom: '2026-11-01'
    })
    expect(api.listWorkTasks).toHaveBeenLastCalledWith({
      scope: 'shared',
      projectId: 'project-1',
      dueFrom: '2026-11-01'
    })
  })

  it('创建成功后选中新任务', async () => {
    const { api } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    const saved = await store.createTask({
      projectId: 'project-1',
      title: '新任务',
      description: '',
      startDate: null,
      dueDate: null
    })
    expect(saved).toBe(true)
    expect(store.selectedTaskId).toBe(task.id)
    expect(api.createWorkTask).toHaveBeenCalled()
  })

  it('创建失败保留服务端错误，成功则刷新列表', async () => {
    const { api } = installApi()
    api.createWorkTask.mockResolvedValueOnce({ ok: false, error: '任务标题不能为空' })
    const store = useWorkTasksStore()
    await store.init()
    const callsBefore = api.listWorkTasks.mock.calls.length
    const saved = await store.createTask({
      projectId: 'project-1',
      title: ' ',
      description: '',
      startDate: null,
      dueDate: null
    })
    expect(saved).toBe(false)
    expect(store.error).toBe('任务标题不能为空')
    expect(api.listWorkTasks.mock.calls.length).toBe(callsBefore)
  })

  it('收到共享更新事件后按任务 id 更新而不重复行', async () => {
    const { emitUpdate } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    const updated = { ...task, title: '更新后的任务', revision: 2 }
    emitUpdate(updated)
    emitUpdate(updated)
    expect(store.tasks.filter((item) => item.id === task.id)).toHaveLength(1)
    expect(store.tasks[0].title).toBe('更新后的任务')
  })

  it('共享前把响应式 peer 数组转成普通数组，避免 IPC 克隆失败', async () => {
    const { api } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    const peers = reactive(['node-a'])
    await store.shareTask(task.id, peers)
    const sent = api.shareWorkTask.mock.calls[0][1]
    expect(isProxy(sent)).toBe(false)
    expect(sent).toEqual(['node-a'])
  })

  it('共享和撤销共享转发到 preload 并刷新', async () => {
    const { api } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    await expect(store.shareTask(task.id, ['node-a'])).resolves.toBe(true)
    expect(api.shareWorkTask).toHaveBeenCalledWith(task.id, ['node-a'])
    await expect(store.unshareTask(task.id, 'node-a')).resolves.toBe(true)
    expect(api.unshareWorkTask).toHaveBeenCalledWith(task.id, 'node-a')
  })

  it('区分本机任务与共享副本', async () => {
    const { emitUpdate } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    const remote = {
      ...task,
      id: 'task-remote',
      ownerNodeId: 'node-peer',
      title: '同事的任务',
      isShared: true
    }
    emitUpdate(remote)
    expect(store.isSharedTask(remote)).toBe(true)
    expect(store.isSharedTask(task)).toBe(false)
  })

  it('归属只认主进程 isShared，不再按 owner 与渲染层缓存身份比较', async () => {
    const { emitUpdate } = installApi()
    const store = useWorkTasksStore()
    await store.init()
    // 模拟身份文件缺失/重建后的本地库：owner 与当前主进程身份不同，
    // 主进程判定为只读副本；渲染层不得自行猜测为“我的任务”。
    const foreign = { ...task, id: 'task-foreign', ownerNodeId: 'node-previous', isShared: true }
    // 反之，主进程判定为本机任务时不得因 owner 字符串不同而改成共享。
    const owned = { ...task, id: 'task-owned', ownerNodeId: 'node-previous', isShared: false }
    emitUpdate(foreign)
    emitUpdate(owned)
    expect(store.isSharedTask(foreign)).toBe(true)
    expect(store.isSharedTask(owned)).toBe(false)
  })

  it('身份读取失败不影响任务归属展示', async () => {
    const { api } = installApi()
    api.getAppInfo.mockRejectedValueOnce(new Error('app state not ready'))
    const store = useWorkTasksStore()
    await store.init()
    expect(store.error).toBe('')
    expect(store.isSharedTask(store.tasks[0])).toBe(false)
  })
})
