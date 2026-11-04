<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { PeerView, WorkTaskProjectView, WorkTaskView } from '../../../shared/ipc'
import {
  getWorkTaskDisplayStatus,
  workTaskListBucket,
  WORK_TASK_LIMITS,
  type WorkTaskDisplayStatus,
  type WorkTaskListBucket,
  type WorkTaskStatus
} from '../../../shared/work-task'
import { useWorkTasksStore } from '../stores/work-tasks'
import { usePeersStore } from '../stores/peers'
import { tr } from '../utils/i18n'

const store = useWorkTasksStore()
const peersStore = usePeersStore()

const editingId = ref<string | null>(null)
const showForm = ref(false)
const formError = ref('')
const form = reactive({
  projectId: '',
  title: '',
  description: '',
  startDate: '',
  dueDate: '',
  status: 'not_started' as WorkTaskStatus
})

const newProjectName = ref('')
const renamingProjectId = ref<string | null>(null)
const renameValue = ref('')

// 日期筛选只保留一个“开始”和一个“截止”边界：
// 开始 → 任务开始日期不早于所选（startFrom）；截止 → 任务截止日期不晚于所选（dueTo）。
const startFrom = ref(store.filter.startFrom ?? '')
const dueTo = ref(store.filter.dueTo ?? '')
const hasDateFilters = computed(() => Boolean(startFrom.value || dueTo.value))

const shareOpen = ref(false)
const shareSelection = ref<string[]>([])
const shareSaving = ref(false)
const shareSaved = ref(false)

const activeTask = computed(() => store.activeTask)
const activeProject = computed(() =>
  activeTask.value
    ? store.projects.find((project) => project.id === activeTask.value!.projectId) ?? null
    : null
)
const activeIsShared = computed(() => (activeTask.value ? store.isSharedTask(activeTask.value) : false))

const bucketLabels: Record<WorkTaskListBucket, string> = {
  overdue: '已延期',
  today: '今天',
  this_week: '本周内',
  later: '以后',
  none: '无截止日期',
  completed: '已结束'
}
const bucketOrder: WorkTaskListBucket[] = [
  'overdue',
  'today',
  'this_week',
  'later',
  'none',
  'completed'
]

const groups = computed(() => {
  const buckets = new Map<WorkTaskListBucket, WorkTaskView[]>()
  for (const task of store.tasks) {
    const bucket = workTaskListBucket(task, store.todayIso)
    const list = buckets.get(bucket) ?? []
    list.push(task)
    buckets.set(bucket, list)
  }
  return bucketOrder
    .map((bucket) => ({
      bucket,
      label: tr(bucketLabels[bucket]),
      tasks: buckets.get(bucket) ?? []
    }))
    .filter((group) => group.tasks.length > 0)
})

const projectCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const task of store.tasks) {
    counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1)
  }
  return counts
})

const ownedProjects = computed(() => store.projects.filter((project) => !project.isShared))
const shareCandidates = computed<PeerView[]>(() =>
  peersStore.peers.filter((peer) => peer.caps.includes('tsk1'))
)
const hasAnyPeers = computed(() => peersStore.peers.length > 0)
const currentShares = computed(() => activeTask.value?.shares ?? [])

const statusLabels: Record<WorkTaskDisplayStatus, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已结束',
  overdue: '延期'
}
const deliveryLabels: Record<string, string> = {
  sent: '已送达',
  queued: '等待上线',
  failed: '发送失败',
  unsupported: '版本不支持',
  revoked: '已撤销'
}

const canSave = computed(
  () =>
    form.title.trim().length > 0 &&
    form.projectId.length > 0 &&
    form.title.trim().length <= WORK_TASK_LIMITS.title
)

function statusLabel(task: WorkTaskView): string {
  return tr(statusLabels[getWorkTaskDisplayStatus(task, store.todayIso)])
}

function projectName(task: WorkTaskView): string {
  return store.projectNameOf(task.projectId) || tr('未命名项目')
}

function peerName(peerId: string): string {
  return peersStore.nameOf(peerId)
}

function deliveryLabel(state: string): string {
  return tr(deliveryLabels[state] ?? state)
}

