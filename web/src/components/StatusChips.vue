<script setup lang="ts">
import { computed } from 'vue'
import type { ClipboardStatus } from '../types'
import type { Translate } from '../i18n/messages'
import { formatBytes } from '../composables/format'
const props = defineProps<{ mode: 'host' | 'preview'; status: ClipboardStatus | null; paused: boolean; isRecording: boolean; t: Translate }>()
const stateLabel = computed(() => props.mode === 'preview' ? props.t('preview') : props.paused ? props.t('paused') : props.isRecording ? props.t('recording') : props.status ? props.t('inactive') : props.t('connecting'))
</script>

<template>
  <span class="row flex-wrap items-center gap-x-2 gap-y-1 text-[11px] muted min-w-0" aria-live="polite">
    <span class="status-pill row" :class="{ 'is-live': isRecording, 'is-preview': mode === 'preview', 'is-paused': paused }" data-testid="recording-status">
      <span class="status-dot" /><span>{{ stateLabel }}</span>
    </span>
    <span v-if="status" class="row items-center gap-2 whitespace-nowrap">
      <span>{{ status.totalEntries }} {{ t('entries') }}</span>
      <span>{{ formatBytes(status.storageBytes) }} <span class="opacity-70">{{ t('storage') }}</span></span>
      <span v-if="status.droppedEvents" class="warning-text whitespace-nowrap">{{ status.droppedEvents }} {{ t('dropped') }}</span>
    </span>
  </span>
</template>
