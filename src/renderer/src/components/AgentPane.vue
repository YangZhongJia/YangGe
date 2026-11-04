<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NInput, NSelect } from 'naive-ui'
import PantryIcon from './PantryIcon.vue'
import type {
  AgentModelOption,
  AgentPermissionDecision,
  AgentSessionView,
  AgentTaskCreateInput,
  AgentTaskStatus,
  AgentView
} from '../../../shared/ipc'
import { useAgentStore } from '../stores/agent'
import { tr } from '../utils/i18n'

const store = useAgentStore()
const mode = ref<'tasks' | 'chat'>('tasks')
const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)

const showCreate = ref(false)
const repoPath = ref('')
const taskMode = ref<'git' | 'plain'>('git')
const taskPrompt = ref('')
const taskChatText = ref('')
const taskComposerEl = ref<HTMLElement | null>(null)
const coordinatorAgentId = ref<string | null>(null)
const teamAgentIds = ref<string[]>([])
const applyConfirmed = ref(false)
const showAgentSettings = ref(false)
const settingsAgentId = ref<string | null>(null)
const settingsDisplayName = ref('')
const settingsDescription = ref('')
const settingsInstructions = ref('')
const settingsModel = ref<string | null>('')
const settingsEnabled = ref(true)
const settingsModelState = computed(
  () =>
    (settingsAgentId.value ? store.agentModels[settingsAgentId.value] : undefined) ?? {
      loading: false,
      models: [] as AgentModelOption[],
      currentModel: '',
      error: ''
    }
)
const settingsModelOptions = computed(() => {
  const options = [{ label: tr('默认（CLI 默认模型）'), value: '' }]
  const seen = new Set<string>()
  for (const model of settingsModelState.value.models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    options.push({
      label: model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id,
      value: model.id
    })
  }
  const current = (settingsModel.value ?? '').trim()
  if (current.length > 0 && !seen.has(current)) options.push({ label: current, value: current })
  return options
})
const settingsError = ref('')
const settingsBusy = ref(false)

const active = computed(() => store.activeSession)
const permission = computed(() => store.activePermission)
const activeTask = computed(() => store.activeTask)
const activeTaskDetail = computed(() => store.activeTaskDetail)
const activeTaskPermission = computed(() => store.activeTaskPermission)
const taskDiff = computed(() => store.taskDiff)
const settingsAgent = computed(() =>
  store.agents.find((agent) => agent.id === settingsAgentId.value) ?? null
)

const statusLabel = computed(() => {
  const status = active.value?.status
  if (status === 'starting') return tr('启动中')
  if (status === 'idle') return tr('就绪')
  if (status === 'running') return tr('回复中')
  if (status === 'failed') return tr('已失败')
  if (status === 'closed') return tr('已关闭')
  return tr('未连接')
})

const canSend = computed(() => store.canSend && draft.value.trim().length > 0)
const coordinatorOptions = computed(() =>
  store.agents
    .filter((agent) => agent.enabled && !agent.probeError)
    .map((agent) => ({
      label: `${agentLabel(agent)} · ${agent.version || tr('版本未知')}`,
      value: agent.id
    }))
)
const teamOptions = computed(() =>
  store.agents
    .filter((agent) => agent.enabled && !agent.probeError && agent.id !== coordinatorAgentId.value)
    .map((agent) => ({ label: agentLabel(agent), value: agent.id }))
)
const canCreateTask = computed(() =>
  repoPath.value.trim().length > 0 &&
  taskPrompt.value.trim().length > 0 &&
  Boolean(coordinatorAgentId.value) &&
  teamAgentIds.value.length >= 2 &&
  !store.taskBusy
)

watch(activeTask, (task) => {
  if (task?.status !== 'completed') {
    applyConfirmed.value = false
    store.taskDiff = null
  }
})

watch(coordinatorAgentId, (agentId) => {
  if (agentId) teamAgentIds.value = teamAgentIds.value.filter((id) => id !== agentId)
})

function shortPath(path: string): string {
  if (path.length <= 64) return path
  return `${path.slice(0, 28)}…${path.slice(-32)}`
}

function taskStatus(status: AgentTaskStatus): string {
  const labels: Record<AgentTaskStatus, string> = {
    draft: '草稿',
    planning: '规划中',
    awaiting_approval: '等待计划确认',
    running: '执行中',
    review: '审查中',
    paused: '已暂停',
    completed: '待审查差异',
    failed: '可恢复',
    cancelled: '已取消'
  }
  return tr(labels[status])
}

function stepRoleLabel(role: string): string {
  if (role === 'research') return tr('调研')
  if (role === 'implement') return tr('实现')
  if (role === 'review') return tr('审查')
  return role
}

function stepStatusLabel(status: string): string {
  if (status === 'queued') return tr('待执行')
  if (status === 'running') return tr('执行中')
  if (status === 'awaiting_approval') return tr('待确认')
  if (status === 'completed') return tr('已完成')
  if (status === 'failed') return tr('已失败')
  if (status === 'cancelled') return tr('已取消')
  return status
}

function agentName(agentId: string): string {
  const agent = store.agents.find((item) => item.id === agentId)
  return agent ? agentLabel(agent) : agentId
}

function agentLabel(agent: AgentView): string {
  return agent.displayName.trim() || agent.name
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

async function scan(): Promise<void> {
  await store.scan()
}

async function pickCommand(): Promise<void> {
  const path = await window.pantry.pickAgentCommand()
  if (path) await store.addByPath(path)
}

async function create(agent: AgentView): Promise<void> {
  await store.newSession(agent.id)
}

async function pickCwdAndCreate(agent: AgentView): Promise<void> {
  const cwd = await window.pantry.pickAgentCwd()
  if (cwd) await store.newSession(agent.id, cwd)
}

function openAgentSettings(agent: AgentView): void {
  settingsAgentId.value = agent.id
  settingsDisplayName.value = agent.displayName
  settingsDescription.value = agent.description
  settingsInstructions.value = agent.instructions
  settingsModel.value = agent.model
  settingsEnabled.value = agent.enabled
  void store.loadAgentModels(agent.id)
  settingsError.value = ''
  showAgentSettings.value = true
}

function closeAgentSettings(): void {
  if (!settingsBusy.value) showAgentSettings.value = false
}

async function saveAgentSettings(): Promise<void> {
  const agent = settingsAgent.value
  if (!agent || settingsBusy.value) return
  settingsBusy.value = true
  settingsError.value = ''
  const saved = await store.updateAgentProfile({
    id: agent.id,
    displayName: settingsDisplayName.value.trim(),
    description: settingsDescription.value.trim(),
    instructions: settingsInstructions.value.trim(),
    model: (settingsModel.value ?? '').trim(),
    enabled: settingsEnabled.value
  })
  settingsBusy.value = false
  if (saved) showAgentSettings.value = false
  else settingsError.value = store.error || tr('保存失败')
}

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value
  draft.value = ''
  await store.send(text)
}

async function respond(decision: AgentPermissionDecision): Promise<void> {
  const request = permission.value
  if (!request) return
  await store.respondPermission(request.requestId, decision)
}

async function respondTaskPermission(decision: AgentPermissionDecision): Promise<void> {
  const event = activeTaskPermission.value
  if (!event) return
  await store.respondTaskPermission(
    event.taskId,
    event.request.requestId,
    decision
  )
}

