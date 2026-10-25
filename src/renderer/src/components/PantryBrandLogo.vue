<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed } from 'vue'
import monoLogoUrl from '../assets/brand/icon-macos-menubar-outline.svg?url'
import appIconUrl from '../assets/brand/teahouse-app-icon.png?url'

// 茶话间品牌 logo（决议 #107/#226）：界面彩色品牌位统一复用透明位图，
// macOS 菜单栏等单色场景继续使用可由系统着色的单色 SVG。
const props = withDefaults(
  defineProps<{
    variant?: 'icon' | 'color' | 'mono'
    size?: number
  }>(),
  {
    variant: 'color',
    size: 64
  }
)

const logoSrc = computed(() => {
  if (props.variant === 'mono') return monoLogoUrl
  return appIconUrl
})
</script>

<template>
  <img
    class="pantry-brand-logo"
    :class="`is-${props.variant}`"
    :src="logoSrc"
    :width="props.size"
    :height="props.size"
    :alt="tr('阳鸽 logo')"
    draggable="false"
  />
</template>

<style scoped>
.pantry-brand-logo {
  display: block;
  flex-shrink: 0;
  object-fit: contain;
  user-select: none;
}
</style>
