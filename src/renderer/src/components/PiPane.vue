<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PantryIcon from './PantryIcon.vue'
import PiMarkdown from './PiMarkdown.vue'
import type {
  PiEvent,
  PiHistoryEntry,
  PiConfigSuggestion,
  PiModelView,
  PiRouterView,
  PiRuntimeStatus,
  PiStateView
} from '../../../shared/ipc'
import { tr } from '../utils/i18n'

const PROJECTS_KEY = 'yangge.pi.projects'
const ACTIVE_KEY = 'yangge.pi.active'
const ROUTER_KEY = 'yangge.pi.router'
const ROUTER_SETUP_KEY = 'yangge.pi.router-setup'
const DEFAULT_ROUTER: PiRouterView = {
  mode: 'pi',
  name: 'Pi',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:3425/v1',
  apiKey: 'magpie',
  modelId: '',
  models: []
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
      mode: parsed.mode === 'magpie' || parsed.mode === 'custom' ? parsed.mode : 'pi',
      name: typeof parsed.name === 'string' ? parsed.name : DEFAULT_ROUTER.name,
      api: parsed.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_ROUTER.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_ROUTER.apiKey,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      models: Array.isArray(parsed.models)
        ? [...new Set(parsed.models.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
        : []
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

function saveRouter(next: PiRouterView): boolean {
  try {
    localStorage.setItem(ROUTER_KEY, JSON.stringify(next))
    localStorage.setItem(ROUTER_SETUP_KEY, '1')
    savedRouter.value = next
    routerConfigured.value = true
    return true
  } catch {
    return false
  }
}

function syncCustomModelsText(): void {
  customModelsText.value = router.models.join('\n')
}

function parseModelsText(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))]
}

async function refreshRuntime(): Promise<void> {
  try {
    runtime.value = await window.pantry.getPiRuntimeStatus()
  } catch {
    runtime.value = null
  }
}

async function scanConfigs(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    suggestions.value = await window.pantry.scanPiConfigs()
  } catch {
    suggestions.value = []
  } finally {
    scanning.value = false
  }
}

async function installRuntime(): Promise<void> {
  if (installBusy.value) return
  installBusy.value = true
  try {
    const result = await window.pantry.installPiRuntime()
    runtime.value = result.status
    if (!result.ok) showError(result.error || tr('Pi 安装失败'))
    else headerStatus.value = tr('Pi 已安装')
  } catch (error) {
    showError(errorText(error))
  } finally {
    installBusy.value = false
  }
}

function useSuggestion(suggestion: PiConfigSuggestion): void {
  Object.assign(router, suggestion.router)
  syncCustomModelsText()
  routerError.value = ''
  void applyRouter()
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
const routerConfigured = ref(Boolean(localStorage.getItem(ROUTER_SETUP_KEY)))
const showRouter = ref(false)
const routerError = ref('')
const applying = ref(false)
const scanning = ref(false)
const installBusy = ref(false)
const suggestions = ref<PiConfigSuggestion[]>([])
const runtime = ref<PiRuntimeStatus | null>(null)
const customModelsText = ref('')

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
const modelMenuOpen = ref(false)
const thinkingMenuOpen = ref(false)
const modelSearch = ref('')
const modelSearchEl = ref<HTMLInputElement | null>(null)
const modelActive = ref(0)
const thinkingActive = ref(0)
const modelBusy = ref(false)
const thinkingBusy = ref(false)
const magpieModels = ref<PiModelView[]>([])
const magpieBusy = ref(false)
const magpieError = ref('')
let seq = 0
let composing = false
let unsubscribe: (() => void) | null = null

const projectName = computed(() => (activePath.value ? pathName(activePath.value) : ''))
const models = computed(() => state.value?.models ?? [])
const selectedModel = computed(() =>
  models.value.find((item) => modelKey(item) === modelSelection.value) ?? state.value?.currentModel ?? null
)
const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  if (!query) return models.value
  return models.value.filter((model) => {
    const haystack = `${model.name} ${model.provider}/${model.id}`.toLowerCase()
    return haystack.includes(query)
  })
})
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
    !modelBusy.value &&
    !thinkingBusy.value &&
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

function modelLabel(model: PiModelView | null): string {
  if (!model) return tr('暂无可用模型')
  return model.name && model.name !== model.id ? model.name : model.id
}

function modelMeta(model: PiModelView): string {
  return `${model.provider}/${model.id}`
}

