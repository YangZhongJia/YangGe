import { ref, shallowRef } from 'vue'
import { IMAGE_FILE_EXTENSIONS } from '../../../shared/media'

export interface PendingAttachment {
  id: number
  name: string
  size: number
  path: string
  image: boolean
  file: Blob
  preview: string
}

/** 只保存本地草稿。发送能力由调用方注入，粘贴时不会触发授权或传输。 */
export function usePendingAttachments(urls = URL) {
  const items = shallowRef<PendingAttachment[]>([])
  const busy = ref(false)
  const failed = ref(false)
  let nextId = 0
  let generation = 0
  const token = (): number => generation
  const isCurrent = (value: number): boolean => value === generation
  function add(file: Blob, name: string, path = ''): void {
    if (path && items.value.some(item => item.path === path)) return
    const image = IMAGE_FILE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))
    items.value = [...items.value, {
      id: ++nextId, name, size: file.size, path, file, image,
      preview: image ? urls.createObjectURL(file) : ''
    }]
  }
  function remove(id: number): void {
    const item = items.value.find(item => item.id === id)
    if (item?.preview) urls.revokeObjectURL(item.preview)
    items.value = items.value.filter(item => item.id !== id)
    if (!items.value.length) failed.value = false
  }
  function clear(): void {
    generation++
    for (const item of items.value) if (item.preview) urls.revokeObjectURL(item.preview)
    items.value = []
    failed.value = false
  }
  async function send(
    submit: (item: PendingAttachment, valid: () => boolean) => Promise<boolean>,
    before?: () => Promise<boolean>
  ): Promise<void> {
    if (busy.value) return
    busy.value = true
    failed.value = false
    const run = generation
    const batch = [...items.value]
    const valid = (): boolean => run === generation
    try {
      if (before && !(await before())) { if (valid()) failed.value = true; return }
      for (const item of batch) {
        if (!valid()) break
        if (!(await submit(item, valid))) { if (valid()) failed.value = true; break }
        if (valid()) remove(item.id)
      }
    } catch { if (valid()) failed.value = true }
    finally { busy.value = false }
  }
  return { items, busy, failed, add, remove, clear, send, token, isCurrent }
}
