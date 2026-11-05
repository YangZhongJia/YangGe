<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import type { MessageView, WorkTaskProjectView } from '../../../shared/ipc'
import { tr } from '../utils/i18n'
import { buildMessageTaskDraft } from '../utils/message-task'
import { WORK_TASK_LIMITS } from '../../../shared/work-task'

const props = defineProps<{
  msg: MessageView
  senderName: string
  convName: string
}>()
const emit = defineEmits<{ close: []; created: [title: string] }>()

const projects = ref<WorkTaskProjectView[]>([])
const loadingProjects = ref(true)
const saving = ref(false)
const error = ref('')
const draft = buildMessageTaskDraft(props.msg, props.senderName, props.convName)
const form = reactive({
  projectId: '',
  title: draft.title,
  description: draft.description,
  dueDate: ''
})

const ownedProjects = computed(() => projects.value.filter((project) => !project.isShared))
const projectOptions = computed(() =>
  ownedProjects.value.map((project) => ({ label: project.name, value: project.id }))
)
const canSave = computed(
  () => Boolean(form.projectId) && form.title.trim().length > 0 && !saving.value
)

onMounted(async () => {
  try {
    projects.value = await window.pantry.listWorkTaskProjects()
    form.projectId = ownedProjects.value[0]?.id ?? ''
  } catch {
    error.value = tr('读取项目失败')
  } finally {
    loadingProjects.value = false
  }
})

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    const result = await window.pantry.createWorkTask({
      projectId: form.projectId,
      title: form.title.trim(),
      description: form.description.trim(),
      startDate: null,
      dueDate: form.dueDate || null
    })
    if (!result.ok) {
      error.value = result.error
      return
    }
    emit('created', result.value.title)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="task-mask" @click.self="emit('close')">
      <section class="task-card" role="dialog" aria-modal="true" aria-labelledby="message-task-title">
        <header>
          <div>
            <p class="task-eyebrow">{{ tr('MESSAGE → TASK') }}</p>
            <h3 id="message-task-title">{{ tr('把这条消息转为任务') }}</h3>
          </div>
          <button type="button" :aria-label="tr('关闭')" @click="emit('close')">×</button>
        </header>

        <p class="task-source">
          {{ tr('来源：{0} · {1}', { 0: convName, 1: senderName }) }}
        </p>

        <p v-if="loadingProjects" class="task-empty">{{ tr('正在读取项目…') }}</p>
        <p v-else-if="ownedProjects.length === 0" class="task-empty">
          {{ tr('还没有本机项目，请先到任务页创建一个项目。') }}
        </p>
        <template v-else>
          <label class="task-field">
            <span>{{ tr('项目') }}</span>
            <NSelect v-model:value="form.projectId" :options="projectOptions" />
          </label>
          <label class="task-field">
            <span>{{ tr('标题') }}</span>
            <NInput v-model:value="form.title" :maxlength="WORK_TASK_LIMITS.title" />
          </label>
          <label class="task-field">
            <span>{{ tr('截止日期（可选）') }}</span>
            <input v-model="form.dueDate" type="date" />
          </label>
          <label class="task-field">
            <span>{{ tr('说明') }}</span>
            <NInput
              v-model:value="form.description"
              type="textarea"
              :autosize="{ minRows: 6, maxRows: 12 }"
            />
          </label>
        </template>

        <p v-if="error" class="task-error" role="alert">{{ error }}</p>

        <footer>
          <NButton secondary :disabled="saving" @click="emit('close')">{{ tr('取消') }}</NButton>
          <NButton
            type="primary"
            :disabled="!canSave || ownedProjects.length === 0"
            :loading="saving"
            @click="save"
          >
            {{ tr('创建任务') }}
          </NButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.task-mask {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  background: var(--scrim);
}
.task-card {
  width: min(520px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 72px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 18px 20px;
  overflow-y: auto;
  background: var(--material-strong);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--highlight-edge), var(--shadow-float);
}
.task-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.task-card h3 {
  margin: 2px 0 0;
  font-size: var(--font-md);
}
.task-card header > button {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 18px;
  cursor: pointer;
}
.task-eyebrow {
  margin: 0;
  color: var(--text-3);
  font-size: var(--font-xs);
  letter-spacing: 0.12em;
}
.task-source {
  margin: 6px 0 12px;
  color: var(--text-3);
  font-size: var(--font-xs);
}
.task-empty {
  padding: 18px 0;
  color: var(--text-3);
  font-size: var(--font-sm);
  text-align: center;
}
.task-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  color: var(--text-3);
  font-size: var(--font-xs);
}
.task-field input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg-input);
  color: var(--text-1);
  font: inherit;
  font-size: var(--font-sm);
}
.task-error {
  margin: 4px 0;
  color: var(--danger);
  font-size: var(--font-xs);
}
.task-card footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 10px;
}
</style>
