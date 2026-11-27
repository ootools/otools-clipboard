<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import dayjs from 'dayjs'
import type { HistoryItem } from '../types'
import type { ClipboardError } from '../api/errors'
import type { Locale, Translate } from '../i18n/messages'
import { formatBytes, formatDate } from '../composables/format'
import UiIcon from './UiIcon.vue'
import ErrorNotice from './ErrorNotice.vue'

const props = defineProps<{ items: HistoryItem[]; total: number; page: number; pageCount: number; pageSize: number; selectedId: string | null; thumbnails: Record<string, string>; loading: boolean; error: ClipboardError | null; filtered: boolean; locale: Locale; t: Translate }>()
const emit = defineEmits<{ select: [id: string]; page: [page: number]; retry: [] }>()
const list = ref<HTMLElement | null>(null)
const firstIndex = computed(() => props.items.length ? (props.page - 1) * props.pageSize + 1 : 0)

const groups = computed(() => {
  const today = dayjs().startOf('day')
  const yesterday = today.subtract(1, 'day')
  const buckets = [
    { key: 'today', label: props.t('today'), items: [] as HistoryItem[] },
    { key: 'yesterday', label: props.t('yesterday'), items: [] as HistoryItem[] },
    { key: 'earlier', label: props.t('earlier'), items: [] as HistoryItem[] },
  ]
  for (const item of props.items) {
    const stamp = dayjs(item.lastCopiedAt)
    if (stamp.isSame(today, 'day')) buckets[0]!.items.push(item)
    else if (stamp.isSame(yesterday, 'day')) buckets[1]!.items.push(item)
    else buckets[2]!.items.push(item)
  }
  return buckets.filter(bucket => bucket.items.length > 0)
})

watch(() => props.selectedId, async id => {
  const keepRowFocus = document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-history-row]') !== null
  await nextTick()
  const selected = Array.from(list.value?.querySelectorAll<HTMLElement>('[data-history-row]') ?? []).find(element => element.dataset.historyRow === id)
  if (keepRowFocus) selected?.focus({ preventScroll: true })
  selected?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
})
</script>

<template>
  <section class="history-list" :aria-label="t('title')">
    <div class="list-head">
      <span class="list-title">{{ t('all') }}<span class="list-count">{{ total }} {{ t('entries') }}</span></span>
      <span v-if="loading" class="list-loading" role="status"><span class="loading-dot" />{{ t('loading') }}</span>
      <span v-else class="list-note">{{ t('localOnly') }}</span>
    </div>

    <div v-if="error" class="list-state">
      <ErrorNotice :error="error" :t="t" />
      <button type="button" class="state-action" @click="emit('retry')">{{ t('retry') }}</button>
    </div>
    <div v-else-if="!items.length && !loading" class="list-state empty-state">
      <span class="empty-mark"><UiIcon :name="filtered ? 'search' : 'clipboard'" :size="24" /></span>
      <h2 class="empty-title">{{ t(filtered ? 'noResults' : 'noHistory') }}</h2>
      <p class="empty-help">{{ t(filtered ? 'noResultsHelp' : 'noHistoryHelp') }}</p>
    </div>
    <div v-else-if="!items.length" class="list-scroll" aria-hidden="true">
      <div v-for="index in 5" :key="index" class="skeleton skeleton-row" />
    </div>
    <div v-else ref="list" class="list-scroll" role="listbox" :aria-label="t('title')" :aria-busy="loading">
      <template v-for="bucket in groups" :key="bucket.key">
        <div class="group-head"><span>{{ bucket.label }}</span><span class="group-count">{{ bucket.items.length }}</span></div>
        <button v-for="item in bucket.items" :key="item.id" type="button" class="history-row" :class="{ selected: selectedId === item.id }" role="option" :aria-selected="selectedId === item.id" :tabindex="selectedId === item.id ? 0 : -1" :data-history-row="item.id" @click="emit('select', item.id)">
          <span class="row-bar" />
          <span class="row-kind" :class="item.kind">
            <img v-if="item.kind === 'image' && thumbnails[item.id]" :src="thumbnails[item.id]" :alt="t('imagePlaceholder')" class="row-thumb" loading="lazy" />
            <UiIcon v-else :name="item.kind" :size="15" />
          </span>
          <span class="row-body">
            <span class="row-summary">{{ item.preview || t('emptyText') }}</span>
            <span class="row-meta">
              <span class="kind-pill" data-testid="kind-pill">{{ t(item.kind) }}</span>
              <span data-testid="row-top" class="row-time"><time :datetime="new Date(item.lastCopiedAt).toISOString()">{{ formatDate(item.lastCopiedAt, locale, true) }}</time></span>
              <span class="meta-dot">·</span>
              <span>{{ item.kind === 'image' ? `${item.width ?? '?'} × ${item.height ?? '?'}` : formatBytes(item.byteSize) }}</span>
              <span class="meta-dot">·</span>
              <span class="row-copies"><UiIcon name="copy" :size="11" />{{ item.copyCount }}</span>
              <span v-if="item.pinned" class="row-pin"><UiIcon name="pin" :size="11" /></span>
            </span>
          </span>
        </button>
      </template>
    </div>

    <div class="list-pager">
      <span>{{ firstIndex }}–{{ firstIndex ? firstIndex + items.length - 1 : 0 }} / {{ total }}</span>
      <div class="pager-actions">
        <button type="button" :disabled="page <= 1 || loading" :aria-label="t('previous')" @click="emit('page', page - 1)"><UiIcon name="arrow-left" :size="13" /></button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button type="button" :disabled="page >= pageCount || loading" :aria-label="t('next')" @click="emit('page', page + 1)"><UiIcon name="arrow-right" :size="13" /></button>
      </div>
    </div>
  </section>
</template>
