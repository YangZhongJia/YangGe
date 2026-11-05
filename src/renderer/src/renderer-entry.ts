import type { Component } from 'vue'

export type RendererEntry = 'main' | 'settings' | 'capture' | 'image-viewer' | 'remote-view' | 'desktop-effect'

type RendererRootModule = { default: Component }

export function resolveRendererEntry(hash: string): RendererEntry {
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/capture')) return 'capture'
  if (hash.startsWith('#/image-viewer')) return 'image-viewer'
  if (hash.startsWith('#/desktop-effect')) return 'desktop-effect'
  if (hash.startsWith('#/remote-view')) return 'remote-view'
  return 'main'
}

export function loadRendererRoot(entry: RendererEntry): Promise<RendererRootModule> {
  switch (entry) {
    case 'remote-view':
      return import('./RemoteViewApp.vue')
    case 'settings':
      return import('./SettingsApp.vue')
    case 'capture':
      return import('./CaptureApp.vue')
    case 'image-viewer':
      return import('./ImageViewerApp.vue')
    case 'desktop-effect':
      return import('./DesktopEffectApp.vue')
    case 'main':
      return import('./App.vue')
  }
}
