import { describe, expect, it } from 'vitest'
import {
  bestFaceDistance,
  faceDistance,
  FACE_DESCRIPTOR_LENGTH,
  FACE_MATCH_THRESHOLD,
  isFaceDescriptor
} from './face-descriptor'

function descriptor(value: number): number[] {
  return Array.from({ length: FACE_DESCRIPTOR_LENGTH }, () => value)
}

describe('人脸特征比较', () => {
  it('校验 128 维有限数值', () => {
    expect(isFaceDescriptor(descriptor(0.1))).toBe(true)
    expect(isFaceDescriptor([1, 2, 3])).toBe(false)
    expect(isFaceDescriptor(descriptor(Number.NaN))).toBe(false)
    expect(isFaceDescriptor(descriptor(Infinity))).toBe(false)
  })

  it('相同特征距离为 0，且多样本取最近距离', () => {
    const a = descriptor(0.1)
    const b = descriptor(0.2)
    expect(faceDistance(a, a)).toBe(0)
    expect(bestFaceDistance([a, b], a)).toBe(0)
    expect(bestFaceDistance([b], a)).toBeGreaterThan(0)
  })

  it('阈值边界可判定通过', () => {
    const a = descriptor(0)
    const b = descriptor(FACE_MATCH_THRESHOLD / Math.sqrt(FACE_DESCRIPTOR_LENGTH))
    expect(faceDistance(a, b)).toBeCloseTo(FACE_MATCH_THRESHOLD)
    expect(bestFaceDistance([a], b) <= FACE_MATCH_THRESHOLD).toBe(true)
  })
})
