import type * as FaceApi from '@vladmandic/face-api'
import { tr } from './i18n'
import './face-i18n'

// 人脸模型随应用打包，通过主进程的只读 yangge-face 协议加载。
// 静态 import 会把约 1.3 MB face-api 放进所有窗口的启动包，因此只在启用人脸时按需加载。
const MODEL_BASE = 'yangge-face://models/'

let enginePromise: Promise<typeof FaceApi> | null = null
let modelPromise: Promise<void> | null = null

export async function loadFaceEngine(): Promise<typeof FaceApi> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const api = await import('@vladmandic/face-api')
      if (!modelPromise) {
        modelPromise = Promise.all([
          api.nets.tinyFaceDetector.loadFromUri(MODEL_BASE),
          api.nets.faceLandmark68Net.loadFromUri(MODEL_BASE),
          api.nets.faceRecognitionNet.loadFromUri(MODEL_BASE)
        ]).then(() => undefined)
      }
      await modelPromise
      return api
    })().catch((error) => {
      enginePromise = null
      modelPromise = null
      throw error
    })
  }
  return enginePromise
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 }
    }
  })
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  try {
    await video.play()
  } catch {
    // 某些窗口在首帧前 play() 会被拒绝，等待 loadedmetadata 后再试一次。
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(tr('摄像头画面超时'))), 5000)
      video.addEventListener(
        'loadedmetadata',
        () => {
          window.clearTimeout(timer)
          void video.play().then(resolve).catch(reject)
        },
        { once: true }
      )
    })
  }
  return stream
}

export function stopCamera(video: HTMLVideoElement | null): void {
  if (!video) return
  const stream = video.srcObject
  if (stream instanceof MediaStream) {
    for (const track of stream.getTracks()) track.stop()
  }
  video.srcObject = null
}

export async function faceDescriptorFromVideo(video: HTMLVideoElement): Promise<number[] | null> {
  const api = await loadFaceEngine()
  if (video.readyState < 2 || video.videoWidth === 0) return null
  const result = await api
    .detectSingleFace(
      video,
      new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
    )
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!result?.descriptor) return null
  return Array.from(result.descriptor)
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return tr('未获得摄像头权限，请在系统设置中允许阳鸽使用摄像头')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return tr('没有找到可用的摄像头')
  if (name === 'NotReadableError') return tr('摄像头正被其他程序占用')
  return error instanceof Error ? error.message : tr('摄像头启动失败')
}