function openCreate(): void {
  showCreate.value = true
  taskPrompt.value = ''
  repoPath.value = ''
  taskMode.value = 'git'
  store.taskError = ''
  if (!coordinatorAgentId.value) coordinatorAgentId.value = coordinatorOptions.value[0]?.value ?? null
  teamAgentIds.value = teamAgentIds.value.filter((id) => id !== coordinatorAgentId.value)
}

function closeCreate(): void {
  if (!store.taskBusy) showCreate.value = false
}

function toggleTeam(agentId: string, selected: boolean): void {
  if (selected) {
    if (!teamAgentIds.value.includes(agentId)) teamAgentIds.value.push(agentId)
  } else {
    teamAgentIds.value = teamAgentIds.value.filter((id) => id !== agentId)
  }
}

async function pickRepository(): Promise<void> {
  const selected = await window.pantry.pickDirectory()
  if (selected) repoPath.value = selected
}

async function sendTaskChat(): Promise<void> {
  const task = activeTask.value
  const text = taskChatText.value.trim()
  if (!task || !text || task.status === 'cancelled' || store.taskBusy) return
  taskChatText.value = ''
  await store.chatTask(task.id, text)
  await nextTick()
  taskComposerEl.value?.scrollIntoView({ block: 'nearest' })
}

async function createTask(): Promise<void> {
  if (!canCreateTask.value || !coordinatorAgentId.value) return
  const input: AgentTaskCreateInput = {
    repoPath: repoPath.value.trim(),
    prompt: taskPrompt.value.trim(),
    coordinatorAgentId: coordinatorAgentId.value,
    teamAgentIds: [...teamAgentIds.value],
    mode: taskMode.value
  }
  await store.createTask(input)
  if (!store.taskError) showCreate.value = false
}

async function selectTask(taskId: string): Promise<void> {
  applyConfirmed.value = false
  await store.selectTask(taskId)
}

async function loadDiff(taskId: string): Promise<void> {
  applyConfirmed.value = false
  await store.loadTaskDiff(taskId)
}

async function applyDiff(taskId: string): Promise<void> {
  if (!applyConfirmed.value || !taskDiff.value) return
  await store.applyTask(taskId)
  applyConfirmed.value = false
}

function statusText(session: AgentSessionView): string {
  if (session.status === 'starting') return tr('启动中')
  if (session.status === 'idle') return tr('就绪')
  if (session.status === 'running') return tr('回复中')
  if (session.status === 'failed') return tr('已失败')
  return tr('已关闭')
}

function scrollToEnd(): void {
  void nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  })
}

watch(
  () => store.activeTranscript.map((item) => `${item.kind}:${item.text.length}:${item.status}`).join('|'),
  scrollToEnd
)

onMounted(async () => {
  void store.initTasks()
  await store.init().catch(() => null)
  // 本次运行还没扫过、库里也没有 Agent 时自动扫一次：其他人刚装好阳鸽时不一定
  // 知道要先点「扫描」，否则面板会一直停在空列表。
  if (store.scannedAt === 0 && store.agents.length === 0 && !store.scanning) void store.scan()
})
</script>

