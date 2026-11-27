<script setup lang="ts">
import { computed } from 'vue'
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
</script>

<template>
  <div v-if="mode === 'preview' || protocolRequired || statusFailed || eventsFailed || sourceMessage || status?.lastError" class="notice-strip">
    <p v-if="mode === 'preview'" class="notice-line notice-preview" data-testid="mode-notice"><UiIcon name="info" :size="13" /><span>{{ t('previewBanner') }}</span></p>
    <p v-else-if="protocolRequired" class="notice-line" role="status"><UiIcon name="info" :size="13" /><span>{{ t('protocolRequired') }} · {{ t('protocolHelp') }}</span><button type="button" class="notice-action" @click="emit('retry')">{{ t('refresh') }}</button></p>
    <p v-else-if="statusFailed" class="notice-line" role="status"><UiIcon name="info" :size="13" /><span>{{ t('hostRequired') }} · {{ t('statusUnavailable') }}</span><button type="button" class="notice-action" @click="emit('preview')">{{ t('previewAction') }}</button></p>
    <p v-if="sourceMessage" class="notice-line warning" role="status"><UiIcon name="info" :size="13" /><span>{{ sourceMessage }}</span></p>
    <p v-if="eventsFailed" class="notice-line warning"><UiIcon name="info" :size="13" /><span>{{ t('eventsUnavailable') }}</span></p>
    <p v-if="status?.lastError" class="notice-line error" role="alert"><UiIcon name="info" :size="13" /><span>{{ status.lastError }}</span></p>
  </div>
</template>
