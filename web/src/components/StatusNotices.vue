<script setup lang="ts">
import { computed } from 'vue'
import { ElButton } from 'element-plus'
import type { ClipboardStatus } from '../types'
import type { Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ mode: 'host' | 'preview'; status: ClipboardStatus | null; paused: boolean; protocolRequired: boolean; statusFailed: boolean; eventsFailed: boolean; t: Translate }>()
const emit = defineEmits<{ retry: []; preview: [] }>()
const sourceMessage = computed(() => {
  if (props.mode === 'preview' || props.protocolRequired || props.paused) return ''
  if (props.status?.sourceStatus === 'unsupported') return props.t('unsupported')
  if (props.status?.sourceStatus === 'unavailable') return props.t('unavailable')
  if (props.status?.sourceStatus === 'busy') return props.t('busySource')
  return ''
})
const visible = computed(() => props.mode === 'preview'
  || props.protocolRequired
  || props.statusFailed
  || (props.paused && props.mode === 'host')
  || !!sourceMessage.value
  || props.eventsFailed
  || !!props.status?.lastError)
</script>

<template>
  <div v-if="visible" class="flex flex-col gap-2 shrink-0">
    <div v-if="mode === 'preview'" class="mode-banner row p-3 text-xs leading-relaxed" data-testid="mode-notice">
      <UiIcon name="info" :size="16" /><span>{{ t('previewBanner') }}</span>
    </div>
    <div v-else-if="protocolRequired" class="protocol-banner flex gap-3 p-3" role="status">
      <UiIcon name="info" :size="18" class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <p class="m-0 font-medium text-sm">{{ t('protocolRequired') }}</p>
        <p class="m-0 mt-1 text-xs leading-relaxed muted">{{ t('protocolHelp') }}</p>
      </div>
      <ElButton size="small" @click="emit('retry')">{{ t('refresh') }}</ElButton>
    </div>
    <div v-else-if="statusFailed" class="protocol-banner flex gap-3 p-3" role="status">
      <UiIcon name="info" :size="18" />
      <div class="min-w-0 flex-1">
        <p class="m-0 text-sm font-medium">{{ t('hostRequired') }}</p>
        <p class="m-0 mt-1 text-xs muted">{{ t('statusUnavailable') }}</p>
      </div>
      <ElButton size="small" @click="emit('preview')">{{ t('previewAction') }}</ElButton>
    </div>
    <p v-if="paused && mode === 'host' && !protocolRequired && !statusFailed" class="m-0 text-xs muted">{{ t('pausedHelp') }}</p>
    <p v-if="sourceMessage" class="m-0 text-xs warning-text" role="status">{{ sourceMessage }}</p>
    <p v-if="eventsFailed" class="m-0 text-xs warning-text">{{ t('eventsUnavailable') }}</p>
    <p v-if="status?.lastError" class="m-0 text-xs error-text break-words" role="alert">{{ status.lastError }}</p>
  </div>
</template>