<template>
  <div class="agent-app">
    <nav class="mode-rail" :aria-label="tr('Agent 模式')">
      <button
        type="button"
        class="mode-button"
        :class="{ active: mode === 'tasks' }"
        @click="mode = 'tasks'"
      >
        <PantryIcon name="list" :size="18" />
        <span>{{ tr('协作任务') }}</span>
      </button>
      <button
        type="button"
        class="mode-button"
        :class="{ active: mode === 'chat' }"
        @click="mode = 'chat'"
      >
        <PantryIcon name="chat" :size="18" />
        <span>{{ tr('单聊') }}</span>
      </button>
    </nav>

    <template v-if="mode === 'tasks'">
      <aside class="agent-side task-side">
        <div class="side-head">
          <div>
            <h2>{{ tr('协作任务') }}</h2>
          </div>
          <NButton size="tiny" type="primary" @click="openCreate">
            {{ tr('新建任务') }}
          </NButton>
        </div>

        <div v-if="store.tasks.length === 0" class="side-empty task-empty">
          <strong>{{ tr('还没有协作任务') }}</strong>
          <span>{{ tr('选择一个 Git 仓库，先看计划，再允许 Agent 动手。') }}</span>
        </div>
        <button
          v-for="task in store.tasks"
          :key="task.id"
          type="button"
          class="task-card"
          :class="{ active: task.id === store.activeTaskId }"
          @click="selectTask(task.id)"
        >
          <span class="task-card-title">{{ task.prompt }}</span>
          <span class="task-status" :data-status="task.status">{{ taskStatus(task.status) }}</span>
          <span class="task-card-meta">{{ formatTime(task.updatedAt) }} · {{ task.taskBranch }}</span>
        </button>

        <div class="task-agent-strip">
          <div class="strip-head">
            <span>{{ tr('本机 Agent') }}</span>
            <NButton size="tiny" secondary :loading="store.scanning" @click="scan">
              <PantryIcon name="refresh" :size="14" />
              {{ tr('扫描') }}
            </NButton>
          </div>
          <div v-if="store.agents.length === 0" class="side-empty">
            {{ tr('尚未发现可连接 Agent。') }}
          </div>
          <div v-for="agent in store.agents" :key="agent.id" class="mini-agent">
            <span class="agent-dot" :data-ready="!agent.probeError"></span>
            <span class="mini-agent-name" :title="agentLabel(agent)">{{ agentLabel(agent) }}</span>
            <small class="mini-agent-version" :title="agent.version || tr('版本未知')">{{ agent.version || tr('版本未知') }}</small>
            <button
              type="button"
              class="mini-settings"
              :title="tr('Agent 设置')"
              @click="openAgentSettings(agent)"
            >
              {{ tr('设置') }}
            </button>
          </div>
          <div
            v-for="client in store.clients.filter((item) => !item.adapterReady)"
            :key="client.id"
            class="cli-hint"
          >
            <span>{{ client.name }} · {{ tr('需要 ACP 适配器') }}</span>
            <code>{{ client.adapterCommand }}</code>
            <small>{{ tr('安装后重新扫描') }}</small>
          </div>
          <button type="button" class="manual-link" @click="pickCommand">
            {{ tr('添加 ACP 可执行文件…') }}
          </button>
        </div>
      </aside>

      <section class="agent-main task-main">
        <div v-if="store.taskError" class="error-bar" role="alert">
          <span>{{ store.taskError }}</span>
          <button type="button" :aria-label="tr('关闭提示')" @click="store.taskError = ''">×</button>
        </div>
        <div v-if="store.error" class="error-bar" role="alert">
          <span>{{ store.error }}</span>
          <button type="button" :aria-label="tr('关闭提示')" @click="store.error = ''">×</button>
        </div>

        <div v-if="showCreate" class="task-screen create-screen">
          <header class="screen-head">
            <div>
              <p class="eyebrow">NEW TASK</p>
              <h1>{{ tr('新建协作任务') }}</h1>
            </div>
            <NButton size="small" quaternary @click="closeCreate">{{ tr('取消') }}</NButton>
          </header>

          <div class="notice notice-warn" v-if="taskMode === 'git'">
            <strong>{{ tr('Git 仓库模式') }}</strong>
            <span>{{ tr('仓库必须干净，未提交改动需先提交或暂存。Agent 在隔离 worktree 中工作，改动经你确认后才应用。') }}</span>
          </div>
          <div class="notice" v-else>
            <strong>{{ tr('普通目录模式') }}</strong>
            <span>{{ tr('Agent 直接在该目录内工作，改动实时生效且没有版本回滚；请确保目录可修改。') }}</span>
          </div>
          <div class="notice">
            <strong>{{ tr('模型连接说明') }}</strong>
            <span>{{ tr('任务内容可能由对应 Agent CLI 发送给其模型供应商。阳鸽不读取或保存这些 CLI 的凭据。') }}</span>
          </div>

          <label class="field">
            <span>{{ tr('任务目标') }}</span>
            <NInput
              v-model:value="taskPrompt"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 9 }"
              :placeholder="tr('说明要实现或修复什么，并给出验收条件。')"
            />
          </label>

          <div class="field">
            <div class="workdir-head">
              <span>{{ tr('工作目录') }}</span>
              <div class="mode-switch">
                <button
                  type="button"
                  :class="{ on: taskMode === 'git' }"
                  @click="taskMode = 'git'"
                >
                  {{ tr('Git 仓库') }}
                </button>
                <button
                  type="button"
                  :class="{ on: taskMode === 'plain' }"
                  @click="taskMode = 'plain'"
                >
                  {{ tr('普通目录') }}
                </button>
              </div>
            </div>
            <div class="path-picker">
              <NInput
                :value="repoPath"
                readonly
                :placeholder="taskMode === 'git' ? tr('选择一个 Git 仓库') : tr('选择一个文件夹')"
              />
              <NButton secondary @click="pickRepository">
                {{ taskMode === 'git' ? tr('选择 Git 仓库') : tr('选择目录') }}
              </NButton>
            </div>
            <small v-if="taskMode === 'git'">
              {{ tr('任务会在阳鸽管理的 worktree 中执行，源分支保持不动。') }}
            </small>
            <small v-else>{{ tr('Agent 直接在此目录内工作，改动实时生效。') }}</small>
          </div>

          <div class="role-grid">
            <label class="field">
              <span>{{ tr('协调者') }}</span>
              <NSelect
                v-model:value="coordinatorAgentId"
                :options="coordinatorOptions"
                :placeholder="tr('选择协调者')"
              />
              <small>{{ tr('只负责拆解计划与分派，不加入执行团队。') }}</small>
            </label>
            <div class="field">
              <span>{{ tr('团队') }}</span>
              <div class="team-checklist">
                <NCheckbox
                  v-for="agent in teamOptions"
                  :key="agent.value"
                  :checked="teamAgentIds.includes(agent.value)"
                  @update:checked="toggleTeam(agent.value, $event)"
                >
                  {{ agent.label }}
                </NCheckbox>
              </div>
              <small>
                {{ taskMode === 'git'
                  ? tr('至少选择两个 Agent；实现者与最终审查者必须不同。')
                  : tr('至少选择两个 Agent；建议包含审查角色，改动无法整体回滚。') }}
              </small>
            </div>
          </div>

          <footer class="create-footer">
            <span>{{ tr('创建后会先规划，计划经你确认才执行。') }}</span>
            <NButton
              type="primary"
              :disabled="!canCreateTask"
              :loading="store.taskBusy"
              @click="createTask"
            >
              {{ tr('创建并生成计划') }}
            </NButton>
          </footer>
        </div>

        <div v-else-if="activeTask && activeTaskDetail" class="task-screen task-room">
          <header class="room-head">
            <div class="room-title">
              <p class="eyebrow" :title="activeTask.id">{{ activeTask.id.slice(0, 8) }}</p>
              <h1 :title="activeTask.prompt">{{ activeTask.prompt }}</h1>
              <span class="task-status large" :data-status="activeTask.status">
                {{ taskStatus(activeTask.status) }}
              </span>
            </div>
            <div class="room-actions">
              <NButton
                v-if="activeTask.status === 'draft' || (activeTask.status === 'failed' && !activeTask.plan)"
                type="primary"
                :loading="store.taskBusy"
                @click="store.startTask(activeTask.id)"
              >
                {{ tr('开始规划') }}
              </NButton>
              <NButton
                v-if="activeTask.status === 'awaiting_approval'"
                type="primary"
                :loading="store.taskBusy"
                @click="store.approvePlan(activeTask.id)"
              >
                {{ tr('批准计划并执行') }}
              </NButton>
              <NButton
                v-if="['planning', 'running', 'review'].includes(activeTask.status)"
                secondary
                :loading="store.taskBusy"
                @click="store.pauseTask(activeTask.id)"
              >
                {{ tr('暂停') }}
              </NButton>
              <NButton
                v-if="['paused', 'failed'].includes(activeTask.status) && activeTask.plan"
                type="primary"
                secondary
                :loading="store.taskBusy"
                @click="store.resumeTask(activeTask.id)"
              >
                {{ tr('恢复任务') }}
              </NButton>
              <NButton
                v-if="['planning', 'running', 'review', 'paused'].includes(activeTask.status)"
                type="error"
                secondary
                :loading="store.taskBusy"
                @click="store.cancelTask(activeTask.id)"
              >
                {{ tr('取消') }}
              </NButton>
              <NButton
                v-if="activeTask.status === 'completed'"
                type="primary"
                :loading="store.taskBusy"
                @click="loadDiff(activeTask.id)"
              >
                {{ tr('审查最终差异') }}
              </NButton>
              <NButton
                v-if="['draft', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled'].includes(activeTask.status)"
                quaternary
                @click="store.removeTaskWorktree(activeTask.id)"
              >
                {{ tr('清理 worktree') }}
              </NButton>
            </div>
          </header>

          <div class="room-grid">
            <section class="room-content">
              <div class="meta-panel">
                <div>
                  <span>{{ activeTask.mode === 'plain' ? tr('工作目录') : tr('源仓库') }}</span>
                  <code :title="activeTask.repoPath">{{ shortPath(activeTask.repoPath) }}</code>
                </div>
                <template v-if="activeTask.mode === 'git'">
                  <div>
                    <span>{{ tr('分支 / 基线') }}</span>
                    <code>{{ activeTask.sourceBranch }} @ {{ activeTask.baseCommit.slice(0, 10) }}</code>
                  </div>
                  <div>
                    <span>{{ tr('任务 worktree') }}</span>
                    <code>{{ activeTask.taskBranch }}</code>
                  </div>
                </template>
                <div v-else>
                  <span>{{ tr('模式') }}</span>
                  <strong>{{ tr('普通目录 · 改动直接生效') }}</strong>
                </div>
                <div>
                  <span>{{ tr('协调者') }}</span>
                  <strong>{{ agentName(activeTask.coordinatorAgentId) }}</strong>
                </div>
                <div>
                  <span>{{ tr('团队') }}</span>
                  <strong>{{ activeTask.teamAgentIds.map(agentName).join(' · ') }}</strong>
                </div>
              </div>

              <section v-if="activeTask.plan" class="panel plan-panel">
                <header>
                  <div>
                    <p class="eyebrow">PLAN</p>
                    <h2>{{ tr('协作计划') }}</h2>
                  </div>
                  <span v-if="activeTask.status === 'awaiting_approval'" class="approval-chip">
                    {{ tr('等待你批准') }}
                  </span>
                </header>
                <p class="plan-summary">{{ activeTask.plan.summary }}</p>
                <ol class="step-list">
                  <li
                    v-for="step in activeTaskDetail.steps"
                    :key="step.id"
                    class="step-row"
                    :data-status="step.status"
                  >
                    <span class="step-index">{{ step.ordinal + 1 }}</span>
                    <div>
                      <strong>{{ step.title }}</strong>
                      <span class="step-meta">
                        <span>{{ stepRoleLabel(step.role) }}</span>
                        <span>{{ agentName(step.agentId) }}</span>
                        <span class="step-state" :data-status="step.status">{{ stepStatusLabel(step.status) }}</span>
                      </span>
                      <small>{{ step.expectedOutput }}</small>
                    </div>
                  </li>
                </ol>
              </section>

              <section class="panel">
                <header>
                  <div>
                    <p class="eyebrow">TIMELINE</p>
                    <h2>{{ tr('任务时间线') }}</h2>
                  </div>
                  <NButton size="tiny" quaternary @click="store.loadTaskEvents(activeTask.id)">
                    {{ tr('刷新') }}
                  </NButton>
                </header>
                <div v-if="activeTaskDetail.events.length === 0" class="panel-empty">
                  {{ tr('还没有时间线记录') }}
                </div>
                <div class="timeline">
                  <article
                    v-for="event in activeTaskDetail.events"
                    :key="event.id"
                    class="timeline-item"
                    :data-kind="event.kind"
                    :class="{ 'chat-item': event.kind === 'chat.user' || event.kind === 'chat.coordinator' }"
                  >
                    <template v-if="event.kind === 'chat.user'">
                      <div class="chat-bubble user">{{ event.text }}</div>
                    </template>
                    <template v-else-if="event.kind === 'chat.coordinator'">
                      <div class="chat-bubble coordinator">
                        <span class="chat-author">
                          {{ event.agentId ? agentName(event.agentId) : tr('统筹者') }} · {{ formatTime(event.createdAt) }}
                        </span>
                        <p>{{ event.text }}</p>
                      </div>
                    </template>
                    <template v-else>
                      <div class="timeline-head">
                        <span>{{ event.kind }}</span>
                        <span>{{ event.agentId ? agentName(event.agentId) : tr('系统') }}</span>
                        <time>{{ formatTime(event.createdAt) }}</time>
                      </div>
                      <details v-if="event.kind.endsWith('_request')">
                        <summary>{{ tr('查看交给 Agent 的完整任务') }}</summary>
                        <pre>{{ event.text }}</pre>
                      </details>
                      <p v-else>{{ event.text }}</p>
                    </template>
                  </article>
                </div>
              </section>

              <div ref="taskComposerEl" class="task-chat-composer">
                <NInput
                  v-model:value="taskChatText"
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 5 }"
                  :placeholder="tr('在群里发消息给统筹者…')"
                  @keydown.enter.exact.prevent="sendTaskChat"
                />
                <div class="composer-actions">
                  <small>{{ tr('Enter 发送，Shift+Enter 换行') }}</small>
                  <NButton
                    type="primary"
                    :disabled="!taskChatText.trim() || activeTask.status === 'cancelled'"
                    :loading="store.taskBusy"
                    @click="sendTaskChat"
                  >
                    {{ tr('发送') }}
                  </NButton>
                </div>
              </div>
            </section>

            <aside class="room-aside">
              <div class="context-card">
                <p class="eyebrow">ISOLATION</p>
                <h3>{{ tr('改动隔离') }}</h3>
                <p>{{ tr('Agent 仅在任务 worktree 中写入。应用前会再次检查源分支、HEAD 和工作区是否仍然安全。') }}</p>
                <code :title="activeTask.worktreePath">{{ shortPath(activeTask.worktreePath) }}</code>
              </div>
              <div class="context-card">
                <p class="eyebrow">REVIEW</p>
                <h3>{{ tr('不留提交') }}</h3>
                <p>{{ tr('任务完成后先看文件和 diff。阳鸽只应用补丁，不自动 commit、merge 或 push。') }}</p>
              </div>
            </aside>
          </div>

          <section v-if="taskDiff" class="diff-panel">
            <header>
              <div>
                <p class="eyebrow">FINAL DIFF</p>
                <h2>{{ tr('最终差异') }}</h2>
              </div>
              <span>{{ taskDiff.changedFiles.length }} {{ tr('个文件') }} · {{ Math.ceil(taskDiff.bytes / 1024) }} KB</span>
            </header>
            <div v-if="taskDiff.truncated" class="notice notice-warn">
              {{ tr('差异过大，界面只展示前 16 MB；应用操作仍按完整补丁执行。') }}
            </div>
            <div class="changed-files">
              <code v-for="file in taskDiff.changedFiles" :key="file">{{ file }}</code>
            </div>
            <pre class="diff-code">{{ taskDiff.patch }}</pre>
            <footer v-if="activeTask.status === 'completed'" class="apply-bar">
              <NCheckbox v-model:checked="applyConfirmed">
                {{ tr('我已检查以上差异，并确认应用到源仓库') }}
              </NCheckbox>
              <NButton
                type="primary"
                :disabled="!applyConfirmed"
                :loading="store.taskBusy"
                @click="applyDiff(activeTask.id)"
              >
                {{ tr('应用补丁') }}
              </NButton>
            </footer>
          </section>
        </div>

        <div v-else class="transcript-empty task-welcome">
          <p>{{ tr('选择一个 Git 仓库或普通文件夹，让 Agent 团队规划、实现并审查。') }}</p>
          <NButton type="primary" @click="openCreate">{{ tr('新建协作任务') }}</NButton>
        </div>
      </section>
    </template>

    <template v-else-if="mode === 'chat'">
      <aside class="agent-side chat-side">
        <div class="agent-library-head">
          <div class="agent-library-title">
            <h2>{{ tr('本机 Agent') }}</h2>
            <span class="agent-count">{{ store.agents.length }}</span>
          </div>
          <NButton size="tiny" secondary :loading="store.scanning" @click="scan">
            <PantryIcon name="refresh" :size="14" />
            {{ tr('扫描') }}
          </NButton>
        </div>
        <NButton class="add-agent-button" type="primary" secondary block @click="pickCommand">
          <PantryIcon name="plus" :size="16" />
          {{ tr('添加 ACP 可执行文件…') }}
        </NButton>

        <div v-if="store.agents.length === 0" class="agent-empty">
          <strong>{{ tr('还没有本机 Agent') }}</strong>
          <span>{{ tr('扫描已安装的 ACP 工具，或手动添加可执行文件。') }}</span>
        </div>
        <div v-else class="agent-list">
          <article v-for="agent in store.agents" :key="agent.id" class="agent-card">
            <div class="agent-card-head">
              <span class="agent-dot" :data-ready="!agent.probeError && agent.enabled"></span>
              <div class="agent-identity">
                <strong class="agent-name">{{ agentLabel(agent) }}</strong>
                <span class="agent-version" :class="{ 'probe-error': agent.probeError }" :title="agent.probeError">
                  {{ agent.probeError ? tr('探测失败') : agent.version || tr('版本未知') }}
                </span>
              </div>
              <button
                type="button"
                class="agent-settings-button"
                :title="tr('Agent 设置')"
                :aria-label="tr('Agent 设置')"
                @click="openAgentSettings(agent)"
              >
                <PantryIcon name="settings" :size="15" />
              </button>
            </div>
            <div class="agent-path" :title="agent.command">{{ shortPath(agent.command) }}</div>
            <p v-if="agent.description.trim()" class="agent-description">
              {{ agent.description }}
            </p>
            <div class="agent-badges">
              <span v-if="!agent.enabled" class="agent-badge">{{ tr('已停用') }}</span>
              <span v-if="agent.model" class="agent-badge model-badge" :title="agent.model">{{ agent.model }}</span>
              <span v-if="agent.instructions.trim()" class="agent-badge">{{ tr('已配置提示词') }}</span>
            </div>
            <div class="agent-actions">
              <NButton size="small" type="primary" secondary @click="create(agent)">
                {{ tr('新建会话') }}
              </NButton>
              <NButton size="small" quaternary @click="pickCwdAndCreate(agent)">
                {{ tr('选择目录') }}
              </NButton>
            </div>
          </article>
        </div>

        <div
          v-for="client in store.clients.filter((item) => !item.adapterReady)"
          :key="client.id"
          class="cli-hint"
        >
          <span>{{ client.name }} · {{ tr('需要 ACP 适配器') }}</span>
          <code>{{ client.adapterCommand }}</code>
          <small>{{ tr('安装后重新扫描') }}</small>
        </div>

        <div class="side-head sessions-head">
          <h2>{{ tr('会话') }}</h2>
          <span class="agent-count">{{ store.sessions.length }}</span>
        </div>
        <div v-if="store.sessions.length === 0" class="side-empty">{{ tr('还没有 Agent 会话') }}</div>
        <button
          v-for="session in store.sessions"
          :key="session.id"
          type="button"
          class="session-item"
          :class="{ active: session.id === store.activeSessionId }"
          @click="store.selectSession(session.id)"
        >
          <span class="session-name">{{ session.agentName }}</span>
          <span class="session-status" :data-status="session.status">{{ statusText(session) }}</span>
          <span class="session-cwd" :title="session.cwd">{{ shortPath(session.cwd) }}</span>
        </button>
      </aside>

      <section class="agent-main">
        <header v-if="active" class="main-head">
          <div class="main-title">
            <strong>{{ active.agentName }}</strong>
            <span class="badge" :data-status="active.status">{{ statusLabel }}</span>
          </div>
          <div class="main-sub" :title="active.cwd">{{ shortPath(active.cwd) }}</div>
          <div class="main-actions">
            <NButton v-if="active.status === 'running'" size="tiny" secondary @click="store.stop()">
              {{ tr('停止') }}
            </NButton>
            <NButton size="tiny" quaternary @click="store.closeSession()">
              {{ tr('关闭会话') }}
            </NButton>
          </div>
        </header>

        <div v-if="store.error" class="error-bar" role="alert">
          <span>{{ store.error }}</span>
          <button type="button" :aria-label="tr('关闭提示')" @click="store.error = ''">×</button>
        </div>

        <div ref="scrollEl" class="transcript">
          <div v-if="!active" class="transcript-empty">
            <p>{{ tr('选择一个 Agent 新建会话，或从左侧继续已有会话。') }}</p>
            <p class="muted">{{ tr('Agent 只在本机运行；默认拒绝工具权限，需你逐次确认。') }}</p>
          </div>
          <template v-for="item in store.activeTranscript" :key="item.id">
            <div v-if="item.kind === 'user'" class="bubble user">{{ item.text }}</div>
            <div v-else-if="item.kind === 'agent'" class="bubble agent">{{ item.text }}</div>
            <details v-else-if="item.kind === 'thought'" class="thought">
              <summary>{{ tr('思考过程') }}</summary>
              <pre>{{ item.text }}</pre>
            </details>
            <div v-else-if="item.kind === 'tool'" class="tool-card">
              <div class="tool-head">
                <span class="tool-status" :data-status="item.status">{{ item.status || 'pending' }}</span>
                <span class="tool-title">{{ item.title }}</span>
              </div>
              <pre v-if="item.text" class="tool-output">{{ item.text }}</pre>
            </div>
            <pre v-else-if="item.kind === 'plan'" class="plan">{{ item.text }}</pre>
            <div v-else class="system-line">{{ item.text }}</div>
          </template>
        </div>

        <div
          v-if="active && active.status !== 'closed' && active.status !== 'failed'"
          class="composer"
        >
          <textarea
            v-model="draft"
            rows="2"
            :placeholder="store.canSend ? tr('给 Agent 发消息，Enter 发送，Shift+Enter 换行') : tr('等待当前回复结束…')"
            :disabled="!store.canSend"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <NButton type="primary" size="small" :disabled="!canSend" :loading="store.busy" @click="send">
            {{ tr('发送') }}
          </NButton>
        </div>
      </section>
    </template>

    <div
      v-if="showAgentSettings && settingsAgent"
      class="agent-settings-mask"
      @click.self="closeAgentSettings"
    >
      <section
        class="agent-settings-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
      >
        <header class="agent-settings-head">
          <div>
            <p class="eyebrow">AGENT PROFILE</p>
            <h3 id="agent-settings-title">{{ tr('Agent 设置') }}</h3>
            <span>{{ settingsAgent.name }}</span>
          </div>
          <button
            type="button"
            :aria-label="tr('关闭')"
            :disabled="settingsBusy"
            @click="closeAgentSettings"
          >
            ×
          </button>
        </header>

        <div class="agent-settings-body">
          <label class="settings-field">
            <span>{{ tr('显示名称') }}</span>
            <NInput
              v-model:value="settingsDisplayName"
              :maxlength="80"
              :placeholder="settingsAgent.name"
            />
          </label>

          <label class="settings-field">
            <span>{{ tr('模型') }}</span>
            <NSelect
              v-model:value="settingsModel"
              :options="settingsModelOptions"
              :loading="settingsModelState.loading"
              filterable
              clearable
              :placeholder="tr('默认（CLI 默认模型）')"
            />
            <small v-if="settingsModelState.error" class="model-error">
              {{ settingsModelState.error }}
            </small>
          </label>

          <label class="settings-field">
            <span>{{ tr('简介') }}</span>
            <NInput
              v-model:value="settingsDescription"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 6 }"
              :maxlength="1000"
              :placeholder="tr('说明这个 Agent 擅长什么、适合承担什么角色。')"
            />
          </label>

          <label class="settings-field">
            <span>{{ tr('角色提示词') }}</span>
            <NInput
              v-model:value="settingsInstructions"
              type="textarea"
              :autosize="{ minRows: 7, maxRows: 14 }"
              :maxlength="16000"
              :placeholder="tr('例如：优先编写测试，修改前先说明影响范围，不要改动无关文件。')"
            />
          </label>

          <NCheckbox v-model:checked="settingsEnabled">
            {{ tr('启用此 Agent') }}
          </NCheckbox>

          <div class="settings-notice">
            {{ tr('角色提示词会随任务内容发送给该 CLI 配置的模型供应商；它不是工具授权，也不是系统沙箱。') }}
          </div>
          <div v-if="settingsError" class="settings-error" role="alert">{{ settingsError }}</div>
        </div>

        <footer class="agent-settings-actions">
          <NButton secondary :disabled="settingsBusy" @click="closeAgentSettings">
            {{ tr('取消') }}
          </NButton>
          <NButton type="primary" :loading="settingsBusy" @click="saveAgentSettings">
            {{ tr('保存设置') }}
          </NButton>
        </footer>
      </section>
    </div>

    <div
      v-if="mode === 'tasks' && activeTaskPermission"
      class="permission-mask"
      @click.self="respondTaskPermission('reject_once')"
    >
      <div class="permission-card" role="dialog" aria-modal="true" aria-labelledby="task-permission-title">
        <p class="eyebrow">TASK PERMISSION</p>
        <h3 id="task-permission-title">{{ tr('Agent 请求任务工具权限') }}</h3>
        <p class="permission-untrusted">
          {{ tr('以下内容由 Agent 自报，可能不准确；请核对后再决定。') }}
        </p>
        <div class="permission-title">
          {{ activeTaskPermission.request.title || tr('未命名工具调用') }}
        </div>
        <div class="permission-kind">
          {{ activeTaskPermission.request.toolKind || activeTaskPermission.request.status || tr('未知类型') }}
        </div>
        <ul v-if="activeTaskPermission.request.locations.length" class="permission-paths">
          <li v-for="(location, index) in activeTaskPermission.request.locations" :key="index">
            <code>{{ location.path }}<template v-if="location.line">:{{ location.line }}</template></code>
          </li>
        </ul>
        <pre v-if="activeTaskPermission.request.command" class="permission-command">
{{ activeTaskPermission.request.command }}
        </pre>
        <div class="permission-actions">
          <NButton size="small" secondary @click="respondTaskPermission('reject_once')">
            {{ tr('拒绝') }}
          </NButton>
          <NButton size="small" secondary type="warning" @click="respondTaskPermission('reject_session')">
            {{ tr('本任务拒绝') }}
          </NButton>
          <NButton size="small" secondary type="primary" @click="respondTaskPermission('allow_session')">
            {{ tr('本任务允许') }}
          </NButton>
          <NButton size="small" type="primary" @click="respondTaskPermission('allow_once')">
            {{ tr('允许一次') }}
          </NButton>
        </div>
      </div>
    </div>

    <div v-if="mode === 'chat' && permission" class="permission-mask" @click.self="respond('reject_once')">
      <div class="permission-card" role="dialog" aria-modal="true" aria-labelledby="agent-permission-title">
        <h3 id="agent-permission-title">{{ tr('Agent 请求工具权限') }}</h3>
        <p class="permission-untrusted">
          {{ tr('以下内容由 Agent 自报，可能不准确；请核对后再决定。') }}
        </p>
        <div class="permission-title">{{ permission.title || tr('未命名工具调用') }}</div>
        <div class="permission-kind">{{ permission.toolKind || permission.status || tr('未知类型') }}</div>
        <ul v-if="permission.locations.length" class="permission-paths">
          <li v-for="(location, index) in permission.locations" :key="index">
            <code>{{ location.path }}<template v-if="location.line">:{{ location.line }}</template></code>
          </li>
        </ul>
        <pre v-if="permission.command" class="permission-command">{{ permission.command }}</pre>
        <div class="permission-options">
          <span v-for="option in permission.options" :key="option.optionId" class="option-chip">
            {{ option.kind }}
          </span>
        </div>
        <div class="permission-actions">
          <NButton size="small" secondary @click="respond('reject_once')">
            {{ tr('拒绝') }}
          </NButton>
          <NButton size="small" secondary type="warning" @click="respond('allow_session')">
            {{ tr('本会话允许') }}
          </NButton>
          <NButton size="small" type="primary" @click="respond('allow_once')">
            {{ tr('允许一次') }}
          </NButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-app {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg-chat);
}

