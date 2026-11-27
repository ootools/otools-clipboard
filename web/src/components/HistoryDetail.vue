<script setup lang="ts">
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
  <section class="detail-panel" :aria-label="t('details')">
    <div class="detail-head">
      <span class="detail-label">{{ t('selected') }}</span>
      <button type="button" class="mobile-back" @click="emit('back')">{{ t('showHistory') }}</button>
      <span v-if="item?.pinned" class="detail-pinned"><UiIcon name="pin" :size="12" />{{ t('pinned') }}</span>
    </div>

    <div v-if="!item" class="detail-empty">
      <span class="empty-mark"><UiIcon name="copy" :size="24" /></span>
      <h2 class="empty-title">{{ t('selectEntry') }}</h2>
      <p class="empty-help">{{ t('selectEntryHelp') }}</p>
    </div>

    <template v-else>
      <div class="detail-body">
        <div v-if="error" class="detail-error">
          <ErrorNotice :error="error" :t="t" />
          <button type="button" class="state-action" @click="emit('retry')">{{ t('retry') }}</button>
        </div>
        <div v-else-if="loading" class="preview-box preview-loading" role="status"><span class="loading-dot" />{{ t('loading') }}</div>
        <pre v-else-if="item.kind === 'text'" data-testid="full-text" class="preview-box preview-text">{{ detail?.text ?? '' }}</pre>
        <div v-else class="preview-box preview-image">
          <img v-if="image" :src="image.dataUrl" :alt="t('imagePlaceholder')" />
          <span v-else class="preview-placeholder"><UiIcon name="image" :size="20" />{{ t('imagePlaceholder') }}</span>
        </div>

        <p class="detail-meta">
          {{ t('lastCopiedAt') }} · {{ formatDate(item.lastCopiedAt, locale) }}<span class="meta-dot">·</span>{{ t('copyCount') }} {{ item.copyCount }}<span class="meta-dot">·</span>{{ formatBytes(item.byteSize) }}<span v-if="item.kind === 'image'" class="meta-dot">·</span><span v-if="item.kind === 'image'">{{ item.width }} × {{ item.height }}</span>
        </p>
      </div>

      <div class="detail-actions">
        <button type="button" class="primary-action" :disabled="busy" data-action="copy-entry" @click="emit('copy')"><UiIcon name="copy" :size="14" />{{ t('copyToClipboard') }}</button>
        <p class="key-hint">{{ t('keyboardHint') }}</p>
        <div class="secondary-actions">
          <button type="button" :disabled="busy" data-action="pin-entry" @click="emit('pin')"><UiIcon name="pin" :size="13" />{{ t(item.pinned ? 'unpin' : 'pin') }}</button>
          <span class="action-dot">·</span>
          <button type="button" class="danger-link" :disabled="busy" data-action="delete-entry" @click="emit('delete')"><UiIcon name="trash" :size="13" />{{ t('delete') }}</button>
        </div>
      </div>
    </template>
  </section>
</template>
