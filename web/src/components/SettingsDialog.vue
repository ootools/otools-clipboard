<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInput } from 'element-plus'
import type { ClipboardSettings } from '../types'
import type { ClipboardError } from '../api/errors'
import type { Locale, Translate } from '../i18n/messages'
import ErrorNotice from './ErrorNotice.vue'

const props = defineProps<{ open: boolean; settings: ClipboardSettings | null; busy: boolean; error: ClipboardError | null; locale: Locale; theme: 'light' | 'dark'; t: Translate }>()
const emit = defineEmits<{ close: []; save: [patch: Partial<ClipboardSettings>]; locale: []; theme: [] }>()
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
  <ElDialog :model-value="open" :title="t('settings')" custom-class="drawer-dialog" width="min(380px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="!$event && emit('close')">
    <form class="drawer-form" @submit.prevent="save">
      <p class="drawer-subtitle">{{ t('settingsHelp') }}</p>
      <div class="drawer-group">
        <span class="drawer-group-title">{{ t('record') }}</span>
        <div class="drawer-grid">
          <div><label for="max-entries" class="drawer-label">{{ t('maxEntries') }}</label><ElInput id="max-entries" v-model="maxEntries" inputmode="numeric" :disabled="busy || !settings" /></div>
          <div><label for="retention-days" class="drawer-label">{{ t('retentionDays') }}</label><ElInput id="retention-days" v-model="retentionDays" inputmode="numeric" :disabled="busy || !settings" /></div>
        </div>
        <div><label for="max-mib" class="drawer-label">{{ t('maxMiB') }}</label><ElInput id="max-mib" v-model="maxMiB" inputmode="decimal" :disabled="busy || !settings" /></div>
      </div>
      <div class="drawer-group">
        <span class="drawer-group-title">{{ t('appearance') }}</span>
        <button type="button" class="drawer-row" data-action="set-locale" @click="emit('locale')"><span>{{ t('language') }}</span><span class="drawer-value">{{ locale === 'zh-CN' ? '简体中文' : 'English' }}</span></button>
        <button type="button" class="drawer-row" data-action="set-theme" @click="emit('theme')"><span>{{ t('theme') }}</span><span class="drawer-value">{{ theme === 'dark' ? t('dark') : t('light') }}</span></button>
      </div>
      <p class="drawer-warning">{{ t('settingsCleanupWarning') }}</p>
      <p v-if="submitted && !valid" class="drawer-error" role="alert">{{ t('positiveInteger') }}</p>
      <ErrorNotice v-if="error" :error="error" :t="t" compact />
    </form>
    <template #footer>
      <ElButton size="small" :disabled="busy" @click="emit('close')">{{ t('cancel') }}</ElButton>
      <ElButton type="primary" size="small" :loading="busy" :disabled="!settings" data-action="save-settings" @click="save">{{ t('save') }}</ElButton>
    </template>
  </ElDialog>
</template>