.mode-rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 92px;
  flex-shrink: 0;
  padding: 14px 8px;
  background: var(--bg-window);
  border-right: 1px solid var(--line);
}


.mode-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 11px 4px;
  margin-bottom: 6px;
  font: inherit;
  font-size: var(--font-xs);
  white-space: nowrap;
  color: var(--text-3);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
}

.mode-button:hover {
  color: var(--text-1);
  background: var(--bg-list);
}

.mode-button.active {
  color: var(--primary);
  background: var(--primary-weak);
  border-color: var(--primary-border);
}


.agent-side {
  display: flex;
  flex-direction: column;
  width: 292px;
  flex-shrink: 0;
  min-height: 0;
  /* 顶部 32px 是窗口拖拽/控制条，内容从安全间距下开始。 */
  padding: 46px 12px 14px;
  overflow-y: auto;
  background: var(--bg-list);
  border-right: 1px solid var(--line);
}

.chat-side {
  padding: 46px 12px 16px;
}

.agent-library-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.agent-library-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.agent-library-title h2 {
  margin: 0;
  color: var(--text-1);
  font-size: var(--font-md);
  font-weight: 650;
}

.agent-count {
  display: inline-grid;
  min-width: 20px;
  height: 20px;
  place-items: center;
  padding: 0 6px;
  color: var(--text-2);
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}