function resetForm(): void {
  form.projectId = ownedProjects.value[0]?.id ?? ''
  form.title = ''
  form.description = ''
  form.startDate = ''
  form.dueDate = ''
  form.status = 'not_started'
  formError.value = ''
}

function openCreate(): void {
  editingId.value = null
  showForm.value = true
  shareOpen.value = false
  resetForm()
}

function closeForm(): void {
  showForm.value = false
  editingId.value = null
  formError.value = ''
}

function startEdit(task: WorkTaskView): void {
  if (store.isSharedTask(task)) return
  editingId.value = task.id
  showForm.value = true
  shareOpen.value = false
  formError.value = ''
  form.projectId = task.projectId
  form.title = task.title
  form.description = task.description
  form.startDate = task.startDate ?? ''
  form.dueDate = task.dueDate ?? ''
  form.status = task.status
}

async function saveTask(): Promise<void> {
  if (!canSave.value) return
  formError.value = ''
  const input = {
    projectId: form.projectId,
    title: form.title.trim(),
    description: form.description,
    startDate: form.startDate || null,
    dueDate: form.dueDate || null
  }
  const ok = editingId.value
    ? await store.updateTask(editingId.value, { ...input, status: form.status })
    : await store.createTask(input)
  if (ok) closeForm()
  else formError.value = store.error
}

async function removeTask(): Promise<void> {
  const task = activeTask.value
  if (!task || store.isSharedTask(task)) return
  if (!window.confirm(tr('确定删除这个任务？'))) return
  await store.deleteTask(task.id)
}

function selectProject(projectId: string | undefined): void {
  void store.setFilter({ projectId })
}

function selectScope(scope: 'all' | 'owned' | 'shared'): void {
  void store.setFilter({ scope, projectId: undefined })
}

async function applyDateFilters(): Promise<void> {
  // 显式的空值清理旧版遗留的区间筛选键，避免切换页面后仍沿用 startTo / dueFrom。
  await store.setFilter({
    startFrom: startFrom.value || undefined,
    dueTo: dueTo.value || undefined,
    startTo: undefined,
    dueFrom: undefined
  })
}

async function clearDateFilters(): Promise<void> {
  startFrom.value = ''
  dueTo.value = ''
  await applyDateFilters()
}

async function addProject(): Promise<void> {
  const name = newProjectName.value.trim()
  if (!name) return
  if (await store.createProject(name)) newProjectName.value = ''
}

function beginRename(project: WorkTaskProjectView): void {
  renamingProjectId.value = project.id
  renameValue.value = project.name
}

async function commitRename(): Promise<void> {
  const id = renamingProjectId.value
  if (!id) return
  const name = renameValue.value.trim()
  if (name && (await store.renameProject(id, name))) {
    renamingProjectId.value = null
    renameValue.value = ''
  }
}

async function removeProject(project: WorkTaskProjectView): Promise<void> {
  if (!window.confirm(tr('确定删除项目「{0}」？', { 0: project.name }))) return
  await store.deleteProject(project.id)
}

function openShare(): void {
  const task = activeTask.value
  if (!task || store.isSharedTask(task)) return
  shareSelection.value = task.shares.map((share) => share.peerId)
  shareSaved.value = false
  shareOpen.value = true
}

function shareFromRow(task: WorkTaskView): void {
  store.selectTask(task.id)
  openShare()
}

async function saveShare(): Promise<void> {
  const task = activeTask.value
  if (!task || shareSelection.value.length === 0) return
  if (shareSaving.value) return
  shareSaving.value = true
  shareSaved.value = false
  try {
    shareSaved.value = await store.shareTask(task.id, [...shareSelection.value])
  } finally {
    shareSaving.value = false
  }
}

async function unshare(peerId: string): Promise<void> {
  const task = activeTask.value
  if (!task) return
  if (await store.unshareTask(task.id, peerId)) {
    shareSelection.value = shareSelection.value.filter((id) => id !== peerId)
  }
}

async function init(): Promise<void> {
  await store.init()
  await peersStore.init()
  startFrom.value = store.filter.startFrom ?? ''
  dueTo.value = store.filter.dueTo ?? ''
}

onMounted(() => {
  void init()
})
</script>

