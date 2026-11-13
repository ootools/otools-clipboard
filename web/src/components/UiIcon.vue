<script setup lang="ts">
withDefaults(defineProps<{ name: 'clipboard' | 'search' | 'text' | 'image' | 'pin' | 'copy' | 'trash' | 'settings' | 'refresh' | 'pause' | 'play' | 'check' | 'info' | 'arrow-left' | 'arrow-right' | 'moon' | 'sun'; size?: number }>(), { size: 18 })
const paths: Record<string, string> = {
  clipboard: 'M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3 M9 3h6v4H9z M8 12h8 M8 16h5',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  text: 'M5 4h14 M12 4v16 M8 20h8', image: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1 M3 16l5-5 4 4 3-3 6 6 M8 7h.01',
  pin: 'M9 3h6 M10 3v6l-4 4v2h12v-2l-4-4V3 M12 15v7',
  copy: 'M9 9h11v11H9z M15 5V3H3v12h2', trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  refresh: 'M20 11a8 8 0 0 0-14-5L3 9 M3 3v6h6 M4 13a8 8 0 0 0 14 5l3-3 M21 21v-6h-6',
  pause: 'M7 4v16 M17 4v16', play: 'M7 3l14 9-14 9z', check: 'M5 12l4 4L19 6',
  info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  'arrow-left': 'M15 5l-7 7 7 7', 'arrow-right': 'M9 5l7 7-7 7',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10', sun: 'M12 3V1 M12 23v-2 M3 12H1 M23 12h-2 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0">
    <path :d="paths[name]" />
  </svg>
</template>