.add-agent-button {
  margin: 8px 0 4px;
}

.agent-empty {
  display: grid;
  gap: 5px;
  margin-top: 12px;
  padding: 16px 13px;
  color: var(--text-2);
  background: var(--bg-window);
  border: 1px dashed var(--line);
  border-radius: var(--radius-control);
  font-size: var(--font-xs);
  line-height: 1.5;
}

.agent-empty strong {
  color: var(--text-1);
  font-size: var(--font-sm);
}

.task-side {
  width: 316px;
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.side-head h2,
.strip-head span {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 650;
  color: var(--text-2);
}

.eyebrow {
  margin: 0 0 4px;
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.16em;
  color: var(--text-3);
}

.sessions-head {
  margin-top: 18px;
}


.manual-link {
  align-self: flex-start;
  padding: 2px 0;
  font-size: var(--font-xs);
  color: var(--primary);
  background: none;
  border: 0;
  cursor: pointer;
}

.side-empty {
  margin-top: 12px;
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-3);
}

.task-empty {
  display: grid;
  gap: 4px;
  padding: 14px;
  color: var(--text-2);
  background: var(--bg-input);
  border: 1px dashed var(--line);
  border-radius: var(--radius-control);
}

.task-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 8px;
  width: 100%;
  margin-top: 8px;
  padding: 11px;
  font: inherit;
  text-align: left;
  color: var(--text-1);
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.task-card:hover,
.task-card.active {
  border-color: var(--primary-border);
}

