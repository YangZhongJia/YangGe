<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import type { FaceStatusView } from '../../../shared/ipc'
import { tr } from '../utils/i18n'
import {
  cameraErrorMessage,
  faceDescriptorFromVideo,
  loadFaceEngine,
  startCamera,
  stopCamera
} from '../utils/face'

const props = defineProps<{ enabled: boolean }>()

const status = ref<FaceStatusView | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const active = ref(false)
const busy = ref(false)
const statusText = ref('')
const error = ref('')
const notice = ref('')
onMounted(() => {
  void refresh()
})

onBeforeUnmount(() => {
  stopCamera(videoEl.value)
})

async function refresh(): Promise<void> {
  try {
    status.value = await window.pantry.getFaceStatus()
  } catch {
    status.value = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function start(): Promise<void> {
  if (!props.enabled || busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  active.value = true
  await nextTick()
  try {
    statusText.value = tr('正在打开摄像头…')
    await startCamera(videoEl.value as HTMLVideoElement)
    statusText.value = tr('正在加载人脸模型…')
    await loadFaceEngine()
    const samples: number[][] = []
    for (let index = 0; index < 3; index += 1) {
      statusText.value = tr('请正对摄像头，正在采集 {0}/3', { 0: index + 1 })
      await delay(420)
      const descriptor = await faceDescriptorFromVideo(videoEl.value as HTMLVideoElement)
      if (!descriptor) throw new Error(tr('没有检测到人脸，请让脸部完整出现在画面中'))
      samples.push(descriptor)
    }
    statusText.value = tr('正在保存人脸特征…')
    status.value = await window.pantry.enrollFace(samples)
    notice.value = tr('人脸已保存，可以在锁屏使用人脸识别')
  } catch (err) {
    error.value = tr(cameraErrorMessage(err))
  } finally {
    stopCamera(videoEl.value)
    active.value = false
    busy.value = false
    statusText.value = ''
    await refresh()
  }
}

async function remove(): Promise<void> {
  if (!status.value?.enrolled) return
  if (!window.confirm(tr('删除后只能用密码解锁；重新采集才能恢复人脸解锁。'))) return
  try {
    status.value = await window.pantry.removeFace()
    notice.value = tr('人脸数据已删除')
    error.value = ''
  } catch (err) {
    error.value = err instanceof Error ? tr(err.message) : tr('删除失败')
  }
}
</script>

<template>
  <div class="face-panel">
    <div class="face-panel-copy">
      <strong>{{ tr('人脸解锁') }}</strong>
      <small>{{ tr('在锁屏点击「人脸识别」，通过后直接进入。') }}</small>
    </div>
    <div class="face-enroll">
      <div v-if="!enabled" class="face-hint">{{ tr('请先设置 6 位数字密码，再录入人脸。') }}</div>
      <template v-else>
        <div v-if="active" class="face-preview">
          <video ref="videoEl" class="face-video" muted playsinline></video>
          <div class="face-frame" aria-hidden="true"></div>
          <span class="face-status">{{ statusText }}</span>
        </div>
        <div v-else class="face-summary">
          <span :class="['face-badge', { on: status?.enrolled }]">
            {{ status?.enrolled ? tr('已录入 · {0} 个样本', { 0: status.sampleCount }) : tr('尚未录入') }}
          </span>
          <span v-if="status?.enrolled" class="face-date">
            {{ new Date(status.updatedAt ?? Date.now()).toLocaleDateString() }}
          </span>
        </div>
        <div class="face-actions">
          <NButton
            v-if="!status?.enrolled"
            type="primary"
            :loading="busy"
            :disabled="!enabled"
            @click="start"
          >
            {{ busy ? tr('采集中…') : tr('采集人脸') }}
          </NButton>
          <template v-else>
            <NButton secondary :loading="busy" :disabled="!enabled" @click="start">
              {{ tr('重新采集') }}
            </NButton>
            <NButton quaternary :disabled="busy" @click="remove">{{ tr('删除人脸') }}</NButton>
          </template>
        </div>
      </template>
      <p v-if="error" class="face-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="face-notice" role="status">{{ notice }}</p>
      <p class="face-privacy">{{ tr('只在本机保存人脸特征，不保存或上传照片。') }}</p>
      <p class="face-warning">{{ tr('照片或视频可能欺骗摄像头，人脸识别仅作便捷解锁，请保留密码。') }}</p>
    </div>
  </div>
</template>

<style scoped>
.face-panel {
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.face-panel-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.face-panel-copy strong {
  font-size: 13px;
  font-weight: 600;
}
.face-panel-copy small,
.face-hint,
.face-privacy,
.face-warning {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}
.face-enroll {
  margin-top: 10px;
}
.face-preview {
  position: relative;
  width: 220px;
  height: 165px;
  overflow: hidden;
  border-radius: 8px;
  background: #111;
}
.face-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}
.face-frame {
  position: absolute;
  inset: 18px 46px;
  border: 2px dashed rgba(255, 255, 255, 0.75);
  border-radius: 42%;
  pointer-events: none;
}
.face-status {
  position: absolute;
  right: 8px;
  bottom: 8px;
  left: 8px;
  color: #fff;
  font-size: 12px;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}
.face-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}
.face-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-list);
  color: var(--text-3);
  font-size: 12px;
}
.face-badge.on {
  background: var(--primary-weak);
  color: var(--primary);
}
.face-date {
  color: var(--text-3);
  font-size: 12px;
}
.face-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.face-error,
.face-notice {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
}
.face-error {
  color: var(--danger);
}
.face-notice {
  color: var(--primary);
}
.face-privacy {
  margin: 10px 0 0;
}
.face-warning {
  margin: 4px 0 0;
  color: var(--text-3);
}
</style>
