import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Face API 的模型权重不放进 Git；准备构建时从 npm 依赖复制到渲染层 public。
const source = resolve('node_modules/@vladmandic/face-api/model')
const target = resolve('src/renderer/public/face-models')
const files = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin'
]

if (!existsSync(source)) {
  console.error('[face-models] 缺少 @vladmandic/face-api，请先 npm install')
  process.exit(1)
}
mkdirSync(target, { recursive: true })
for (const file of files) {
  copyFileSync(join(source, file), join(target, file))
}
console.log(`[face-models] copied ${files.length} files to src/renderer/public/face-models`)
