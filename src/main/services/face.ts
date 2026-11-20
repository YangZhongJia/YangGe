import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { FaceStatusView, FaceVerifyResult } from '../../shared/ipc'
import {
  bestFaceDistance,
  FACE_MAX_SAMPLES,
  FACE_MATCH_THRESHOLD,
  isFaceDescriptor
} from './face-descriptor'

interface StoredFace {
  version: 1
  updatedAt: number
  descriptors: number[][]
}

interface Envelope {
  version: 1
  encrypted: boolean
  data: string
}

export class FaceService {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'data', 'face-descriptor.json')
  }

  status(): FaceStatusView {
    const stored = this.read()
    return {
      enrolled: Boolean(stored?.descriptors.length),
      sampleCount: stored?.descriptors.length ?? 0,
      updatedAt: stored?.updatedAt ?? null
    }
  }

  enroll(descriptors: unknown): FaceStatusView {
    if (!Array.isArray(descriptors) || descriptors.length === 0 || descriptors.length > FACE_MAX_SAMPLES) {
      throw new Error('人脸样本数量不合法')
    }
    if (!descriptors.every(isFaceDescriptor)) throw new Error('人脸特征不合法')
    const stored: StoredFace = {
      version: 1,
      updatedAt: Date.now(),
      // 去重后再保存，避免连续抓帧写入重复样本。
      descriptors: dedupe(descriptors)
    }
    this.write(stored)
    return this.status()
  }

  verify(descriptor: unknown): FaceVerifyResult {
    if (!isFaceDescriptor(descriptor)) return { ok: false, distance: null }
    const stored = this.read()
    if (!stored?.descriptors.length) return { ok: false, distance: null }
    const distance = bestFaceDistance(stored.descriptors, descriptor)
    return {
      ok: distance <= FACE_MATCH_THRESHOLD,
      distance: Number(distance.toFixed(3))
    }
  }

  remove(): FaceStatusView {
    try {
      rmSync(this.file, { force: true })
    } catch {
      // 文件不存在或已被清理
    }
    return this.status()
  }

  private read(): StoredFace | null {
    if (!existsSync(this.file)) return null
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Envelope>
      if (typeof raw.data !== 'string') return null
      const plain =
        raw.encrypted === true
          ? safeStorage.decryptString(Buffer.from(raw.data, 'base64'))
          : raw.data
      const parsed = JSON.parse(plain) as Partial<StoredFace>
      const descriptors = Array.isArray(parsed.descriptors)
        ? parsed.descriptors.filter(isFaceDescriptor)
        : []
      if (descriptors.length === 0) return null
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        descriptors
      }
    } catch {
      return null
    }
  }

  private write(stored: StoredFace): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const plain = JSON.stringify(stored)
    let envelope: Envelope
    try {
      envelope = safeStorage.isEncryptionAvailable()
        ? {
            version: 1,
            encrypted: true,
            data: safeStorage.encryptString(plain).toString('base64')
          }
        : { version: 1, encrypted: false, data: plain }
    } catch {
      envelope = { version: 1, encrypted: false, data: plain }
    }
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }
}

function dedupe(descriptors: number[][]): number[][] {
  const result: number[][] = []
  for (const descriptor of descriptors) {
    if (!result.some((existing) => bestFaceDistance([existing], descriptor) < 0.02)) {
      result.push(descriptor)
    }
  }
  return result
}
