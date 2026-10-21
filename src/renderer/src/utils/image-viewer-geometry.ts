export interface ImagePoint {
  x: number
  y: number
}

export interface ImageRect {
  left: number
  top: number
  right: number
  bottom: number
}

export function pointFromImageRect(params: {
  clientX: number
  clientY: number
  rect: ImageRect
  zoom: number
  naturalWidth: number
  naturalHeight: number
}): ImagePoint | null {
  const { clientX, clientY, rect, zoom, naturalWidth, naturalHeight } = params
  if (zoom <= 0) return null
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null
  }
  return {
    x: clamp((clientX - rect.left) / zoom, 0, naturalWidth),
    y: clamp((clientY - rect.top) / zoom, 0, naturalHeight)
  }
}

export function offsetForAnchoredZoom(params: {
  clientPoint: ImagePoint
  imagePoint: ImagePoint
  naturalWidth: number
  naturalHeight: number
  nextZoom: number
  viewportWidth: number
  viewportHeight: number
  minZoom: number
  maxZoom: number
}): { zoom: number; offset: ImagePoint } {
  const zoom = clamp(params.nextZoom, params.minZoom, params.maxZoom)
  const nextWidth = params.naturalWidth * zoom
  const nextHeight = params.naturalHeight * zoom
  return {
    zoom,
    offset: {
      x: params.clientPoint.x - params.viewportWidth / 2 + nextWidth / 2 - params.imagePoint.x * zoom,
      y: params.clientPoint.y - params.viewportHeight / 2 + nextHeight / 2 - params.imagePoint.y * zoom
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