<template>
  <section class="work-tasks">
    <header class="wt-header">
      <div>
        <p class="eyebrow">TASKS</p>
        <h1>{{ tr('任务') }}</h1>
        <p class="wt-subtitle">
          {{ tr('按项目和日期记录工作，可把任务共享给内网同事。') }}
        </p>
      </div>
      <NButton type="primary" :disabled="ownedProjects.length === 0" @click="openCreate">
        {{ tr('新建任务') }}
      </NButton>
    </header>

    <div v-if="store.error" class="error-bar" role="alert">
      <span>{{ store.error }}</span>
      <button type="button" :aria-label="tr('关闭提示')" @click="store.error = ''">×</button>
    </div>

    <div class="wt-body">
      <aside class="wt-side">
        <div class="scope-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="store.filter.scope === 'all'"
            :class="{ active: store.filter.scope === 'all' }"
            @click="selectScope('all')"
          >
            {{ tr('全部') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="store.filter.scope === 'owned'"
            :class="{ active: store.filter.scope === 'owned' }"
            @click="selectScope('owned')"
          >
            {{ tr('我的任务') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="store.filter.scope === 'shared'"
            :class="{ active: store.filter.scope === 'shared' }"
            @click="selectScope('shared')"
          >
            {{ tr('共享给我') }}
          </button>
        </div>

        <h4>{{ tr('项目') }}</h4>
        <div class="new-project">
          <NInput
            v-model:value="newProjectName"
            size="small"
            :maxlength="WORK_TASK_LIMITS.projectName"
            :placeholder="tr('新建项目')"
            @keydown.enter.prevent="addProject"
          />
          <NButton size="tiny" :disabled="!newProjectName.trim()" @click="addProject">
            {{ tr('添加') }}
          </NButton>
        </div>
        <button
          type="button"
          class="project-row"
          :class="{ active: !store.filter.projectId }"
          @click="selectProject(undefined)"
        >
          <span>{{ tr('全部项目') }}</span>
          <span class="count">{{ store.tasks.length }}</span>
        </button>
        <div v-for="project in store.projects" :key="project.ownerNodeId + project.id" class="project-item">
          <button
            type="button"
            class="project-row"
            :class="{ active: store.filter.projectId === project.id }"
            @click="selectProject(project.id)"
          >
            <span>
              {{ project.name }}
              <small v-if="project.isShared" class="shared-tag">{{ tr('共享') }}</small>
            </span>
            <span class="count">{{ projectCounts.get(project.id) ?? 0 }}</span>
          </button>
          <div v-if="!project.isShared" class="project-actions">
            <button type="button" @click="beginRename(project)">{{ tr('改名') }}</button>
            <button type="button" @click="removeProject(project)">{{ tr('删除') }}</button>
          </div>
          <div v-if="renamingProjectId === project.id" class="rename-row">
            <input
              v-model="renameValue"
              :aria-label="tr('项目名')"
              :maxlength="WORK_TASK_LIMITS.projectName"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingProjectId = null"
            />
            <button type="button" @click="commitRename">{{ tr('保存') }}</button>
            <button type="button" @click="renamingProjectId = null">{{ tr('取消') }}</button>
          </div>
        </div>
      </aside>

      <section class="wt-list">
        <div class="filters">
          <label>
            <span>{{ tr('开始') }}</span>
            <input
              v-model="startFrom"
              type="date"
              :title="tr('只显示开始日期不早于该日的任务')"
              @change="applyDateFilters"
            />
          </label>
          <label>
            <span>{{ tr('截止') }}</span>
            <input
              v-model="dueTo"
              type="date"
              :title="tr('只显示截止日期不晚于该日的任务')"
              @change="applyDateFilters"
            />
          </label>
          <button v-if="hasDateFilters" type="button" class="clear-filters" @click="clearDateFilters">
            {{ tr('清除') }}
          </button>
        </div>

        <div v-if="store.loading && store.tasks.length === 0" class="list-empty">
          {{ tr('正在加载任务…') }}
        </div>
        <div v-else-if="groups.length === 0" class="list-empty">
          {{ tr('还没有任务。新建一个项目和一个任务开始记录。') }}
        </div>
        <div v-for="group in groups" :key="group.bucket" class="task-group">
          <h3>
            <span>{{ group.label }}</span>
            <span class="count">{{ group.tasks.length }}</span>
          </h3>
          <div
            v-for="task in group.tasks"
            :key="task.ownerNodeId + task.id"
            class="task-row"
            role="button"
            tabindex="0"
            :class="{ active: store.selectedTaskId === task.id }"
            :data-status="getWorkTaskDisplayStatus(task, store.todayIso)"
            @click="store.selectTask(task.id)"
            @keydown.enter.prevent="store.selectTask(task.id)"
            @keydown.space.prevent="store.selectTask(task.id)"
          >
            <span class="status-chip" :data-status="getWorkTaskDisplayStatus(task, store.todayIso)">
              {{ statusLabel(task) }}
            </span>
            <span class="task-main">
              <strong>{{ task.title }}</strong>
              <small>
                {{ projectName(task) }}
                <template v-if="task.startDate"> · {{ tr('开始') }} {{ task.startDate }}</template>
                <template v-if="task.dueDate"> · {{ tr('截止') }} {{ task.dueDate }}</template>
              </small>
            </span>
            <span v-if="store.isSharedTask(task)" class="shared-tag">{{ tr('共享') }}</span>
            <button
              v-else
              type="button"
              class="row-share"
              :aria-label="tr('共享任务 {0}', { 0: task.title })"
              @click.stop="shareFromRow(task)"
            >
              {{ tr('共享') }}
            </button>
          </div>
        </div>
      </section>

      <aside class="wt-detail">
        <template v-if="showForm">
          <header class="detail-head">
            <h3>{{ editingId ? tr('编辑任务') : tr('新建任务') }}</h3>
          </header>
          <p v-if="ownedProjects.length === 0" class="detail-empty">
            {{ tr('请先在左侧创建一个项目。') }}
          </p>
          <template v-else>
            <label class="field">
              <span>{{ tr('项目') }}</span>
              <select v-model="form.projectId">
                <option v-for="project in ownedProjects" :key="project.id" :value="project.id">
                  {{ project.name }}
                </option>
              </select>
            </label>
            <label class="field">
              <span>{{ tr('标题') }}</span>
              <NInput
                v-model:value="form.title"
                :maxlength="WORK_TASK_LIMITS.title"
                :placeholder="tr('例如：完成五期登录回归')"
              />
            </label>
            <label class="field">
              <span>{{ tr('说明') }}</span>
              <textarea
                v-model="form.description"
                rows="4"
                :placeholder="tr('补充范围、环境或验收标准')"
              ></textarea>
            </label>
            <div class="field-row">
              <label class="field">
                <span>{{ tr('开始日期') }}</span>
                <input v-model="form.startDate" type="date" />
              </label>
              <label class="field">
                <span>{{ tr('截止日期') }}</span>
                <input v-model="form.dueDate" type="date" />
              </label>
            </div>
            <label v-if="editingId" class="field">
              <span>{{ tr('状态') }}</span>
              <select v-model="form.status">
                <option value="not_started">{{ tr('未开始') }}</option>
                <option value="in_progress">{{ tr('进行中') }}</option>
                <option value="completed">{{ tr('已结束') }}</option>
              </select>
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="detail-actions">
              <NButton @click="closeForm">{{ tr('取消') }}</NButton>
              <NButton type="primary" :disabled="!canSave" @click="saveTask">
                {{ tr('保存') }}
              </NButton>
            </div>
          </template>
        </template>

        <template v-else-if="activeTask">
          <header class="detail-head">
            <div>
              <p class="eyebrow">{{ activeIsShared ? 'SHARED' : 'TASK' }}</p>
              <h3>{{ activeTask.title }}</h3>
            </div>
            <div class="detail-head-actions">
              <span
                class="status-chip"
                :data-status="getWorkTaskDisplayStatus(activeTask, store.todayIso)"
              >
                {{ statusLabel(activeTask) }}
              </span>
              <template v-if="!activeIsShared">
                <NButton size="tiny" @click="startEdit(activeTask)">{{ tr('编辑') }}</NButton>
                <NButton size="tiny" @click="openShare">{{ tr('共享') }}</NButton>
                <NButton size="tiny" type="error" ghost @click="removeTask">{{ tr('删除') }}</NButton>
              </template>
            </div>
          </header>
          <p class="detail-project">{{ activeProject?.name ?? tr('未命名项目') }}</p>
          <dl class="detail-dates">
            <div><dt>{{ tr('开始') }}</dt><dd>{{ activeTask.startDate || tr('未设置') }}</dd></div>
            <div><dt>{{ tr('截止') }}</dt><dd>{{ activeTask.dueDate || tr('未设置') }}</dd></div>
          </dl>
          <p class="detail-desc">{{ activeTask.description || tr('无说明') }}</p>

          <div v-if="activeIsShared" class="notice">
            {{ tr('这是同事共享给你的只读任务，由 {0} 维护。', { 0: peerName(activeTask.ownerNodeId) }) }}
          </div>

          <div v-if="shareOpen && !activeIsShared" class="share-panel">
            <h4>{{ tr('共享给同事') }}</h4>
            <p class="notice notice-warn">
              {{ tr('任务文字会通过局域网发送给所选同事；局域网通信不加密。') }}
            </p>
            <p v-if="!hasAnyPeers" class="detail-empty">
              {{ tr('通讯录里还没有同事；等对方上线后再试。') }}
            </p>
            <p v-else-if="shareCandidates.length === 0" class="detail-empty">
              {{ tr('没有可共享的同事；对方需要升级到支持任务共享的版本。') }}
            </p>
            <label v-for="peer in shareCandidates" :key="peer.nodeId" class="peer-row">
              <input v-model="shareSelection" type="checkbox" :value="peer.nodeId" />
              <span>{{ peer.remark || peer.nick }}</span>
              <small v-if="peer.online">{{ tr('在线') }}</small>
            </label>
            <div class="detail-actions">
              <NButton @click="shareOpen = false">{{ tr('取消') }}</NButton>
              <NButton
                type="primary"
                :loading="shareSaving"
                :disabled="shareSelection.length === 0"
                @click="saveShare"
              >
                {{ tr('保存共享') }}
              </NButton>
            </div>
            <p v-if="shareSaved" class="notice" role="status">{{ tr('共享已保存，投递状态见下方。') }}</p>
            <div v-if="currentShares.length > 0" class="share-list">
              <h5>{{ tr('当前共享') }}</h5>
              <div v-for="share in currentShares" :key="share.peerId" class="share-entry">
                <span>{{ peerName(share.peerId) }}</span>
                <small>{{ deliveryLabel(share.state) }}</small>
                <button type="button" @click="unshare(share.peerId)">{{ tr('取消共享') }}</button>
              </div>
            </div>
          </div>
        </template>

        <div v-else class="detail-empty">{{ tr('选择一个任务查看详情。') }}</div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.work-tasks {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-chat);
}
.wt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  /* 顶部 32px 是窗口拖拽/控制条，避免“新建任务”压在最小化/关闭按钮上。 */
  padding: 46px 26px 16px;
  border-bottom: 1px solid var(--line);
}
.wt-header h1 {
  margin: 2px 0 4px;
  font-size: var(--font-lg);
}
.wt-subtitle {
  margin: 0;
  color: var(--text-3);
  font-size: var(--font-sm);
}
.eyebrow {
  margin: 0;
  color: var(--text-3);
  font-size: var(--font-xs);
  letter-spacing: 0.14em;
}
.error-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 26px;
  color: var(--danger, #b91c1c);
  background: var(--danger-weak, #fef2f2);
  border-bottom: 1px solid var(--line);
  font-size: var(--font-sm);
}
.error-bar button {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}
.wt-body {
  display: grid;
  grid-template-columns: 210px minmax(280px, 1fr) minmax(280px, 350px);
  flex: 1;
  min-height: 0;
}
.wt-side,
.wt-list,
.wt-detail {
  min-height: 0;
  overflow-y: auto;
}
.wt-side {
  padding: 16px 14px;
  border-right: 1px solid var(--line);
  background: var(--bg-list);
}
.wt-side h4 {
  margin: 18px 4px 8px;
  color: var(--text-3);
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
}
.scope-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.scope-tabs button,
.project-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
}
.scope-tabs button:hover,
.project-row:hover {
  background: var(--primary-weak);
}
.scope-tabs button.active,
.project-row.active {
  border-color: var(--primary-border);
  background: var(--primary-weak);
  color: var(--text-1);
}
.count {
  color: var(--text-3);
  font-size: var(--font-xs);
}
.project-item {
  margin-bottom: 2px;
}
.project-actions,
.rename-row {
  display: flex;
  gap: 6px;
  padding: 0 10px 6px;
}
.project-actions button,
.rename-row button,
.share-entry button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: var(--font-xs);
  cursor: pointer;
}
.project-actions button:hover,
.rename-row button:hover,
.share-entry button:hover {
  color: var(--primary);
}
.rename-row input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
  color: var(--text-1);
  font: inherit;
  font-size: var(--font-xs);
}
.new-project {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.shared-tag {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 10px;
}
.wt-list {
  padding: 14px 18px 24px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  row-gap: 10px;
}
.filters label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-3);
  font-size: var(--font-xs);
}
.filters input {
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
  color: var(--text-1);
  font: inherit;
  font-size: var(--font-xs);
}
.clear-filters {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--primary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.list-empty,
.detail-empty {
  padding: 24px 6px;
  color: var(--text-3);
  font-size: var(--font-sm);
}
.task-group {
  margin-top: 16px;
}
.task-group h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 6px;
  padding: 0 4px;
  color: var(--text-2);
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
}
.task-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-bottom: 4px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: var(--surface, var(--bg-input));
  color: var(--text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}