.task-card.active {
  background: var(--primary-weak);
}

.task-card-title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-status {
  align-self: start;
  padding: 1px 7px;
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: var(--radius-pill);
}

.task-status.large {
  padding: 3px 10px;
  font-size: var(--font-xs);
}

.task-status[data-status='running'],
.task-status[data-status='review'],
.task-status[data-status='planning'] {
  color: var(--primary);
  background: var(--primary-weak);
}

.task-status[data-status='failed'] {
  color: var(--danger, #b91c1c);
  background: var(--danger-weak, #fef2f2);
}

.task-status[data-status='completed'] {
  color: var(--success, #047857);
  background: var(--success-weak, #ecfdf5);
}
.task-status[data-status='awaiting_approval'],
.task-status[data-status='paused'] {
  color: var(--warning, #b45309);
  background: var(--warning-weak, #fffbeb);
}

.task-card-meta {
  grid-column: 1 / -1;
  overflow: hidden;
  font-size: 10px;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-agent-strip {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.strip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}

.strip-head button {
  font: inherit;
  font-size: 10px;
  color: var(--primary);
  background: none;
  border: 0;
  cursor: pointer;
}

.mini-agent {
  display: grid;
  grid-template-columns: auto minmax(70px, 1fr) minmax(0, 90px) auto;
  align-items: center;
  gap: 6px;
  padding: 5px 2px;
  font-size: var(--font-xs);
  color: var(--text-2);
}

.mini-agent-name,
.mini-agent-version {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini-agent small {
  font-size: 11px;
  color: var(--text-3);
}

.mini-settings {
  padding: 1px 0;
  font: inherit;
  color: var(--primary);
  background: none;
  border: 0;
  cursor: pointer;
}

.agent-dot {
  width: 6px;
  height: 6px;
  background: var(--text-3);
  border-radius: 50%;
}

.agent-dot[data-ready='true'] {
  background: #16a36a;
}

.cli-hint {
  display: grid;
  gap: 3px;
  margin-top: 8px;
  padding: 8px 10px;
  font-size: var(--font-xs);
  color: var(--text-2);
  background: var(--bg-window);
  border: 1px dashed var(--line);
  border-radius: var(--radius-control);
}

.cli-hint code {
  color: var(--primary);
}

.cli-hint small {
  font-size: 10px;
  color: var(--text-3);
}

.probe-error {
  color: var(--warning, #b45309);
}


.agent-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.agent-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 11px 10px 10px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}

.agent-card:hover {
  border-color: var(--primary-border);
  box-shadow: var(--shadow-soft);
}

.agent-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.agent-card-head .agent-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
}

.agent-identity {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
}

.agent-name {
  overflow: hidden;
  color: var(--text-1);
  font-size: var(--font-sm);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-version {
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-settings-button {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.agent-settings-button:hover {
  color: var(--primary);
  background: var(--primary-weak);
  border-color: var(--primary-border);
}

.agent-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.agent-path {
  min-width: 0;
  margin-top: 0;
  overflow: hidden;
  padding: 4px 7px;
  background: var(--bg-list);
  border-radius: 5px;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-description {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 11px;
}

.agent-badges {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  gap: 5px;
}

.agent-badge {
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
  padding: 2px 7px;
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: var(--radius-pill);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-badge {
  color: var(--primary);
  background: var(--primary-weak);
}

.agent-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
  margin: 0;
}

.agent-actions > :deep(button) {
  width: 100%;
  min-width: 0;
  justify-content: center;
}

.sessions-head {
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

.sessions-head h2 {
  color: var(--text-1);
}
.agent-settings-mask {
  position: fixed;
  inset: 0;
  z-index: 1350;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--scrim);
}

.model-error {
  color: var(--danger);
}
.agent-settings-card {
  display: flex;
  flex-direction: column;
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 40px);
  overflow: hidden;
  color: var(--text-1);
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
}

.agent-settings-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--line);
}

.agent-settings-head h3 {
  margin: 3px 0 2px;
  font-size: var(--font-lg);
}

.agent-settings-head span {
  font-size: var(--font-xs);
  color: var(--text-3);
}

.agent-settings-head button {
  width: 28px;
  height: 28px;
  font-size: 20px;
  line-height: 1;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.agent-settings-head button:hover {
  color: var(--text-1);
  background: var(--bg-list);
}

.agent-settings-body {
  display: grid;
  gap: 16px;
  padding: 18px 20px;
  overflow-y: auto;
}

.settings-field {
  display: grid;
  gap: 7px;
  font-size: var(--font-sm);
}

.settings-field > span {
  font-weight: 600;
}

.settings-field small {
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-3);
}

.settings-notice {
  padding: 10px 12px;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-2);
  background: var(--primary-weak);
  border: 1px solid var(--primary-border);
  border-radius: var(--radius-control);
}

.settings-error {
  font-size: var(--font-xs);
  color: var(--danger);
}

.agent-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 13px 20px;
  border-top: 1px solid var(--line);
}

.session-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  width: 100%;
  margin-top: 6px;
  padding: 8px;
  font: inherit;
  text-align: left;
  color: var(--text-1);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.session-item:hover {
  background: var(--bg-input);
}

.session-item.active {
  background: var(--primary-weak);
  border-color: var(--primary-border);
}

.session-name {
  overflow: hidden;
  font-size: var(--font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-status {
  font-size: var(--font-xs);
  color: var(--text-3);
}

.session-status[data-status='running'] {
  color: var(--primary);
}

.session-status[data-status='failed'] {
  color: var(--danger, #dc2626);
}

.session-cwd {
  grid-column: 1 / -1;
  overflow: hidden;
  font-size: 11px;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.task-main {
  background:
    radial-gradient(circle at 90% 0%, color-mix(in srgb, var(--primary) 8%, transparent), transparent 32%),
    var(--bg-chat);
}

.task-screen {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.create-screen {
  width: min(940px, 100%);
  margin: 0 auto;
  padding: 46px 32px 56px;
}

.screen-head,
.room-head,
.panel header,
.diff-panel header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.screen-head h1,
.room-head h1,
.diff-panel h2,
.panel h2 {
  margin: 0;
  color: var(--text-1);
}

.screen-head h1,
.room-head h1 {
  font-size: clamp(20px, 2.4vw, 30px);
  line-height: 1.18;
}

.notice {
  display: grid;
  gap: 3px;
  margin-top: 14px;
  padding: 12px 14px;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-2);
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
}

.notice strong {
  color: var(--text-1);
}

.notice-warn {
  border-left: 3px solid var(--warning, #d97706);
}

.field {
  display: grid;
  gap: 7px;
  margin-top: 18px;
}

.field > span {
  font-size: var(--font-sm);
  font-weight: 650;
  color: var(--text-1);
}

.field small {
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-3);
}

.path-picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.workdir-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mode-switch {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-list);
  border-radius: var(--r-control);
}

.mode-switch button {
  padding: 3px 10px;
  font: inherit;
  font-size: var(--font-xs);
  color: var(--text-3);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}

.mode-switch button.on {
  color: var(--primary);
  font-weight: 600;
  background: var(--bg-window);
  box-shadow: 0 1px 3px rgba(15, 18, 30, 0.12);
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.team-checklist {
  display: grid;
  gap: 7px;
  min-height: 70px;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
}

.create-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.create-footer span {
  font-size: var(--font-xs);
  color: var(--text-3);
}

.room-head {
  position: sticky;
  top: 0;
  z-index: 4;
  align-items: center;
  padding: 46px 24px 18px;
  background: color-mix(in srgb, var(--bg-chat) 92%, transparent);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(12px);
}

.room-title {
  min-width: 0;
}

.room-title h1 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: var(--font-lg);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.room-title .task-status {
  display: inline-block;
  vertical-align: middle;
}

.room-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.room-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  gap: 18px;
  padding: 18px 24px 8px;
}

.room-content {
  min-width: 0;
}

.room-aside {
  display: grid;
  align-content: start;
  gap: 12px;
}

.context-card,
.panel,
.diff-panel {
  padding: 16px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.context-card h3,
.panel h2,
.diff-panel h2 {
  margin: 0;
  font-size: var(--font-md);
}

.context-card p:not(.eyebrow) {
  margin: 8px 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-2);
}

.context-card code,
.meta-panel code,
.changed-files code {
  overflow-wrap: anywhere;
  font-size: 10px;
  color: var(--text-3);
}

.meta-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 14px;
  overflow: hidden;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}

.meta-panel > div {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--bg-window);
}

.meta-panel span {
  font-size: 10px;
  color: var(--text-3);
}

.meta-panel strong {
  overflow: hidden;
  font-size: var(--font-xs);
  color: var(--text-1);
  text-overflow: ellipsis;
}

.panel,
.diff-panel {
  margin-bottom: 14px;
}

.plan-panel {
  border-color: var(--primary-border);
}

.approval-chip {
  padding: 3px 9px;
  font-size: var(--font-xs);
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: var(--radius-pill);
}

.plan-summary {
  margin: 12px 0;
  color: var(--text-2);
  line-height: 1.6;
}

.step-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  background: var(--bg-input);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}

.step-row[data-status='running'],
.step-row[data-status='awaiting_approval'] {
  border-color: var(--primary-border);
}

.step-index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 50%;
}

.step-row > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.step-row strong {
  font-size: var(--font-sm);
}

.step-row span,
.step-row small {
  font-size: 10px;
  color: var(--text-3);
}
.step-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.step-meta > span {
  padding: 2px 6px;
  border-radius: var(--radius-control);
  background: var(--bg-list);
  color: var(--text-2);
}
.step-meta .step-state[data-status='completed'] { color: var(--success, #047857); }
.step-meta .step-state[data-status='failed'] { color: var(--danger, #b91c1c); }
.step-meta .step-state[data-status='running'] { color: var(--primary); }

.panel-empty {
  padding: 28px 0;
  font-size: var(--font-xs);
  color: var(--text-3);
  text-align: center;
}

.timeline {
  position: relative;
  display: grid;
  gap: 9px;
  margin-top: 12px;
}

.timeline-item {
  padding: 10px 12px;
  background: var(--bg-input);
  border-left: 2px solid var(--line);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}

.timeline-item.chat-item {
  padding: 2px 0;
}
.chat-bubble {
  width: fit-content;
  max-width: 86%;
  padding: 8px 12px;
  border-radius: var(--radius-panel);
  font-size: var(--font-sm);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-bubble.user {
  margin-left: auto;
  background: var(--primary);
  color: var(--on-primary);
}
.chat-bubble.coordinator {
  background: var(--bg-window);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-soft);
}
.chat-bubble.coordinator p {
  margin: 0;
}
.chat-author {
  display: block;
  margin-bottom: 4px;
  color: var(--text-3);
  font-size: 11px;
}
.task-chat-composer {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0 6px;
  background: var(--bg-chat);
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.composer-actions small {
  color: var(--text-3);
}
.timeline-item[data-kind='error'] {
  border-left-color: var(--danger, #dc2626);
}

.timeline-item[data-kind='plan'],
.timeline-item[data-kind='recovery'] {
  border-left-color: var(--primary);
}

.timeline-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 9px;
  color: var(--text-3);
}

.timeline-head span:first-child {
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-2);
}

.timeline-item p,
.timeline-item pre {
  margin: 7px 0 0;
  font: inherit;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.timeline-item summary {
  margin-top: 7px;
  font-size: 10px;
  color: var(--primary);
  cursor: pointer;
}

.diff-panel {
  margin: 8px 24px 24px;
}

.changed-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.changed-files code {
  padding: 4px 7px;
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: 5px;
}

.diff-code {
  max-height: 55vh;
  margin: 12px 0 0;
  padding: 14px;
  overflow: auto;
  font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-1);
  background: var(--bg-list);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
}

.apply-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.task-welcome {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 14px;
  margin: 0;
  color: var(--text-2);
}

.main-head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  padding: 12px 18px;
  background: var(--bg-window);
  border-bottom: 1px solid var(--line);
}

.main-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.main-title strong {
  overflow: hidden;
  font-size: var(--font-md);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  padding: 1px 7px;
  font-size: var(--font-xs);
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: var(--radius-pill);
}

.badge[data-status='running'] {
  color: var(--primary);
  background: var(--primary-weak);
}

.badge[data-status='failed'] {
  color: var(--danger, #dc2626);
}

.main-sub {
  grid-column: 1;
  overflow: hidden;
  font-size: var(--font-xs);
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-actions {
  grid-row: 1 / span 2;
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 6px;
}

.error-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 18px;
  font-size: var(--font-sm);
  color: var(--danger, #b91c1c);
  background: var(--danger-weak, #fef2f2);
  border-bottom: 1px solid var(--line);
}

.error-bar button {
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.transcript {
  flex: 1;
  min-height: 0;
  padding: 18px;
  overflow-y: auto;
}

.transcript-empty {
  margin-top: 12vh;
  text-align: center;
  color: var(--text-2);
}

.transcript-empty .muted {
  margin-top: 8px;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.bubble {
  max-width: min(76%, 720px);
  margin-bottom: 10px;
  padding: 9px 12px;
  font-size: var(--font-md);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: var(--radius-panel);
}

.bubble.user {
  margin-left: auto;
  color: var(--on-primary);
  background: var(--bubble-mine);
}

.bubble.agent {
  color: var(--text-1);
  background: var(--bubble-peer);
  border: 1px solid var(--line);
}

.thought {
  max-width: min(76%, 720px);
  margin-bottom: 10px;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.thought pre,
.tool-output,
.permission-command {
  margin: 6px 0 0;
  padding: 8px;
  overflow-x: auto;
  font-size: var(--font-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg-list);
  border-radius: var(--radius-control);
}

.tool-card {
  max-width: min(86%, 820px);
  margin-bottom: 10px;
  padding: 9px 12px;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-left: 3px solid var(--primary-border);
  border-radius: var(--radius-control);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-status {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: var(--radius-pill);
}

.tool-status[data-status='completed'] {
  color: #047857;
  background: #ecfdf5;
}

.tool-status[data-status='failed'] {
  color: #b91c1c;
  background: #fef2f2;
}

.tool-title {
  overflow: hidden;
  font-size: var(--font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan {
  margin: 0 0 10px;
  padding: 8px 12px;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  background: var(--bg-list);
  border-radius: var(--radius-control);
}

.system-line {
  margin-bottom: 10px;
  font-size: var(--font-xs);
  color: var(--text-3);
  text-align: center;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 18px;
  background: var(--bg-window);
  border-top: 1px solid var(--line);
}

.composer textarea {
  flex: 1;
  min-height: 44px;
  max-height: 160px;
  padding: 9px 11px;
  font: inherit;
  font-size: var(--font-md);
  line-height: 1.5;
  color: var(--text-1);
  resize: vertical;
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  outline: none;
}

.composer textarea:focus {
  border-color: var(--primary-border);
}

.permission-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(22, 34, 52, 0.3);
}

.permission-card {
  width: min(560px, 100%);
  max-height: 90vh;
  padding: 20px;
  overflow-y: auto;
  background: var(--bg-window);
  border-radius: 8%;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
}

.permission-card h3 {
  margin: 0;
  font-size: var(--font-lg);
}

.permission-untrusted {
  margin: 6px 0 12px;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.permission-title {
  font-size: var(--font-md);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.permission-kind {
  margin-top: 2px;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.permission-paths {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: var(--font-xs);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.permission-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.option-chip {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-list);
  border-radius: var(--radius-pill);
}

.permission-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

@media (max-width: 1180px) {
  .role-grid,
  .room-grid {
    grid-template-columns: 1fr;
  }

  .room-aside {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 980px) {
  .mode-rail {
    width: 74px;
  }

  .task-side {
    width: 270px;
  }

  .create-screen {
    padding: 24px 20px 48px;
  }

  .create-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}

.chat-side .session-item {
  margin-top: 4px;
}

@media (max-width: 760px) {
  .agent-side {
    width: 230px;
  }
  .agent-side.chat-side {
    width: 250px;
  }
  .chat-side .agent-actions {
    grid-template-columns: 1fr;
  }

  .create-screen {
    padding: 46px 20px 20px;
  }

  .role-grid {
    grid-template-columns: 1fr;
  }

  .room-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .room-actions {
    justify-content: flex-start;
  }

  .meta-panel,
  .room-aside {
    grid-template-columns: 1fr;
  }

  .apply-bar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
