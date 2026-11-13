<script setup lang="ts">
import { ElButton } from 'element-plus'
import type { HistoryDetail, HistoryItem, ImageData } from '../types'
import type { ClipboardError } from '../api/errors'
import type { Locale, Translate } from '../i18n/messages'
import { formatBytes, formatDate } from '../composables/format'
import ErrorNotice from './ErrorNotice.vue'
import UiIcon from './UiIcon.vue'
defineProps<{ item: HistoryItem | null; detail: HistoryDetail | null; image: ImageData | null; loading: boolean; error: ClipboardError | null; busy: boolean; locale: Locale; t: Translate }>()
const emit = defineEmits<{ copy: []; pin: []; delete: []; retry: []; back: [] }>()
</script>

<template>
  <section class="detail-panel panel flex min-h-0 flex-col overflow-hidden" :aria-label="t('details')">
    <div class="row justify-between px-4 py-3 border-b border-[var(--clip-border)] text-xs muted">
      <span class="row gap-2"><UiIcon :name="item?.kind ?? 'clipboard'" :size="15" />{{ t('details') }}</span>
      <button class="mobile-back focus-ring bg-transparent border-0 text-[var(--clip-accent)] cursor-pointer p-0 text-xs" @click="emit('back')">{{ t('showHistory') }}</button>
      <span v-if="item?.pinned" class="pin-badge row gap-1"><UiIcon name="pin" :size="12" />{{ t('pinned') }}</span>
    </div>
    <div v-if="!item" class="flex-1 flex flex-col items-center justify-center gap-3 text-center p-6">
      <span class="icon-box w-13 h-13 bg-[var(--clip-soft)] muted"><UiIcon name="copy" :size="26" /></span>
      <h2 class="m-0 font-medium text-sm">{{ t('selectEntry') }}</h2>
      <p class="m-0 text-xs muted leading-relaxed max-w-65">{{ t('selectEntryHelp') }}</p>
    </div>
    <template v-else>
      <div class="flex-1 min-h-0 flex flex-col p-4 gap-3">
        <div v-if="error" class="flex flex-col gap-2">
          <ErrorNotice :error="error" :t="t" />
          <ElButton size="small" @click="emit('retry')">{{ t('retry') }}</ElButton>
        </div>
        <div v-else-if="loading" class="content-preview flex-1 min-h-34 flex items-center justify-center text-xs muted" role="status"><span class="loading-dot mr-2" />{{ t('loading') }}</div>
        <div v-else-if="item.kind === 'text'" class="content-preview flex-1 min-h-30 overflow-auto p-4">
          <pre data-testid="full-text" class="m-0 font-mono text-[13px] leading-7 whitespace-pre-wrap break-words">{{ detail?.text ?? '' }}</pre>
        </div>
        <div v-else class="content-preview image-stage flex-1 min-h-42 flex items-center justify-center overflow-auto p-3">
          <img v-if="image" :src="image.dataUrl" :alt="t('imagePlaceholder')" class="max-w-full max-h-full object-contain" />
          <span v-else class="row muted text-xs"><UiIcon name="image" />{{ t('imagePlaceholder') }}</span>
        </div>
        <dl class="metadata-grid grid grid-cols-2 gap-x-4 gap-y-3 m-0 pt-1 text-[11px]">
          <div><dt class="muted mb-1">{{ t('lastCopiedAt') }}</dt><dd class="m-0">{{ formatDate(item.lastCopiedAt, locale) }}</dd></div>
          <div><dt class="muted mb-1">{{ t('copyCount') }}</dt><dd class="m-0">{{ item.copyCount }}</dd></div>
          <div><dt class="muted mb-1">{{ t('createdAt') }}</dt><dd class="m-0">{{ formatDate(item.createdAt, locale) }}</dd></div>
          <div><dt class="muted mb-1">{{ t('size') }}</dt><dd class="m-0">{{ formatBytes(item.byteSize) }}<span v-if="item.kind === 'image'" class="muted"> · {{ item.width }} × {{ item.height }}</span></dd></div>
        </dl>
      </div>
      <div class="row justify-between gap-2 px-4 py-3 border-t border-[var(--clip-border)]">
        <div class="row gap-2">
          <ElButton type="primary" size="small" :disabled="busy" data-action="copy-entry" @click="emit('copy')"><UiIcon name="copy" :size="14" />{{ t('copy') }}<kbd class="ml-1 opacity-65 text-[10px]">↵</kbd></ElButton>
          <ElButton size="small" :disabled="busy" data-action="pin-entry" @click="emit('pin')"><UiIcon name="pin" :size="14" />{{ t(item.pinned ? 'unpin' : 'pin') }}</ElButton>
        </div>
        <ElButton size="small" :disabled="busy" class="delete-button" :aria-label="t('delete')" data-action="delete-entry" @click="emit('delete')"><UiIcon name="trash" :size="14" /><span class="hidden sm:inline">{{ t('delete') }}</span></ElButton>
      </div>
    </template>
  </section>
</template>