function thinkingOptionLabel(level: string): string {
  return level === 'off' ? tr('关闭思考') : `${tr('思考')} · ${thinkingLabel(level)}`
}

function closePickers(): void {
  modelMenuOpen.value = false
  thinkingMenuOpen.value = false
}

async function openModelMenu(): Promise<void> {
  if (!models.value.length || !state.value?.running || busy.value || modelBusy.value || starting.value) return
  thinkingMenuOpen.value = false
  modelMenuOpen.value = true
  modelSearch.value = ''
  const current = filteredModels.value.findIndex((model) => modelKey(model) === modelKey(state.value?.currentModel ?? null))
  modelActive.value = Math.max(0, current)
  await nextTick()
  modelSearchEl.value?.focus()
}

function toggleModelMenu(): void {
  if (modelMenuOpen.value) modelMenuOpen.value = false
  else void openModelMenu()
}

function openThinkingMenu(): void {
  if (!thinkingLevels.value.length || !state.value?.running || busy.value || thinkingBusy.value || starting.value) return
  modelMenuOpen.value = false
  thinkingMenuOpen.value = true
  const current = thinkingLevels.value.indexOf(state.value?.thinkingLevel ?? '')
  thinkingActive.value = Math.max(0, current)
}

function toggleThinkingMenu(): void {
  if (thinkingMenuOpen.value) thinkingMenuOpen.value = false
  else openThinkingMenu()
}

function moveModel(delta: number): void {
  if (!modelMenuOpen.value || !filteredModels.value.length) return
  const size = filteredModels.value.length
  modelActive.value = (modelActive.value + delta + size) % size
  void nextTick(() => {
    document.querySelector('.model-menu .picker-option.active')?.scrollIntoView({ block: 'nearest' })
  })
}

function chooseActiveModel(): void {
  const model = filteredModels.value[modelActive.value]
  if (model) applyModel(model)
}

function applyModel(model: PiModelView): void {
  modelSelection.value = modelKey(model)
  closePickers()
  void changeModel()
}

function moveThinking(delta: number): void {
  if (!thinkingMenuOpen.value || !thinkingLevels.value.length) return
  const size = thinkingLevels.value.length
  thinkingActive.value = (thinkingActive.value + delta + size) % size
}

function chooseActiveThinking(): void {
  const level = thinkingLevels.value[thinkingActive.value]
  if (level) applyThinking(level)
}

function applyThinking(level: string): void {
  thinkingSelection.value = level
  closePickers()
  void changeThinking()
}

function onPickerPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.model-picker')) modelMenuOpen.value = false
  if (!target.closest('.thinking-picker')) thinkingMenuOpen.value = false
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
        name: router.name.trim() || '自定义 API',
        api: router.api,
        baseUrl: router.baseUrl.trim(),
        apiKey: router.apiKey.trim(),
        modelId: router.modelId,
        models: parseModelsText(customModelsText.value)
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
  if (mode === 'custom') syncCustomModelsText()
}

function openRouter(): void {
  if (applying.value) return
  Object.assign(router, savedRouter.value)
  syncCustomModelsText()
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
    name: router.name.trim() || '自定义 API',
    api: router.api,
    baseUrl: router.baseUrl.trim(),
    apiKey: router.apiKey.trim(),
    modelId: router.modelId,
    models: parseModelsText(customModelsText.value)
  }
  if (next.mode === 'custom' && !next.models.length) {
    routerError.value = tr('请至少填写一个模型 ID')
    return
  }
  if (!saveRouter(next)) {
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
  if (modelBusy.value) return
  const model = models.value.find((item) => modelKey(item) === modelSelection.value)
  if (!model || !state.value) {
    modelSelection.value = modelKey(state.value?.currentModel ?? null)
    return
  }
  if (modelKey(state.value.currentModel) === modelKey(model)) return
  modelBusy.value = true
  headerStatus.value = tr('切换模型中…')
  headerTone.value = 'info'
  try {
    const result = await window.pantry.setPiModel(model.provider, model.id)
    if (result.ok) {
      state.value = result.state
      headerStatus.value = ''
    } else {
      showError(result.error || tr('模型切换失败'))
      modelSelection.value = modelKey(state.value?.currentModel ?? null)
    }
  } catch (error) {
    showError(errorText(error))
    modelSelection.value = modelKey(state.value?.currentModel ?? null)
  } finally {
    modelBusy.value = false
  }
}

