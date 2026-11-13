<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInput } from 'element-plus'
import type { ClipboardSettings } from '../types'
import type { ClipboardError } from '../api/errors'
import type { Translate } from '../i18n/messages'
import ErrorNotice from './ErrorNotice.vue'
const props = defineProps<{ open: boolean; settings: ClipboardSettings | null; busy: boolean; error: ClipboardError | null; t: Translate }>()
const emit = defineEmits<{ close: []; save: [patch: Partial<ClipboardSettings>] }>()
const maxEntries = ref('500')
const retentionDays = ref('30')
const maxMiB = ref('256')
const submitted = ref(false)
watch(() => props.open, open => {
  if (!open) return
  maxEntries.value = String(props.settings?.maxEntries ?? 500)
  retentionDays.value = String(props.settings?.retentionDays ?? 30)
  maxMiB.value = String((props.settings?.maxBytes ?? 268435456) / 1048576)
  submitted.value = false
})
const valid = computed(() => {
  const entries = Number(maxEntries.value)
  const days = Number(retentionDays.value)
  const mib = Number(maxMiB.value)
  const bytes = mib * 1048576
  return /^\d+$/.test(maxEntries.value) && /^\d+$/.test(retentionDays.value) && Number.isFinite(mib) &&
    Number.isSafeInteger(entries) && entries > 0 && Number.isSafeInteger(days) && days > 0 && Number.isSafeInteger(bytes) && bytes > 0
})
function save() {
  submitted.value = true
  if (!valid.value || props.busy || !props.settings) return
  emit('save', { maxEntries: Number(maxEntries.value), retentionDays: Number(retentionDays.value), maxBytes: Number(maxMiB.value) * 1048576 })
}
</script>

<template>
  <ElDialog :model-value="open" :title="t('settings')" width="min(460px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="save">
      <div class="grid grid-cols-2 gap-4">
        <div><label for="max-entries" class="block text-xs mb-2">{{ t('maxEntries') }}</label><ElInput id="max-entries" v-model="maxEntries" inputmode="numeric" :disabled="busy || !settings" /></div>
        <div><label for="retention-days" class="block text-xs mb-2">{{ t('retentionDays') }}</label><ElInput id="retention-days" v-model="retentionDays" inputmode="numeric" :disabled="busy || !settings" /></div>
      </div>
      <div><label for="max-mib" class="block text-xs mb-2">{{ t('maxMiB') }}</label><ElInput id="max-mib" v-model="maxMiB" inputmode="decimal" :disabled="busy || !settings" /></div>
      <p class="m-0 text-xs leading-relaxed muted">{{ t('settingsHelp') }}</p>
      <p class="m-0 text-xs warning-text">{{ t('settingsCleanupWarning') }}</p>
      <p v-if="submitted && !valid" class="m-0 text-xs error-text" role="alert">{{ t('positiveInteger') }}</p>
      <ErrorNotice v-if="error" :error="error" :t="t" compact />
    </form>
    <template #footer>
      <ElButton size="small" :disabled="busy" @click="emit('close')">{{ t('cancel') }}</ElButton>
      <ElButton type="primary" size="small" :loading="busy" :disabled="!settings" data-action="save-settings" @click="save">{{ t('save') }}</ElButton>
    </template>
  </ElDialog>
</template>
