import { EDGE_TARGETS_PACKED, INNER_TARGETS_PACKED, TARGET_SAMPLE } from './particle-targets.generated'

/**
 * 生成表记录的是 160×160 网格上的整数坐标（每点 2 字节）。这里解码成归一化
 * 的 [x0, y0, x1, y1, …]，绘制时直接按图标尺寸缩放。
 */
export function decodePackedTargets(packed: string, sample: number = TARGET_SAMPLE): Float32Array {
  if (!Number.isInteger(sample) || sample <= 0) throw new Error('采样网格尺寸无效')
  const binary = atob(packed)
  if (binary.length % 2 !== 0) throw new Error('粒子目标点数据长度无效')
  const points = new Float32Array(binary.length)
  for (let i = 0; i < binary.length; i++) points[i] = binary.charCodeAt(i) / sample
  return points
}

let edgeCache: Float32Array | null = null
let innerCache: Float32Array | null = null

/** 轮廓点（归一化 x,y 交替） */
export function edgeTargets(): Float32Array {
  if (!edgeCache) edgeCache = decodePackedTargets(EDGE_TARGETS_PACKED)
  return edgeCache
}

/** 内部填充点（归一化 x,y 交替） */
export function innerTargets(): Float32Array {
  if (!innerCache) innerCache = decodePackedTargets(INNER_TARGETS_PACKED)
  return innerCache
}