async function changeThinking(): Promise<void> {
  if (thinkingBusy.value) return
  const level = thinkingSelection.value
  if (!level || !state.value) {
    thinkingSelection.value = state.value?.thinkingLevel ?? ''
    return
  }
  if (level === state.value.thinkingLevel) return
  thinkingBusy.value = true
  headerStatus.value = tr('切换思考程度…')
  headerTone.value = 'info'
  try {
    const result = await window.pantry.setPiThinking(level)
    if (result.ok) {
      state.value = result.state
      headerStatus.value = ''
    } else {
      showError(result.error || tr('思考程度切换失败'))
      thinkingSelection.value = state.value?.thinkingLevel ?? ''
    }
  } catch (error) {
    showError(errorText(error))
    thinkingSelection.value = state.value?.thinkingLevel ?? ''
  } finally {
    thinkingBusy.value = false
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
watch(busy, (value) => {
  if (value) closePickers()
  void nextTick(scrollToBottom)
})

onMounted(async () => {
  unsubscribe = window.pantry.onPiEvent(handleEvent)
  document.addEventListener('pointerdown', onPickerPointerDown)
  await refreshRuntime()
  if (!routerConfigured.value) {
    await scanConfigs()
    const first = suggestions.value[0]
    if (first) {
      Object.assign(router, first.router)
      syncCustomModelsText()
      saveRouter({ ...first.router })
      headerStatus.value = tr('已导入 {0}', { 0: first.label })
      headerTone.value = 'info'
    } else {
      showRouter.value = true
    }
  }
  const saved = loadActivePath()
  if (saved && runtime.value?.found) await selectProject(saved)
  else if (saved && !runtime.value?.found) showRouter.value = true
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPickerPointerDown)
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
        <div class="ws-title">
          <span class="ws-name">{{ projectName || tr('未选择项目') }}</span>
          <span class="ws-path" :title="activePath">{{ activePath || tr('从左侧选择或添加项目') }}</span>
        </div>
        <span v-if="statusText" class="status" :class="{ error: headerTone === 'error' }" :title="statusText">
          <i aria-hidden="true"></i>{{ statusText }}
        </span>
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
            <div class="picker model-picker">
              <button
                class="ctl picker-trigger model-trigger"
                type="button"
                :disabled="!models.length || !state?.running || busy || modelBusy || starting"
                :title="selectedModel ? modelMeta(selectedModel) : tr('暂无可用模型')"
                :aria-label="tr('模型')"
                aria-haspopup="listbox"
                :aria-expanded="modelMenuOpen"
                @click="toggleModelMenu"
                @keydown.down.prevent="openModelMenu"
                @keydown.esc.prevent="closePickers"
              >
                <span class="picker-value">{{ modelLabel(selectedModel) }}</span>
                <PantryIcon name="chevron-down" :size="13" />
              </button>
              <div v-if="modelMenuOpen" class="picker-menu model-menu" role="listbox" :aria-label="tr('模型')">
                <label class="picker-search">
                  <PantryIcon name="search" :size="13" />
                  <input
                    ref="modelSearchEl"
                    v-model="modelSearch"
                    type="search"
                    spellcheck="false"
                    autocomplete="off"
                    :placeholder="tr('搜索模型')"
                    :aria-label="tr('搜索模型')"
                    @input="modelActive = 0"
                    @keydown.down.prevent="moveModel(1)"
                    @keydown.up.prevent="moveModel(-1)"
                    @keydown.enter.prevent="chooseActiveModel"
                    @keydown.esc.prevent="closePickers"
                  />
                </label>
                <div class="picker-list">
                  <button
                    v-for="(model, index) in filteredModels"
                    :key="modelKey(model)"
                    type="button"
                    class="picker-option"
                    :class="{
                      active: index === modelActive,
                      selected: modelKey(model) === modelKey(state?.currentModel ?? null)
                    }"
                    role="option"
                    :aria-selected="modelKey(model) === modelKey(state?.currentModel ?? null)"
                    @mouseenter="modelActive = index"
                    @click="applyModel(model)"
                  >
                    <span class="picker-option-text">
                      <strong>{{ modelLabel(model) }}</strong>
                      <small>{{ modelMeta(model) }}</small>
                    </span>
                    <PantryIcon
                      v-if="modelKey(model) === modelKey(state?.currentModel ?? null)"
                      name="check"
                      :size="13"
                    />
                  </button>
                  <p v-if="!filteredModels.length" class="picker-empty">{{ tr('没有匹配的模型') }}</p>
                </div>
              </div>
            </div>
            <div v-if="thinkingLevels.length" class="picker thinking-picker">
              <button
                class="ctl picker-trigger thinking-trigger"
                type="button"
                :disabled="!state?.running || busy || thinkingBusy || starting"
                :title="tr('思考程度')"
                :aria-label="tr('思考程度')"
                aria-haspopup="listbox"
                :aria-expanded="thinkingMenuOpen"
                @click="toggleThinkingMenu"
                @keydown.down.prevent="thinkingMenuOpen ? moveThinking(1) : openThinkingMenu()"
                @keydown.up.prevent="thinkingMenuOpen ? moveThinking(-1) : openThinkingMenu()"
                @keydown.enter.prevent="thinkingMenuOpen ? chooseActiveThinking() : toggleThinkingMenu()"
                @keydown.esc.prevent="closePickers"
              >
                <span class="picker-value">
                  {{ thinkingSelection ? thinkingOptionLabel(thinkingSelection) : tr('思考程度') }}
                </span>
                <PantryIcon name="chevron-down" :size="13" />
              </button>
              <div v-if="thinkingMenuOpen" class="picker-menu thinking-menu" role="listbox" :aria-label="tr('思考程度')">
                <div class="picker-list">
                  <button
                    v-for="(level, index) in thinkingLevels"
                    :key="level"
                    type="button"
                    class="picker-option"
                    :class="{ active: index === thinkingActive, selected: level === state?.thinkingLevel }"
                    role="option"
                    :aria-selected="level === state?.thinkingLevel"
                    @mouseenter="thinkingActive = index"
                    @click="applyThinking(level)"
                  >
                    <span class="picker-option-text"><strong>{{ thinkingOptionLabel(level) }}</strong></span>
                    <PantryIcon v-if="level === state?.thinkingLevel" name="check" :size="13" />
                  </button>
                </div>
              </div>
            </div>
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
          <span>{{ tr('AI 服务配置') }}</span>
          <button class="icon-btn" type="button" :title="tr('关闭')" :aria-label="tr('关闭')" @click="closeRouter">
            <PantryIcon name="x" :size="14" />
          </button>
        </div>

        <div class="runtime-line" :class="{ missing: runtime && !runtime.found }">
          <i aria-hidden="true"></i>
          <div class="runtime-copy">
            <strong>
              {{ runtime === null ? tr('正在检测 Pi…') : runtime.found ? tr('Pi 已就绪') : tr('未检测到 Pi') }}
            </strong>
            <small v-if="runtime?.found">{{ runtime.command }}</small>
            <small v-else-if="runtime">
              {{ runtime.nodeVersion ? tr('需要 Node 22.19+ 和 Pi CLI') : tr('需要 Node 22.19+ 和 Pi CLI') }}
            </small>
          </div>
          <button
            v-if="runtime && !runtime.found && runtime.canInstall"
            class="ghost-btn"
            type="button"
            :disabled="installBusy"
            @click="installRuntime"
          >
            <PantryIcon name="download" :size="13" />
            <span>{{ installBusy ? tr('安装中…') : tr('安装 Pi') }}</span>
          </button>
        </div>

        <div class="scan-block">
          <button class="ghost-btn scan-btn" type="button" :disabled="scanning" @click="scanConfigs">
            <PantryIcon name="search" :size="13" />
            <span>{{ scanning ? tr('扫描中…') : tr('扫描本机 AI 配置') }}</span>
          </button>
          <div v-if="suggestions.length" class="suggestions">
            <button
              v-for="suggestion in suggestions"
              :key="suggestion.id"
              type="button"
              class="suggestion"
              @click="useSuggestion(suggestion)"
            >
              <span class="suggestion-copy">
                <strong>{{ suggestion.label }}</strong>
                <small>{{ suggestion.detail }}</small>
              </span>
              <PantryIcon name="chevron-right" :size="13" />
            </button>
          </div>
          <p v-else class="scan-hint">{{ tr('可从 pi-switch、cc-switch、Magpie 或 Claude 配置导入') }}</p>
        </div>

        <div class="mode-list" role="radiogroup" :aria-label="tr('AI 服务')">
          <label class="radio">
            <input type="radio" :checked="router.mode === 'pi'" @change="setRouterMode('pi')" />
            <span>{{ tr('Pi 默认模型') }}</span>
          </label>
          <label class="radio">
            <input type="radio" :checked="router.mode === 'magpie'" @change="setRouterMode('magpie')" />
            <span>{{ tr('Magpie 路由') }}</span>
          </label>
          <label class="radio">
            <input type="radio" :checked="router.mode === 'custom'" @change="setRouterMode('custom')" />
            <span>{{ tr('自定义 API') }}</span>
          </label>
        </div>

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

        <template v-if="router.mode === 'custom'">
          <label class="field">
            <span>{{ tr('服务名称') }}</span>
            <input v-model="router.name" class="ctl" type="text" spellcheck="false" autocomplete="off" :placeholder="tr('例如：公司网关')" />
          </label>
          <div class="field">
            <span>{{ tr('协议') }}</span>
            <div class="protocol-row">
              <label class="radio">
                <input type="radio" :checked="router.api === 'openai-completions'" @change="router.api = 'openai-completions'" />
                <span>{{ tr('OpenAI 兼容') }}</span>
              </label>
              <label class="radio">
                <input type="radio" :checked="router.api === 'anthropic-messages'" @change="router.api = 'anthropic-messages'" />
                <span>{{ tr('Anthropic 兼容') }}</span>
              </label>
            </div>
          </div>
          <label class="field">
            <span>{{ tr('服务地址') }}</span>
            <input v-model="router.baseUrl" class="ctl" type="text" spellcheck="false" autocomplete="off" placeholder="https://…/v1" />
          </label>
          <label class="field">
            <span>{{ tr('API Key') }}</span>
            <input v-model="router.apiKey" class="ctl" type="password" autocomplete="off" :placeholder="tr('只保存在本机')" />
          </label>
          <label class="field">
            <span>{{ tr('模型 ID（每行一个）') }}</span>
            <textarea v-model="customModelsText" class="ctl models-input" spellcheck="false" :placeholder="tr('例如：gpt-6.1-sol')"></textarea>
          </label>
        </template>

        <span v-if="routerError" class="form-error">{{ routerError }}</span>
        <button class="primary-btn" type="button" :disabled="applying || starting" @click="applyRouter">
          {{ applying || starting ? tr('正在重启…') : tr('保存并重启 Pi') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pi-pane{--r:var(--radius-control);--xs:var(--font-xs);--sm:var(--font-sm);display:flex;height:100%;min-width:0;min-height:0;box-sizing:border-box;padding-top:32px;color:var(--text-1);font-size:var(--font-md)}
.projects{display:flex;flex:0 0 208px;flex-direction:column;min-height:0;background:var(--bg-list);border-right:1px solid var(--line)}
.projects-head{display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:8px 12px 4px;font-size:var(--xs);font-weight:600;color:var(--text-2)}
.icon-btn{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:var(--r);background:none;color:var(--text-3);cursor:pointer;transition:background 150ms ease,color 150ms ease}
.icon-btn:hover:enabled{background:var(--surface-hover);color:var(--text-1)}
.project-list{flex:1;min-height:0;overflow-y:auto;padding:4px 8px}
.project{display:flex;align-items:center;width:100%;padding:8px 10px;border:0;border-radius:var(--r);background:none;color:var(--text-2);text-align:left;cursor:pointer;transition:background 150ms ease,color 150ms ease}
.project:hover:enabled{background:var(--surface-hover);color:var(--text-1)}
.project.active{background:var(--surface-selected);color:var(--text-1);box-shadow:inset 2px 0 0 var(--primary)}
.p-name,.ws-name,.ws-path,.status{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.p-name{font-size:var(--sm);font-weight:500}
.rail-empty{padding:6px 14px;color:var(--text-3);font-size:var(--xs);line-height:1.7}
.workspace{position:relative;display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
.ws-head{display:flex;align-items:center;gap:12px;min-width:0;min-height:52px;padding:8px 18px;border-bottom:1px solid var(--line)}
.ws-title{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.ws-name{min-width:0;font-size:var(--sm);font-weight:650;line-height:1.3}
.ws-path,.status{min-width:0;font-size:var(--xs);color:var(--text-3)}
.ws-path{font-size:11px;line-height:1.35}
.status{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto}
.status i{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--online)}
.status.error{color:var(--danger)}
.status.error i{background:var(--danger)}
.ctl{min-width:0;height:30px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg-input);color:var(--text-1);font-size:var(--xs)}
.ghost-btn{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r);background:none;color:var(--text-2);font-size:var(--xs);white-space:nowrap;cursor:pointer;transition:background 150ms ease,color 150ms ease,border-color 150ms ease}
.ghost-btn:hover:not(:disabled){background:var(--surface-hover);color:var(--text-1)}
.ctl:focus,.composer textarea:focus{border-color:var(--primary)}
.icon-btn:focus-visible,.project:focus-visible,.ghost-btn:focus-visible,.send-btn:focus-visible,.ctl:focus-visible,.primary-btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.transcript{display:flex;flex:1;flex-direction:column;gap:16px;min-height:0;overflow-y:auto;padding:22px 24px;outline:none;user-select:text;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.transcript::-webkit-scrollbar{width:6px}
.transcript::-webkit-scrollbar-thumb{border-radius:6px;background:var(--line)}
.welcome{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:8px;max-width:460px;margin:auto;padding:30px;color:var(--text-3);text-align:center}
.welcome h2{margin:0;color:var(--text-2);font-size:var(--font-lg);font-weight:600}
.welcome p{margin:0;font-size:var(--sm);line-height:1.6}
.entry-user{align-self:flex-end;max-width:min(78%,620px);padding:9px 12px;border-radius:var(--radius-panel);background:var(--primary-weak);white-space:pre-wrap;overflow-wrap:anywhere}
.entry-assistant{width:100%;max-width:960px;min-width:0}
.entry-notice{padding:8px 10px;border-radius:var(--r);background:var(--bg-list);white-space:pre-wrap;overflow-wrap:anywhere}
.entry-notice{font-size:var(--xs);color:var(--text-3)}
.entry-notice.error{color:var(--danger)}
.tool-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:var(--xs);color:var(--text-3)}
.tool-name{flex:0 0 auto;font-weight:600;color:var(--text-1)}
.tool-args{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tool-state{margin-left:auto;flex-shrink:0}
.tool-row.error{border-color:var(--danger);color:var(--danger)}
.composer{position:relative;z-index:5;flex-shrink:0;min-width:0;padding:10px 18px 14px;border-top:1px solid var(--line)}
.composer-card{display:flex;flex-direction:column;width:100%;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--bg-input);transition:border-color 150ms ease,box-shadow 150ms ease}
.composer-card:focus-within{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-weak)}
.composer textarea{width:100%;min-height:50px;max-height:180px;padding:11px 12px 5px;border:0;background:transparent;color:var(--text-1);font:inherit;font-size:var(--sm);line-height:1.55;resize:none;outline:none;user-select:text}
.composer textarea::placeholder{color:var(--text-placeholder)}
.composer textarea:disabled{cursor:default}
.composer-bar{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 7px 7px 9px}
.composer-bar .ctl{height:28px;min-width:0;border-color:transparent;background:var(--bg-list);color:var(--text-2);transition:background 150ms ease,color 150ms ease,border-color 150ms ease}
.composer-bar .ctl:hover:enabled{border-color:var(--line);background:var(--surface-hover);color:var(--text-1)}
.composer-bar .ctl:disabled{opacity:.65;cursor:default}
.picker{position:relative;min-width:0}
.picker-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:0 8px;text-align:left;cursor:pointer}
.picker-trigger .pantry-icon{flex:0 0 auto;color:var(--text-3)}
.picker-value{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.model-trigger{width:min(240px,42vw);max-width:240px}
.thinking-trigger{width:auto;max-width:150px}
.picker-menu{position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--bg-window);box-shadow:var(--shadow-float);animation:picker-in 120ms ease-out}
.model-menu{width:min(340px,calc(100vw - 96px))}
.thinking-menu{width:180px}
.picker-search{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--line);color:var(--text-3)}
.picker-search input{width:100%;min-width:0;height:26px;padding:0;border:0;background:transparent;color:var(--text-1);font:inherit;font-size:var(--xs);outline:none}
.picker-search input::placeholder{color:var(--text-placeholder)}
.picker-search input::-webkit-search-cancel-button{display:none}
.picker-list{max-height:280px;overflow-y:auto;padding:4px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.picker-list::-webkit-scrollbar{width:6px}
.picker-list::-webkit-scrollbar-thumb{border-radius:6px;background:var(--line)}
.picker-option{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-width:0;padding:8px;border:0;border-radius:8px;background:none;color:var(--text-1);text-align:left;cursor:pointer}
.picker-option.active{background:var(--surface-hover)}
.picker-option.selected{background:var(--surface-selected)}
.picker-option .pantry-icon{flex:0 0 auto;color:var(--primary)}
.picker-option-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.picker-option-text strong{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:var(--xs);font-weight:500;line-height:1.4}
.picker-option-text small{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--text-3);font-size:11px;line-height:1.35}
.picker-empty{margin:0;padding:14px 10px;color:var(--text-3);font-size:var(--xs);text-align:center}
@keyframes picker-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.composer-bar .send-btn{margin-left:auto}
.send-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;height:30px;padding:0 12px;border:0;border-radius:var(--r);background:var(--primary);color:var(--on-primary);font-size:var(--xs);cursor:pointer;transition:background 150ms ease,transform 90ms ease-out}
.send-btn:hover:not(:disabled){background:var(--primary-hover)}
.send-btn:active:not(:disabled){transform:scale(.98)}
.send-btn:disabled{opacity:.45;cursor:default}
.send-btn.stop{border:1px solid var(--line);background:none;color:var(--text-2)}
.send-btn.stop:hover:not(:disabled){background:var(--surface-hover);color:var(--text-1)}
.router-panel{position:absolute;top:58px;right:14px;z-index:10;display:flex;flex-direction:column;gap:10px;width:360px;max-width:calc(100% - 28px);max-height:calc(100% - 76px);overflow-y:auto;padding:14px;border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--bg-window);box-shadow:var(--shadow-float);scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.router-head{display:flex;align-items:center;justify-content:space-between;font-size:var(--sm);font-weight:600}
.radio{display:flex;align-items:center;gap:6px;font-size:var(--xs);color:var(--text-2);cursor:pointer}
.radio input{accent-color:var(--primary)}
.runtime-line{display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg-list)}
.runtime-line>i{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--online)}
.runtime-line.missing{border-color:color-mix(in srgb,var(--away) 30%,var(--line));background:var(--bg-list)}
.runtime-line.missing>i{background:var(--away)}
.runtime-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.runtime-copy strong{font-size:var(--xs);font-weight:600;color:var(--text-1)}
.runtime-copy small{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--text-3);font-size:11px}
.runtime-line .ghost-btn{margin-left:auto;height:26px;padding-inline:8px}
.scan-block{display:flex;flex-direction:column;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.scan-btn{justify-content:center;width:100%}
.scan-hint{margin:0;color:var(--text-3);font-size:11px;line-height:1.45}
.suggestions{display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto}
.suggestion{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px 8px;border:1px solid var(--line);border-radius:7px;background:var(--bg-input);color:var(--text-1);text-align:left;cursor:pointer}
.suggestion:hover{background:var(--surface-hover);border-color:var(--line-strong,var(--line))}
.suggestion-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
.suggestion-copy strong,.suggestion-copy small{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.suggestion-copy strong{font-size:var(--xs);font-weight:500}
.suggestion-copy small{color:var(--text-3);font-size:11px}
.mode-list{display:flex;flex-direction:column;gap:6px;padding:2px 0}
.field{display:flex;flex-direction:column;gap:4px;font-size:var(--xs);color:var(--text-3)}
.field .ctl{display:block;width:100%;margin-top:0}
.field .radio{font-size:var(--xs);color:var(--text-2)}
.protocol-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:3px}
.models-input{min-height:68px;padding:7px 8px;resize:vertical;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.form-error{font-size:var(--xs);color:var(--danger);overflow-wrap:anywhere}
.primary-btn{width:100%;height:32px;border:0;border-radius:var(--r);background:var(--primary);color:var(--on-primary);font-size:var(--xs);cursor:pointer}
.primary-btn:hover:not(:disabled){background:var(--primary-hover)}
.primary-btn:disabled{opacity:.5;cursor:default}
.form-error{font-size:var(--xs);color:var(--danger);overflow-wrap:anywhere}
.primary-btn{width:100%;height:30px;border:0;border-radius:var(--r);background:var(--primary);color:var(--on-primary);font-size:var(--xs);cursor:pointer}
.primary-btn:hover:not(:disabled){background:var(--primary-hover)}
.primary-btn:disabled{opacity:.5;cursor:default}
@media(max-width:700px){.projects{flex-basis:160px}.ws-head{gap:8px;padding-inline:14px}.transcript{padding:18px 16px}.composer{padding-inline:14px}.model-trigger{width:min(200px,34vw)}}
</style>
