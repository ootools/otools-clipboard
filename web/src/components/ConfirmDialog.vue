<script setup lang="ts">
import { computed } from 'vue'
import dayjs from 'dayjs'
import { ElButton, ElCheckbox, ElDatePicker, ElDialog, ElRadio, ElRadioGroup } from 'element-plus'
import type { Confirmation } from '../composables/useClipboardHistory'
import type { ClipboardError } from '../api/errors'
import type { Translate } from '../i18n/messages'
import ErrorNotice from './ErrorNotice.vue'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ confirmation: Confirmation | null; busy: boolean; error: ClipboardError | null; t: Translate }>()
const emit = defineEmits<{ cancel: []; confirm: []; includePinned: [value: boolean]; scope: [value: 'all' | 'range']; range: [value: { from: string | null; until: string | null }] }>()
const clear = computed(() => props.confirmation?.type === 'clear' ? props.confirmation : null)
// Both dates must be real calendar days in chronological order.
const validDay = (value: string | null): value is string => value !== null && dayjs(value).isValid() && dayjs(value).format('YYYY-MM-DD') === value
const rangeReady = computed(() => {
  if (!clear.value || clear.value.scope !== 'range') return true
  return validDay(clear.value.from) && validDay(clear.value.until) && clear.value.from! <= clear.value.until!
})
</script>

<template>
  <ElDialog :model-value="confirmation !== null" :title="t(confirmation?.type === 'delete' ? 'deleteTitle' : 'clearTitle')" width="min(430px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && emit('cancel')">
    <div v-if="confirmation" class="flex flex-col gap-3">
      <p class="m-0 text-sm leading-relaxed muted">{{ t(confirmation.type === 'delete' ? 'deleteHelp' : 'clearHelp') }}</p>
      <p v-if="confirmation.type === 'delete' && confirmation.item.pinned" class="warning-notice row m-0 p-3 text-xs" role="alert"><UiIcon name="pin" :size="16" />{{ t('pinnedDeleteWarning') }}</p>
      <pre v-if="confirmation.type === 'delete'" class="content-preview m-0 p-3 max-h-24 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{{ confirmation.item.preview }}</pre>
      <template v-else>
        <ElRadioGroup :model-value="confirmation.scope" :disabled="busy" class="flex flex-col gap-2" @update:model-value="emit('scope', $event as 'all' | 'range')">
          <ElRadio value="all" data-testid="clear-scope-all">{{ t('clearScopeAll') }}</ElRadio>
          <ElRadio value="range" data-testid="clear-scope-range">{{ t('clearScopeRange') }}</ElRadio>
        </ElRadioGroup>
        <div v-if="confirmation.scope === 'range'" class="row flex-wrap items-center gap-2">
          <span class="row items-center gap-1" data-testid="clear-from">
            <span class="text-[11px] muted shrink-0">{{ t('clearFrom') }}</span>
            <ElDatePicker class="clear-date" :model-value="confirmation.from" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :disabled="busy" :placeholder="t('clearFrom')" @update:model-value="emit('range', { from: $event as string | null, until: confirmation.until })" />
          </span>
          <span class="row items-center gap-1" data-testid="clear-to">
            <span class="text-[11px] muted shrink-0">{{ t('clearTo') }}</span>
            <ElDatePicker class="clear-date" :model-value="confirmation.until" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :disabled="busy" :placeholder="t('clearTo')" @update:model-value="emit('range', { from: confirmation.from, until: $event as string | null })" />
          </span>
        </div>
        <p v-if="confirmation.scope === 'range' && !rangeReady" class="m-0 text-xs warning-text" role="alert">{{ t('clearRangeInvalid') }}</p>
        <ElCheckbox :model-value="confirmation.includePinned" :disabled="busy" data-testid="include-pinned" @update:model-value="emit('includePinned', $event === true)">{{ t('includePinned') }}</ElCheckbox>
        <p v-if="confirmation.includePinned" class="warning-notice m-0 p-3 text-xs" role="alert">{{ t('includePinnedWarning') }}</p>
      </template>
      <ErrorNotice v-if="error" :error="error" :t="t" compact />
    </div>
    <template #footer>
      <ElButton size="small" :disabled="busy" @click="emit('cancel')">{{ t('cancel') }}</ElButton>
      <ElButton type="danger" size="small" :loading="busy" :disabled="!rangeReady" :data-action="confirmation?.type === 'delete' ? 'confirm-delete' : 'confirm-clear'" @click="emit('confirm')">{{ t(confirmation?.type === 'delete' ? 'confirmDelete' : 'confirmClear') }}</ElButton>
    </template>
  </ElDialog>
</template>
