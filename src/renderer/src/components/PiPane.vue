<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PantryIcon from './PantryIcon.vue'
import PiMarkdown from './PiMarkdown.vue'
import type {
  PiEvent,
  PiHistoryEntry,
  PiModelView,
  PiRouterView,
  PiStateView
} from '../../../shared/ipc'
import { tr } from '../utils/i18n'

const PROJECTS_KEY = 'yangge.pi.projects'
const ACTIVE_KEY = 'yangge.pi.active'
const ROUTER_KEY = 'yangge.pi.router'
const DEFAULT_ROUTER: PiRouterView = {
  mode: 'pi',
  baseUrl: 'http://127.0.0.1:3425/v1',
  apiKey: 'magpie',
  modelId: ''
}
const THINKING_LABEL_KEYS: Record<string, string> = {
  off: '关闭思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'tool'; id: number; toolCallId: string; toolName: string; args: string; state: 'running' | 'done' | 'error' }
  | { kind: 'notice'; id: number; text: string; error: boolean }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

function pathName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function loadProjects(): string[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || !item.trim()) continue
      const key = normalizePath(item)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
    return result
  } catch {
    return []
  }
}

function loadRouter(): PiRouterView {
  try {
    const raw = localStorage.getItem(ROUTER_KEY)
    if (!raw) return { ...DEFAULT_ROUTER }
    const parsed = JSON.parse(raw) as Partial<PiRouterView>
    return {
      mode: parsed.mode === 'magpie' ? 'magpie' : 'pi',
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_ROUTER.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_ROUTER.apiKey,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : ''
    }
  } catch {
    return { ...DEFAULT_ROUTER }
  }
}

function saveProjects(): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects.value))
  } catch {
    /* localStorage 不可用时只保留内存状态 */
  }
}

function loadActivePath(): string {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY)
    if (!saved) return ''
    return projects.value.find((item) => normalizePath(item) === normalizePath(saved)) ?? ''
  } catch {
    return ''
  }
}

function saveActivePath(path: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, path)
  } catch {
    /* localStorage 不可用时只保留内存状态 */
  }
}

function historyEntries(history: PiHistoryEntry[]): Entry[] {
  return history.map((item) => {
    const id = nextId()
    if (item.kind === 'tool') {
      return {
        kind: 'tool',
        id,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        args: item.args,
        state: item.state
      }
    }
    return { kind: item.kind, id, text: item.text }
  })
}

const projects = ref<string[]>(loadProjects())
const savedRouter = ref<PiRouterView>(loadRouter())
const router = reactive<PiRouterView>({ ...savedRouter.value })
const showRouter = ref(false)
const routerError = ref('')
const applying = ref(false)

const activePath = ref('')
const state = ref<PiStateView | null>(null)
const entries = ref<Entry[]>([])
const draft = ref('')
const busy = ref(false)
const starting = ref(false)
const headerStatus = ref('')
const headerTone = ref<'info' | 'error'>('info')
const currentAssistantId = ref<number | null>(null)
const transcriptEl = ref<HTMLElement | null>(null)
const modelSelection = ref('')
const thinkingSelection = ref('')
const magpieModels = ref<PiModelView[]>([])
const magpieBusy = ref(false)
const magpieError = ref('')
let seq = 0
let composing = false
let unsubscribe: (() => void) | null = null

const projectName = computed(() => (activePath.value ? pathName(activePath.value) : ''))
const models = computed(() => state.value?.models ?? [])
const thinkingLevels = computed(() => {
  const levels = [...(state.value?.thinkingLevels ?? [])]
  const current = state.value?.thinkingLevel
  if (current && !levels.includes(current)) levels.unshift(current)
  return levels
})
const magpieOptions = computed(() => {
  const options = magpieModels.value.map((model) => ({
    value: model.id,
    label: model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id
  }))
  if (router.modelId && !options.some((option) => option.value === router.modelId)) {
    options.push({ value: router.modelId, label: router.modelId })
  }
  return options
})
const canSend = computed(
  () =>
    Boolean(activePath.value) &&
    Boolean(state.value?.running) &&
    !busy.value &&
    !starting.value &&
    draft.value.trim().length > 0
)
const statusText = computed(() => {
  if (starting.value) return tr('启动中')
  if (busy.value && !headerStatus.value) return tr('处理中')
  if (headerStatus.value) return headerStatus.value
  if (!activePath.value) return ''
  if (state.value?.running) return tr('就绪')
  return tr('未运行')
})

