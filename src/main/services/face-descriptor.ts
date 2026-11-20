export const FACE_DESCRIPTOR_LENGTH = 128
export const FACE_MATCH_THRESHOLD = 0.5
export const FACE_MAX_SAMPLES = 5

export function isFaceDescriptor(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === FACE_DESCRIPTOR_LENGTH &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 4)
  )
}

export function faceDistance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i += 1) {
    const delta = a[i] - b[i]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

export function bestFaceDistance(samples: number[][], candidate: number[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    best = Math.min(best, faceDistance(sample, candidate))
  }
  return best
}
