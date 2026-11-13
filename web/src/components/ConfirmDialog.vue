<script setup lang="ts">
import { ElButton, ElCheckbox, ElDialog } from 'element-plus'
import type { Confirmation } from '../composables/useClipboardHistory'
import type { ClipboardError } from '../api/errors'
import type { Translate } from '../i18n/messages'
import ErrorNotice from './ErrorNotice.vue'
import UiIcon from './UiIcon.vue'
defineProps<{ confirmation: Confirmation | null; busy: boolean; error: ClipboardError | null; t: Translate }>()
const emit = defineEmits<{ cancel: []; confirm: []; includePinned: [value: boolean] }>()
</script>

<template>
  <ElDialog :model-value="confirmation !== null" :title="t(confirmation?.type === 'delete' ? 'deleteTitle' : 'clearTitle')" width="min(430px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && emit('cancel')">
    <div v-if="confirmation" class="flex flex-col gap-3">
      <p class="m-0 text-sm leading-relaxed muted">{{ t(confirmation.type === 'delete' ? 'deleteHelp' : 'clearHelp') }}</p>
      <p v-if="confirmation.type === 'delete' && confirmation.item.pinned" class="warning-notice row m-0 p-3 text-xs" role="alert"><UiIcon name="pin" :size="16" />{{ t('pinnedDeleteWarning') }}</p>
      <pre v-if="confirmation.type === 'delete'" class="content-preview m-0 p-3 max-h-24 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{{ confirmation.item.preview }}</pre>
      <template v-else>
        <ElCheckbox :model-value="confirmation.includePinned" :disabled="busy" data-testid="include-pinned" @update:model-value="emit('includePinned', $event === true)">{{ t('includePinned') }}</ElCheckbox>
        <p v-if="confirmation.includePinned" class="warning-notice m-0 p-3 text-xs" role="alert">{{ t('includePinnedWarning') }}</p>
      </template>
      <ErrorNotice v-if="error" :error="error" :t="t" compact />
    </div>
    <template #footer>
      <ElButton size="small" :disabled="busy" @click="emit('cancel')">{{ t('cancel') }}</ElButton>
      <ElButton type="danger" size="small" :loading="busy" :data-action="confirmation?.type === 'delete' ? 'confirm-delete' : 'confirm-clear'" @click="emit('confirm')">{{ t(confirmation?.type === 'delete' ? 'confirmDelete' : 'confirmClear') }}</ElButton>
    </template>
  </ElDialog>
</template>
