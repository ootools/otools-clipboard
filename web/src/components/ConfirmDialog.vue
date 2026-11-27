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
const validDay = (value: string | null): value is string => value !== null && dayjs(value).isValid() && dayjs(value).format('YYYY-MM-DD') === value
const rangeReady = computed(() => {
  if (!clear.value || clear.value.scope !== 'range') return true
  return validDay(clear.value.from) && validDay(clear.value.until) && clear.value.from! <= clear.value.until!
})
</script>

<template>
  <ElDialog :model-value="confirmation !== null" :title="t(confirmation?.type === 'delete' ? 'deleteTitle' : 'clearTitle')" custom-class="confirm-dialog" width="min(400px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && emit('cancel')">
    <div v-if="confirmation" class="confirm-body">
      <p class="confirm-help">{{ t(confirmation.type === 'delete' ? 'deleteHelp' : 'clearHelp') }}</p>
      <p v-if="confirmation.type === 'delete' && confirmation.item.pinned" class="confirm-warning" role="alert"><UiIcon name="pin" :size="14" />{{ t('pinnedDeleteWarning') }}</p>
      <pre v-if="confirmation.type === 'delete'" class="confirm-preview">{{ confirmation.item.preview }}</pre>
      <template v-else>
        <ElRadioGroup :model-value="confirmation.scope" :disabled="busy" class="confirm-scope" @update:model-value="emit('scope', $event as 'all' | 'range')">
          <ElRadio value="all" data-testid="clear-scope-all">{{ t('clearScopeAll') }}</ElRadio>
          <ElRadio value="range" data-testid="clear-scope-range">{{ t('clearScopeRange') }}</ElRadio>
        </ElRadioGroup>
        <div v-if="confirmation.scope === 'range'" class="confirm-range">
          <span data-testid="clear-from"><span class="drawer-label">{{ t('clearFrom') }}</span><ElDatePicker class="clear-date" :model-value="confirmation.from" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :disabled="busy" :placeholder="t('clearFrom')" @update:model-value="emit('range', { from: $event as string | null, until: confirmation.until })" /></span>
          <span data-testid="clear-to"><span class="drawer-label">{{ t('clearTo') }}</span><ElDatePicker class="clear-date" :model-value="confirmation.until" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :disabled="busy" :placeholder="t('clearTo')" @update:model-value="emit('range', { from: confirmation.from, until: $event as string | null })" /></span>
        </div>
        <p v-if="confirmation.scope === 'range' && !rangeReady" class="drawer-warning" role="alert">{{ t('clearRangeInvalid') }}</p>
        <ElCheckbox :model-value="confirmation.includePinned" :disabled="busy" data-testid="include-pinned" @update:model-value="emit('includePinned', $event === true)">{{ t('includePinned') }}</ElCheckbox>
        <p v-if="confirmation.includePinned" class="confirm-warning" role="alert">{{ t('includePinnedWarning') }}</p>
      </template>
      <ErrorNotice v-if="error" :error="error" :t="t" compact />
    </div>
    <template #footer>
      <ElButton size="small" :disabled="busy" @click="emit('cancel')">{{ t('cancel') }}</ElButton>
      <ElButton type="danger" size="small" :loading="busy" :disabled="!rangeReady" :data-action="confirmation?.type === 'delete' ? 'confirm-delete' : 'confirm-clear'" @click="emit('confirm')">{{ t(confirmation?.type === 'delete' ? 'confirmDelete' : 'confirmClear') }}</ElButton>
    </template>
  </ElDialog>
</template>