function modelKey(model: PiModelView | null): string {
  return model ? `${model.provider}::${model.id}` : ''
}

function thinkingLabel(level: string): string {
  return tr(THINKING_LABEL_KEYS[level] ?? level)
}

function thinkingOptionLabel(level: string): string {
  return level === 'off' ? tr('关闭思考') : `${tr('思考')} · ${thinkingLabel(level)}`
}

function nextId(): number {
  seq += 1
  return seq
}

function clearTranscript(): void {
  entries.value = []
  currentAssistantId.value = null
}

function scrollToBottom(): void {
  const el = transcriptEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function showError(message: string): void {
  entries.value.push({ kind: 'notice', id: nextId(), text: message, error: true })
  headerStatus.value = message
  headerTone.value = 'error'
}

function toolPreview(args: unknown): string {
  if (args == null) return ''
  let text: string
  if (typeof args === 'string') {
    text = args
  } else {
    try {
      text = JSON.stringify(args) ?? String(args)
    } catch {
      text = String(args)
    }
  }
  if (!text || text === '{}') return ''
  return text.length > 100 ? `${text.slice(0, 100)}…` : text
}

function toolStateLabel(value: 'running' | 'done' | 'error'): string {
  if (value === 'error') return tr('失败')
  if (value === 'done') return tr('完成')
  return tr('运行中')
}

function handleEvent(event: PiEvent): void {
  if (event.type === 'assistant_delta') {
    const current = entries.value.find(
      (entry) => entry.kind === 'assistant' && entry.id === currentAssistantId.value
    )
    if (current && current.kind === 'assistant') {
      current.text += event.delta
    } else {
      const id = nextId()
      entries.value.push({ kind: 'assistant', id, text: event.delta })
      currentAssistantId.value = id
    }
    return
  }
  if (event.type === 'assistant_end') {
    const current = entries.value.find(
      (entry) => entry.kind === 'assistant' && entry.id === currentAssistantId.value
    )
    if (current && current.kind === 'assistant') {
      current.text = event.text
    } else if (event.text.trim()) {
      entries.value.push({ kind: 'assistant', id: nextId(), text: event.text })
    }
    currentAssistantId.value = null
    return
  }
  if (event.type === 'tool_start') {
    entries.value.push({
      kind: 'tool',
      id: nextId(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: toolPreview(event.args),
      state: 'running'
    })
    currentAssistantId.value = null
    return
  }
  if (event.type === 'tool_end') {
    for (let i = entries.value.length - 1; i >= 0; i -= 1) {
      const entry = entries.value[i]
      if (entry.kind === 'tool' && entry.toolCallId === event.toolCallId) {
        entry.state = event.isError ? 'error' : 'done'
        break
      }
    }
    return
  }
  if (event.type === 'settled') {
    busy.value = false
    if (event.aborted) {
      headerStatus.value = tr('已中止')
      headerTone.value = 'info'
    } else if (headerTone.value !== 'error') {
      headerStatus.value = ''
    }
    return
  }
  if (event.type === 'error') {
    busy.value = false
    showError(event.message)
    return
  }
  headerStatus.value = event.message
  headerTone.value = 'info'
}

async function startProject(path: string): Promise<void> {
  if (starting.value) return
  activePath.value = path
  saveActivePath(path)
  starting.value = true
  routerError.value = ''
  try {
    const previous = state.value
    if (previous && previous.projectPath !== path) {
      try {
        await window.pantry.stopPi()
      } catch {
        /* 上一个进程可能已退出 */
      }
      state.value = null
    }
    if (!state.value || state.value.projectPath !== path) {
      clearTranscript()
      busy.value = false
      headerStatus.value = ''
      headerTone.value = 'info'
    }
    const result = await window.pantry.startPi({
      projectPath: path,
      router: {
        mode: router.mode,
        baseUrl: router.baseUrl.trim(),
        apiKey: router.apiKey.trim(),
        modelId: router.modelId
      }
    })
    if (result.ok) {
      state.value = result.state
      entries.value = historyEntries(result.state.history)
      currentAssistantId.value = null
      busy.value = false
      headerStatus.value = ''
      headerTone.value = 'info'
      await nextTick()
      scrollToBottom()
    } else {
      state.value = null
      showError(result.error || tr('无法启动 Pi'))
    }
  } catch (error) {
    state.value = null
    showError(errorText(error) || tr('无法启动 Pi'))
  } finally {
    starting.value = false
  }
}

async function addProject(): Promise<void> {
  if (starting.value) return
  let path: string | null = null
  try {
    path = await window.pantry.pickPiProject()
  } catch (error) {
    showError(errorText(error))
    return
  }
  if (!path) return
  const existing = projects.value.find((item) => normalizePath(item) === normalizePath(path))
  if (existing) {
    projects.value = [existing, ...projects.value.filter((item) => item !== existing)]
  } else {
    projects.value = [path, ...projects.value]
  }
  saveProjects()
  await selectProject(existing ?? path)
}

async function selectProject(path: string): Promise<void> {
  if (starting.value) return
  if (normalizePath(activePath.value) === normalizePath(path) && state.value?.running) return
  activePath.value = path
  await startProject(path)
}

function setRouterMode(mode: PiRouterView['mode']): void {
  router.mode = mode
}

function openRouter(): void {
  if (applying.value) return
  Object.assign(router, savedRouter.value)
  routerError.value = ''
  magpieError.value = ''
  showRouter.value = true
}

function closeRouter(): void {
  if (applying.value) return
  Object.assign(router, savedRouter.value)
  routerError.value = ''
  showRouter.value = false
}

async function refreshMagpieModels(): Promise<void> {
  if (magpieBusy.value) return
  magpieBusy.value = true
  magpieError.value = ''
  try {
    const list = await window.pantry.listMagpieModels(router.baseUrl.trim(), router.apiKey.trim())
    magpieModels.value = list
    if (!list.length) magpieError.value = tr('未获取到模型')
  } catch (error) {
    magpieError.value = errorText(error)
  } finally {
    magpieBusy.value = false
  }
}

async function applyRouter(): Promise<void> {
  if (applying.value) return
  routerError.value = ''
  const next: PiRouterView = {
    mode: router.mode,
    baseUrl: router.baseUrl.trim(),
    apiKey: router.apiKey.trim(),
    modelId: router.modelId
  }
  try {
    localStorage.setItem(ROUTER_KEY, JSON.stringify(next))
  } catch {
    routerError.value = tr('保存失败')
    return
  }
  savedRouter.value = next
  const path = activePath.value
  if (!path) {
    showRouter.value = false
    headerStatus.value = tr('路由已保存')
    headerTone.value = 'info'
    return
  }
  applying.value = true
  try {
    try {
      await window.pantry.stopPi()
    } catch {
      /* 未运行时忽略 */
    }
    state.value = null
    busy.value = false
    clearTranscript()
    headerStatus.value = ''
    headerTone.value = 'info'
    showRouter.value = false
    await startProject(path)
  } finally {
    applying.value = false
  }
}

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  entries.value.push({ kind: 'user', id: nextId(), text })
  currentAssistantId.value = null
  busy.value = true
  headerStatus.value = ''
  headerTone.value = 'info'
  try {
    const result = await window.pantry.promptPi(text)
    if (!result.ok) {
      busy.value = false
      showError(result.error || tr('发送失败'))
    } else if (result.state) {
      state.value = result.state
    }
  } catch (error) {
    busy.value = false
    showError(errorText(error))
  }
}

async function stop(): Promise<void> {
  if (!busy.value) return
  try {
    const aborted = await window.pantry.abortPi()
    if (!aborted) {
      busy.value = false
      headerStatus.value = tr('当前没有可中止的请求')
      headerTone.value = 'info'
    }
  } catch (error) {
    showError(errorText(error))
  }
}

async function changeModel(): Promise<void> {
  const model = models.value.find((item) => modelKey(item) === modelSelection.value)
  if (!model || !state.value) {
    modelSelection.value = modelKey(state.value?.currentModel ?? null)
    return
  }
  if (modelKey(state.value.currentModel) === modelKey(model)) return
  try {
    const result = await window.pantry.setPiModel(model.provider, model.id)
    if (result.ok) {
      state.value = result.state
    } else {
      showError(result.error || tr('模型切换失败'))
      modelSelection.value = modelKey(state.value?.currentModel ?? null)
    }
  } catch (error) {
    showError(errorText(error))
    modelSelection.value = modelKey(state.value?.currentModel ?? null)
  }
}

async function changeThinking(): Promise<void> {
  const level = thinkingSelection.value
  if (!level || !state.value) {
    thinkingSelection.value = state.value?.thinkingLevel ?? ''
    return
  }
  if (level === state.value.thinkingLevel) return
  try {
    const result = await window.pantry.setPiThinking(level)
    if (result.ok) {
      state.value = result.state
    } else {
      showError(result.error || tr('思考程度切换失败'))
      thinkingSelection.value = state.value?.thinkingLevel ?? ''
    }
  } catch (error) {
    showError(errorText(error))
    thinkingSelection.value = state.value?.thinkingLevel ?? ''
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || composing || event.keyCode === 229) return
  event.preventDefault()
  void send()
}

function onCompositionStart(): void {
  composing = true
}

function onCompositionEnd(): void {
  composing = false
}

watch(state, (value) => {
  modelSelection.value = modelKey(value?.currentModel ?? null)
  thinkingSelection.value = value?.thinkingLevel ?? ''
})
watch(entries, () => void nextTick(scrollToBottom), { deep: true })
watch(busy, () => void nextTick(scrollToBottom))

onMounted(async () => {
  unsubscribe = window.pantry.onPiEvent(handleEvent)
  const saved = loadActivePath()
  if (saved) await selectProject(saved)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="pi-pane">
    <aside class="projects">
      <div class="projects-head">
        <span>{{ tr('项目') }}</span>
        <button
          class="icon-btn"
          type="button"
          :title="tr('添加项目')"
          :aria-label="tr('添加项目')"
          :disabled="starting"
          @click="addProject"
        >
          <PantryIcon name="plus" :size="16" />
        </button>
      </div>
      <div v-if="projects.length" class="project-list">
        <button
          v-for="path in projects"
          :key="path"
          class="project"
          :class="{ active: normalizePath(activePath) === normalizePath(path) }"
          type="button"
          :title="path"
          :disabled="starting"
          @click="selectProject(path)"
        >
          <span class="p-name">{{ pathName(path) }}</span>
        </button>
      </div>
      <div v-else class="rail-empty">
        <p>{{ tr('还没有项目') }}</p>
        <p>{{ tr('点击 + 添加一个项目') }}</p>
      </div>
    </aside>

    <section class="workspace">
      <header class="ws-head">
        <span class="ws-name">{{ projectName || tr('未选择项目') }}</span>
        <span class="ws-path" :title="activePath">{{ activePath || tr('从左侧选择或添加项目') }}</span>
        <span class="status" :class="{ error: headerTone === 'error' }" :title="statusText">{{ statusText }}</span>
        <button class="ghost-btn" type="button" @click="openRouter">
          <PantryIcon name="settings" :size="14" />
          <span>{{ tr('路由') }}</span>
        </button>
      </header>

      <div ref="transcriptEl" class="transcript" tabindex="-1">
        <div v-if="!entries.length" class="welcome">
          <PantryIcon name="zap" :size="20" />
          <h2>{{ tr('开始使用 Pi') }}</h2>
          <p v-if="!activePath">{{ tr('选择或添加左侧项目后开始对话') }}</p>
          <p v-else>{{ tr('Pi 会在项目目录中运行，可读写文件并执行命令。') }}</p>
          <p v-if="activePath" class="hint">{{ tr('在下方输入任务，Enter 发送') }}</p>
        </div>

        <template v-for="entry in entries" :key="entry.id">
          <div v-if="entry.kind === 'user'" class="entry-user">{{ entry.text }}</div>
          <PiMarkdown v-else-if="entry.kind === 'assistant'" class="entry-assistant" :text="entry.text" />
          <div v-else-if="entry.kind === 'tool'" class="tool-row" :class="entry.state">
            <span class="tool-name">{{ entry.toolName }}</span>
            <span v-if="entry.args" class="tool-args">{{ entry.args }}</span>
            <span class="tool-state">{{ toolStateLabel(entry.state) }}</span>
          </div>
          <div v-else class="entry-notice" :class="{ error: entry.error }">{{ entry.text }}</div>
        </template>
      </div>

      <div class="composer">
        <div class="composer-card">
          <textarea
            v-model="draft"
            :placeholder="tr('输入消息，Enter 发送，Shift+Enter 换行')"
            :disabled="!activePath || !state?.running"
            rows="2"
            @keydown="onKeydown"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
          ></textarea>
          <div class="composer-bar">
            <select
              v-model="modelSelection"
              class="ctl model-select"
              :disabled="!models.length || !state?.running || busy"
              :title="tr('模型')"
              :aria-label="tr('模型')"
              @change="changeModel"
            >
              <option v-if="!models.length" value="">{{ tr('暂无可用模型') }}</option>
              <option v-for="model in models" :key="modelKey(model)" :value="modelKey(model)">
                {{ model.name && model.name !== model.id ? `${model.name} · ${model.provider}/${model.id}` : `${model.provider}/${model.id}` }}
              </option>
            </select>
            <select
              v-if="thinkingLevels.length"
              v-model="thinkingSelection"
              class="ctl thinking-select"
              :disabled="!state?.running || busy"
              :title="tr('思考程度')"
              :aria-label="tr('思考程度')"
              @change="changeThinking"
            >
              <option v-for="level in thinkingLevels" :key="level" :value="level">
                {{ thinkingOptionLabel(level) }}
              </option>
            </select>
            <button v-if="busy" class="send-btn stop" type="button" :title="tr('停止')" @click="stop">
              <PantryIcon name="x" :size="14" />
              <span>{{ tr('停止') }}</span>
            </button>
            <button
              v-else
              class="send-btn"
              type="button"
              :title="tr('发送')"
              :disabled="!canSend"
              @click="send"
            >
              <PantryIcon name="send" :size="14" />
              <span>{{ tr('发送') }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="showRouter" class="router-panel">
        <div class="router-head">
          <span>{{ tr('模型路由') }}</span>
          <button class="icon-btn" type="button" :title="tr('关闭')" :aria-label="tr('关闭')" @click="closeRouter">
            <PantryIcon name="x" :size="14" />
          </button>
        </div>
        <label class="radio">
          <input type="radio" :checked="router.mode === 'pi'" @change="setRouterMode('pi')" />
          <span>{{ tr('Pi 默认模型') }}</span>
        </label>
        <label class="radio">
          <input type="radio" :checked="router.mode === 'magpie'" @change="setRouterMode('magpie')" />
          <span>{{ tr('Magpie 路由') }}</span>
        </label>

        <template v-if="router.mode === 'magpie'">
          <label class="field">
            <span>{{ tr('服务地址') }}</span>
            <input v-model="router.baseUrl" class="ctl" type="text" spellcheck="false" autocomplete="off" />
          </label>
          <label class="field">
            <span>{{ tr('API Key') }}</span>
            <input v-model="router.apiKey" class="ctl" type="password" autocomplete="off" />
          </label>
          <label class="field">
            <span>{{ tr('Magpie 模型') }}</span>
            <select v-model="router.modelId" class="ctl">
              <option value="">{{ tr('自动选择') }}</option>
              <option v-for="option in magpieOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <button class="ghost-btn" type="button" :disabled="magpieBusy" @click="refreshMagpieModels">
            <PantryIcon name="refresh" :size="13" />
            <span>{{ magpieBusy ? tr('刷新中…') : tr('刷新模型') }}</span>
          </button>
          <span v-if="magpieError" class="form-error">{{ magpieError }}</span>
        </template>

        <span v-if="routerError" class="form-error">{{ routerError }}</span>
        <button class="primary-btn" type="button" :disabled="applying || starting" @click="applyRouter">
          {{ applying || starting ? tr('正在重启…') : tr('应用并重启 Pi') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pi-pane{--r:var(--radius-control);--xs:var(--font-xs);--sm:var(--font-sm);display:flex;height:100%;min-width:0;min-height:0;box-sizing:border-box;padding-top:32px;color:var(--text-1);font-size:var(--font-md)}
.projects{display:flex;flex:0 0 224px;flex-direction:column;min-height:0;background:var(--bg-list);border-right:1px solid var(--line)}
.projects-head{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 6px;font-size:var(--xs);color:var(--text-3)}
.icon-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--r);background:none;color:var(--text-3);cursor:pointer}
.project-list{flex:1;min-height:0;overflow-y:auto;padding:4px 8px}
.project{display:flex;align-items:center;width:100%;padding:8px;border:0;border-radius:var(--r);background:none;color:var(--text-2);text-align:left;cursor:pointer}
.project.active{background:var(--surface-selected);color:var(--text-1)}
.p-name,.ws-name,.ws-path,.status{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.p-name{font-size:var(--sm);font-weight:500}
.rail-empty{padding:6px 14px;color:var(--text-3);font-size:var(--xs);line-height:1.7}
.workspace{position:relative;display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
.ws-head{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 18px;border-bottom:1px solid var(--line)}
.ws-name{min-width:0;font-weight:600}
.ws-path,.status{min-width:0;font-size:var(--xs);color:var(--text-3)}
.ws-path{flex:1}
.status.error{color:var(--danger)}
.ctl{min-width:0;height:30px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg-input);color:var(--text-1);font-size:var(--xs)}
.model-select{max-width:200px}
.ghost-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r);background:none;color:var(--text-2);font-size:var(--xs);white-space:nowrap;cursor:pointer}
.ctl:focus,.composer textarea:focus{border-color:var(--primary)}
.transcript{display:flex;flex:1;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;padding:24px 28px;outline:none;user-select:text}
.welcome{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:30px;color:var(--text-3);text-align:center}
.welcome h2{margin:0;font-size:var(--font-lg)}
.welcome p{margin:0;font-size:var(--sm);line-height:1.6}
.entry-user{align-self:flex-end;max-width:min(78%,620px);padding:8px 12px;border-radius:var(--radius-panel);background:var(--primary-weak);white-space:pre-wrap}
.entry-assistant{width:100%;max-width:960px;min-width:0}
.entry-notice{white-space:pre-wrap;overflow-wrap:anywhere}
.entry-notice{font-size:var(--xs);color:var(--text-3)}
.entry-notice.error{color:var(--danger)}
.tool-row{display:flex;gap:8px;padding:5px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:var(--xs);color:var(--text-3)}
.tool-name{font-weight:600;color:var(--text-1)}
.tool-args{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tool-state{margin-left:auto}
.tool-row.error{border-color:var(--danger);color:var(--danger)}
.composer{flex-shrink:0;min-width:0;padding:10px 18px 14px;border-top:1px solid var(--line)}
.composer-card{display:flex;flex-direction:column;width:100%;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--bg-input);transition:border-color 150ms ease,box-shadow 150ms ease}
.composer-card:focus-within{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-weak)}
.composer textarea{width:100%;min-height:50px;max-height:180px;padding:11px 12px 5px;border:0;background:transparent;color:var(--text-1);font:inherit;font-size:var(--sm);line-height:1.55;resize:none;outline:none;user-select:text}
.composer-bar{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 7px 7px 9px}
.composer-bar .ctl{height:26px;min-width:0;border-color:transparent;background:var(--bg-list);color:var(--text-2)}
.composer-bar .ctl:hover:enabled{border-color:var(--line);color:var(--text-1)}
.composer-bar .model-select{width:min(240px,42vw);max-width:240px}
.composer-bar .thinking-select{width:auto;max-width:140px}
.composer-bar .send-btn{margin-left:auto}
.send-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;height:30px;padding:0 12px;border:0;border-radius:var(--r);background:var(--primary);color:var(--on-primary);font-size:var(--xs);cursor:pointer}
.send-btn:disabled{opacity:.45;cursor:default}
.send-btn.stop{border:1px solid var(--line);background:none;color:var(--text-2)}
.router-panel{position:absolute;top:58px;right:14px;z-index:10;display:flex;flex-direction:column;gap:8px;width:292px;padding:14px;border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--bg-window);box-shadow:var(--shadow-float)}
.router-head{display:flex;align-items:center;justify-content:space-between;font-size:var(--sm);font-weight:600}
.radio{display:block;font-size:var(--xs);color:var(--text-2);cursor:pointer}
.field{font-size:var(--xs);color:var(--text-3)}
.field .ctl{display:block;width:100%;margin-top:4px}
.form-error{font-size:var(--xs);color:var(--danger);overflow-wrap:anywhere}
.primary-btn{width:100%;height:30px;border:0;border-radius:var(--r);background:var(--primary);color:var(--on-primary);font-size:var(--xs);cursor:pointer}
</style>
