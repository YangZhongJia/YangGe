<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { AgentPermissionDecision, AgentSessionView, AgentView } from '../../../shared/ipc'
import { useAgentStore } from '../stores/agent'
import { tr } from '../utils/i18n'

const store = useAgentStore()
const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)

const active = computed(() => store.activeSession)
const permission = computed(() => store.activePermission)
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

function shortPath(path: string): string {
  if (path.length <= 64) return path
  return `${path.slice(0, 28)}…${path.slice(-32)}`
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

onMounted(() => {
  void store.init()
})
</script>

<template>
  <div class="agent-app">
    <aside class="agent-side">
      <div class="side-head">
        <h2>{{ tr('本机 Agent') }}</h2>
        <NButton size="tiny" secondary :loading="store.scanning" @click="scan">
          {{ tr('扫描') }}
        </NButton>
      </div>
      <p class="side-hint">
        {{ tr('只扫描本机已安装的 ACP CLI，不会联网安装；消息在本机进程间处理。') }}
      </p>
      <button type="button" class="manual-link" @click="pickCommand">
        {{ tr('手动指定可执行文件…') }}
      </button>

      <div v-if="store.agents.length === 0" class="side-empty">
        {{ tr('尚未发现 Agent。点击「扫描」或手动选择 CLI。') }}
      </div>
      <article v-for="agent in store.agents" :key="agent.id" class="agent-card">
        <div class="agent-name">{{ agent.name }}</div>
        <div class="agent-meta">
          <span>{{ agent.version || tr('版本未知') }}</span>
          <span v-if="agent.probeError" class="probe-error" :title="agent.probeError">
            {{ tr('探测失败') }}
          </span>
        </div>
        <div class="agent-path" :title="agent.command">{{ shortPath(agent.command) }}</div>
        <div class="agent-actions">
          <NButton size="tiny" type="primary" ghost @click="create(agent)">
            {{ tr('新建会话') }}
          </NButton>
          <NButton size="tiny" quaternary @click="pickCwdAndCreate(agent)">
            {{ tr('选择目录') }}
          </NButton>
        </div>
      </article>

      <div class="side-head sessions-head">
        <h2>{{ tr('会话') }}</h2>
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

    <div v-if="permission" class="permission-mask" @click.self="respond('reject_once')">
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

.agent-side {
  display: flex;
  flex-direction: column;
  width: 268px;
  flex-shrink: 0;
  min-height: 0;
  padding: 14px 12px;
  overflow-y: auto;
  background: var(--bg-list);
  border-right: 1px solid var(--line);
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.side-head h2 {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-2);
}

.sessions-head {
  margin-top: 18px;
}

.side-hint {
  margin: 8px 0 6px;
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-3);
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

.agent-card {
  margin-top: 10px;
  padding: 10px;
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
}

.agent-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-1);
}

.agent-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: var(--font-xs);
  color: var(--text-3);
}

.probe-error {
  color: var(--warning, #b45309);
}

.agent-path {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.agent-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.session-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  width: 100%;
  margin-top: 6px;
  padding: 8px;
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
  font-size: var(--font-sm);
  overflow: hidden;
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
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
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
  font-size: var(--font-md);
  overflow: hidden;
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
  font-size: var(--font-xs);
  color: var(--text-3);
  overflow: hidden;
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
  font-size: var(--font-sm);
  overflow: hidden;
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
  border-radius: var(--radius-panel);
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
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
