<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElButton } from 'element-plus'
import type { HistoryItem } from '../types'
import type { ClipboardError } from '../api/errors'
import type { Locale, Translate } from '../i18n/messages'
import { formatBytes, formatDate } from '../composables/format'
import UiIcon from './UiIcon.vue'
import ErrorNotice from './ErrorNotice.vue'
const props = defineProps<{ items: HistoryItem[]; total: number; page: number; pageCount: number; selectedId: string | null; thumbnails: Record<string, string>; loading: boolean; error: ClipboardError | null; filtered: boolean; locale: Locale; t: Translate }>()
const emit = defineEmits<{ select: [id: string]; page: [page: number]; retry: [] }>()
const list = ref<HTMLElement | null>(null)
const firstIndex = computed(() => props.items.length ? (props.page - 1) * 40 + 1 : 0)
watch(() => props.selectedId, async id => {
  const keepRowFocus = document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-history-row]') !== null
  await nextTick()
  const selected = Array.from(list.value?.querySelectorAll<HTMLElement>('[data-history-row]') ?? []).find(element => element.dataset.historyRow === id)
  if (keepRowFocus) selected?.focus({ preventScroll: true })
  selected?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
})
</script>

<template>
  <section class="history-list panel min-h-0 flex flex-col overflow-hidden" :aria-label="t('title')">
    <div class="row justify-between px-4 py-3 border-b border-[var(--clip-border)] text-xs muted">
      <span>{{ t('all') }} <strong class="text-[var(--clip-text)] font-medium">{{ total }}</strong> {{ t('entries') }}</span>
      <span v-if="loading" class="row" role="status"><span class="loading-dot" />{{ t('loading') }}</span>
      <span v-else class="opacity-65">{{ t('localOnly') }}</span>
    </div>
    <div v-if="error" class="p-3 flex flex-col gap-3">
      <ErrorNotice :error="error" :t="t" />
      <ElButton size="small" @click="emit('retry')">{{ t('retry') }}</ElButton>
    </div>
    <div v-else-if="!items.length && !loading" class="empty-state flex-1 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span class="icon-box w-13 h-13 bg-[var(--clip-soft)] text-[var(--clip-accent)]"><UiIcon :name="filtered ? 'search' : 'clipboard'" :size="27" /></span>
      <h2 class="m-0 mt-1 font-medium text-sm">{{ t(filtered ? 'noResults' : 'noHistory') }}</h2>
      <p class="m-0 text-xs leading-relaxed muted max-w-65">{{ t(filtered ? 'noResultsHelp' : 'noHistoryHelp') }}</p>
    </div>
    <div v-else-if="!items.length" class="flex-1 p-4 flex flex-col gap-3" aria-hidden="true">
      <div v-for="index in 4" :key="index" class="skeleton h-23 rounded-2" />
    </div>
    <div v-else ref="list" class="flex-1 min-h-0 overflow-y-auto p-2" role="listbox" :aria-label="t('title')" :aria-busy="loading">
      <button v-for="item in items" :key="item.id" type="button" class="history-row focus-ring w-full text-left border border-transparent rounded-2.5 p-3 flex gap-3" :class="{ selected: selectedId === item.id }" role="option" :aria-selected="selectedId === item.id" :tabindex="selectedId === item.id ? 0 : -1" :data-history-row="item.id" @click="emit('select', item.id)">
        <span class="item-kind icon-box w-10 h-10 mt-0.5" :class="item.kind">
          <img v-if="item.kind === 'image' && thumbnails[item.id]" :src="thumbnails[item.id]" :alt="t('imagePlaceholder')" class="w-full h-full object-contain rounded-2" loading="lazy" />
          <UiIcon v-else :name="item.kind" :size="20" />
        </span>
        <span class="min-w-0 flex-1 flex flex-col gap-2">
          <span data-testid="row-top" class="row justify-between gap-2 text-[10px] muted">
            <span v-if="item.pinned" class="pin-badge row gap-1"><UiIcon name="pin" :size="11" />{{ t('pinned') }}</span>
            <time :datetime="new Date(item.lastCopiedAt).toISOString()" class="whitespace-nowrap">{{ formatDate(item.lastCopiedAt, locale, true) }}</time>
          </span>
          <span class="preview-text text-[13px] leading-relaxed whitespace-pre-wrap break-words">{{ item.preview || t('emptyText') }}</span>
          <span class="row gap-2 text-[10px] muted">
            <span class="kind-pill" data-testid="kind-pill">{{ t(item.kind) }}</span>
            <span>{{ item.kind === 'image' ? `${item.width ?? '?'} × ${item.height ?? '?'}` : formatBytes(item.byteSize) }}</span>
            <span class="row gap-1"><UiIcon name="copy" :size="11" />{{ item.copyCount }}</span>
          </span>
        </span>
      </button>
    </div>
    <div class="row justify-between px-3 py-2.5 border-t border-[var(--clip-border)] text-[11px] muted">
      <span>{{ firstIndex }}–{{ firstIndex ? firstIndex + items.length - 1 : 0 }} / {{ total }}</span>
      <div class="row gap-2">
        <ElButton size="small" :aria-label="t('previous')" :disabled="page <= 1 || loading" @click="emit('page', page - 1)"><UiIcon name="arrow-left" :size="14" /></ElButton>
        <span>{{ page }} / {{ pageCount }}</span>
        <ElButton size="small" :aria-label="t('next')" :disabled="page >= pageCount || loading" @click="emit('page', page + 1)"><UiIcon name="arrow-right" :size="14" /></ElButton>
      </div>
    </div>
  </section>
</template>