.task-row:hover {
  border-color: var(--line);
}
.task-row:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.row-share {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--primary-border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--primary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.row-share:hover {
  background: var(--primary-weak);
}
.task-row.active {
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.task-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.task-main strong {
  overflow: hidden;
  font-size: var(--font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-row[data-status='completed'] .task-main strong {
  color: var(--text-3);
  text-decoration: line-through;
}
.task-main small {
  color: var(--text-3);
  font-size: var(--font-xs);
}
.status-chip {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
}
.status-chip[data-status='overdue'] {
  background: var(--danger-weak, #fef2f2);
  color: var(--danger, #b91c1c);
}
.status-chip[data-status='completed'] {
  background: var(--success-weak, #ecfdf5);
  color: var(--success, #047857);
}
.status-chip[data-status='in_progress'] {
  background: var(--primary-weak);
  color: var(--primary);
}
.wt-detail {
  padding: 16px 18px 24px;
  border-left: 1px solid var(--line);
  background: var(--bg-list);
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.detail-head h3 {
  margin: 2px 0 0;
  font-size: var(--font-md);
}
.detail-head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.detail-project {
  margin: 4px 0 12px;
  color: var(--text-3);
  font-size: var(--font-sm);
}
.detail-dates {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 0 0 12px;
}
.detail-dates dt {
  color: var(--text-3);
  font-size: var(--font-xs);
}
.detail-dates dd {
  margin: 2px 0 0;
  font-size: var(--font-sm);
}
.detail-desc {
  margin: 0 0 12px;
  color: var(--text-2);
  font-size: var(--font-sm);
  white-space: pre-wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  color: var(--text-3);
  font-size: var(--font-xs);
}
.field input,
.field select,
.field textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
  color: var(--text-1);
  font: inherit;
  font-size: var(--font-sm);
  resize: vertical;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.form-error {
  margin: 4px 0;
  color: var(--danger, #b91c1c);
  font-size: var(--font-xs);
}
.notice {
  margin: 10px 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
  color: var(--text-2);
  font-size: var(--font-xs);
}
.notice-warn {
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.share-panel {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.share-panel h4 {
  margin: 0 0 6px;
  font-size: var(--font-sm);
}
.peer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: var(--font-sm);
}
.peer-row small {
  color: var(--success, #047857);
  font-size: var(--font-xs);
}
.share-list {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.share-list h5 {
  margin: 0 0 6px;
  color: var(--text-3);
  font-size: var(--font-xs);
}
.share-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: var(--font-xs);
}
.share-entry small {
  color: var(--text-3);
}
.share-entry button {
  margin-left: auto;
}
@media (max-width: 1180px) {
  .wt-body {
    grid-template-columns: 180px minmax(240px, 1fr) minmax(250px, 310px);
  }
  .wt-header {
    padding: 44px 18px 12px;
  }
  .wt-list,
  .wt-detail {
    padding-left: 12px;
    padding-right: 12px;
  }
}
</style>
