import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../components/WorkTasksPane.vue', import.meta.url), 'utf8')
const railIconSource = readFileSync(new URL('../components/RailNavIcon.vue', import.meta.url), 'utf8')

describe('任务记录导航与页面', () => {
  it('任务入口位于通讯录与 Agent 之间，并隐藏聊天侧栏', () => {
    const contacts = appSource.indexOf("activateTab('contacts', $event)")
    const tasks = appSource.indexOf("activateTab('tasks', $event)")
    const agent = appSource.indexOf("activateTab('agent', $event)")
    expect(contacts).toBeGreaterThan(-1)
    expect(tasks).toBeGreaterThan(contacts)
    expect(agent).toBeGreaterThan(tasks)
    expect(appSource).toContain("<RailNavIcon name=\"tasks\" />")
    expect(appSource).toContain('tab !== \'agent\' && tab !== \'tasks\'')
    expect(appSource).toContain('WorkTasksPane')
    expect(appSource).toContain('taskBadgeTotal')
    expect(appSource).toContain('onWorkTaskBadge')
    expect(appSource).toContain('onOpenTasks')
    expect(railIconSource).toContain("name === 'tasks'")
  })

  it('页面包含项目、日期筛选与按截止日分组列表', () => {
    for (const text of [
      "tr('我的任务')",
      "tr('共享给我')",
      "tr('全部项目')",
      "tr('新建项目')",
      'type="date"',
      'workTaskListBucket',
      'bucketOrder',
      '已延期',
      '无截止日期'
    ]) {
      expect(paneSource).toContain(text)
    }
  })


  it('只在本机拥有的任务上显示编辑、共享和删除', () => {
    expect(paneSource).toContain('v-if="activeIsShared && !activeTask.assignedToMe"')
    expect(paneSource).toContain('class="detail-head-actions"')
    expect(paneSource).toContain('class="row-share"')
    expect(paneSource).toContain("tr('编辑')")
    expect(paneSource).toContain("tr('共享')")
    expect(paneSource).toContain("tr('删除')")
  })

  it('共享只列出声明 tsk1 的同事，并提示局域网不加密', () => {
    expect(paneSource).toContain("peer.caps.includes('tsk1')")
    expect(paneSource).toContain("tr('任务文字会通过局域网发送给所选同事；局域网通信不加密。')")
    expect(paneSource).toContain("deliveryLabel(share.state)")
  })

  it('页面按派生状态展示，不把延期写回持久化状态', () => {
    expect(paneSource).toContain('getWorkTaskDisplayStatus(task, store.todayIso)')
    expect(paneSource).not.toContain("status: 'overdue'")
    expect(paneSource).toContain('workTaskListBucket(task, store.todayIso)')
  })
})
