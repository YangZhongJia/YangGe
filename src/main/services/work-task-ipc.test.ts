import { describe, expect, it, vi } from 'vitest'
import type {
  WorkTaskCreateInput,
  WorkTaskFilter,
  WorkTaskPatch,
  WorkTaskProjectView,
  WorkTaskView
} from '../../shared/ipc'
import { WorkTaskIpcController, type WorkTaskIpcPort } from './work-task-ipc'

function taskView(): WorkTaskView {
  return {
    id: 'task-1',
    ownerNodeId: 'node-self',
    projectId: 'project-1',
    title: '任务',
    description: '',
    startDate: null,
    dueDate: null,
    status: 'not_started',
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
}

function projectView(): WorkTaskProjectView {
  return {
    id: 'project-1',
    ownerNodeId: 'node-self',
    name: '项目',
    isShared: false,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeController() {
  const service = {
    listProjects: vi.fn((): WorkTaskProjectView[] => [projectView()]),
    listTasks: vi.fn((_filter: WorkTaskFilter): WorkTaskView[] => [taskView()]),
    createProject: vi.fn((name: unknown) => ({ ...projectView(), name: String(name) })),
    renameProject: vi.fn(async () => projectView()),
    deleteProject: vi.fn(() => true),
    createTask: vi.fn((input: WorkTaskCreateInput) => ({ ...taskView(), ...input })),
    updateTask: vi.fn(async (_taskId: unknown, patch: WorkTaskPatch) => ({ ...taskView(), ...patch })),
    deleteTask: vi.fn(async () => null),
    shareTask: vi.fn(async () => taskView()),
    unshareTask: vi.fn(async () => taskView()),
    assignTask: vi.fn(async () => taskView()),
    respondAssignment: vi.fn(async () => null),
    setAssignedStatus: vi.fn(async () => null)
  }
  return { service: service as unknown as WorkTaskIpcPort, controller: new WorkTaskIpcController(service) }
}

describe('WorkTaskIpcController 输入校验', () => {
  it('拒绝非对象、缺标题、倒置日期和超长字段', () => {
    const { controller, service } = makeController()
    expect(controller.createTask(null)).toMatchObject({ ok: false })
    expect(controller.createTask({ projectId: 'p', title: '  ' })).toEqual({
      ok: false,
      error: '任务标题不能为空'
    })
    expect(
      controller.createTask({
        projectId: 'p',
        title: 't'.repeat(201),
        description: '',
        startDate: null,
        dueDate: null
      })
    ).toEqual({ ok: false, error: '任务标题不能超过 200 个字符' })
    expect(
      controller.createTask({
        projectId: 'p',
        title: '任务',
        description: 'x'.repeat(8_001),
        startDate: null,
        dueDate: null
      })
    ).toEqual({ ok: false, error: '任务说明过长' })
    expect(
      controller.createTask({
        projectId: 'p',
        title: '任务',
        description: '',
        startDate: '2026-02-31',
        dueDate: null
      })
    ).toEqual({ ok: false, error: '开始日期无效' })
    expect(service.createTask).not.toHaveBeenCalled()
  })

  it('解析筛选条件；非法筛选返回空数组', () => {
    const { controller, service } = makeController()
    expect(controller.listTasks({ scope: 'owned', dueFrom: '2026-11-01' })).toHaveLength(1)
    expect(service.listTasks).toHaveBeenCalledWith({
      scope: 'owned',
      dueFrom: '2026-11-01'
    })
    expect(controller.listTasks({ scope: 'bogus' })).toEqual([])
    expect(controller.listTasks({ scope: 'all', dueFrom: '2026-1-1' })).toEqual([])
  })

  it('校验任务 id、状态与共享同事列表', async () => {
    const { controller, service } = makeController()
    expect(await controller.updateTask('', { title: 'x' })).toEqual({
      ok: false,
      error: '任务标识不合法'
    })
    expect(await controller.updateTask('task-1', { status: 'unknown' })).toEqual({
      ok: false,
      error: '任务状态不合法'
    })
    expect(await controller.shareTask('task-1', [])).toEqual({
      ok: false,
      error: '共享同事数量不合法'
    })
    expect(await controller.unshareTask('task-1', '')).toEqual({
      ok: false,
      error: '共享同事不合法'
    })
    expect(service.updateTask).not.toHaveBeenCalled()
    expect(service.shareTask).not.toHaveBeenCalled()
  })

  it('把服务错误转成 ok:false 而不是抛异常', async () => {
    const { controller, service } = makeController()
    service.shareTask = vi.fn(async () => {
      throw new Error('该同事版本不支持任务共享')
    })
    await expect(controller.shareTask('task-1', ['node-a'])).resolves.toEqual({
      ok: false,
      error: '该同事版本不支持任务共享'
    })
  })
})
