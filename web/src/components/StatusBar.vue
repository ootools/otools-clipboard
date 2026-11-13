<script setup lang="ts">
import { computed } from 'vue'
import { ElButton } from 'element-plus'
import type { ClipboardStatus } from '../types'
import type { Translate } from '../i18n/messages'
import { formatBytes } from '../composables/format'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ mode: 'host' | 'preview'; status: ClipboardStatus | null; paused: boolean; isRecording: boolean; protocolRequired: boolean; statusFailed: boolean; eventsFailed: boolean; t: Translate }>()
const emit = defineEmits<{ retry: []; preview: [] }>()
const stateLabel = computed(() => props.mode === 'preview' ? props.t('preview') : props.paused ? props.t('paused') : props.isRecording ? props.t('recording') : props.status ? props.t('inactive') : props.t('connecting'))
const sourceMessage = computed(() => {
  if (props.mode === 'preview' || props.protocolRequired || props.paused) return ''
  if (props.status?.sourceStatus === 'unsupported') return props.t('unsupported')
  if (props.status?.sourceStatus === 'unavailable') return props.t('unavailable')
  if (props.status?.sourceStatus === 'busy') return props.t('busySource')
  return ''
})
</script>

<template>
  <div class="flex flex-col gap-2">
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
    <div class="row flex-wrap justify-between gap-y-2 text-xs muted" aria-live="polite">
      <span class="status-pill row" :class="{ 'is-live': isRecording, 'is-preview': mode === 'preview', 'is-paused': paused }" data-testid="recording-status">
        <span class="status-dot" /><span>{{ stateLabel }}</span>
      </span>
      <span v-if="status" class="row flex-wrap gap-x-4">
        <span>{{ status.totalEntries }} {{ t('entries') }}</span>
        <span>{{ formatBytes(status.storageBytes) }} <span class="opacity-70">{{ t('storage') }}</span></span>
        <span v-if="status.droppedEvents" class="warning-text">{{ status.droppedEvents }} {{ t('dropped') }}</span>
      </span>
    </div>
    <p v-if="paused && mode === 'host'" class="m-0 text-xs muted">{{ t('pausedHelp') }}</p>
    <p v-if="sourceMessage" class="m-0 text-xs warning-text" role="status">{{ sourceMessage }}</p>
    <p v-if="eventsFailed" class="m-0 text-xs warning-text">{{ t('eventsUnavailable') }}</p>
    <p v-if="status?.lastError" class="m-0 text-xs error-text break-words" role="alert">{{ status.lastError }}</p>
  </div>
</template>
