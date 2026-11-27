<script setup lang="ts">
import { computed } from 'vue'
import type { ClipboardStatus } from '../types'
import type { Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ mode: 'host' | 'preview'; status: ClipboardStatus | null; paused: boolean; isRecording: boolean; busy: boolean; t: Translate }>()
const emit = defineEmits<{ toggle: [] }>()
const stateLabel = computed(() => props.mode === 'preview' ? props.t('preview') : props.paused ? props.t('paused') : props.isRecording ? props.t('recording') : props.status ? props.t('inactive') : props.t('connecting'))
</script>

<template>
  <div class="status-chip-group">
    <span class="status-chip" :class="{ live: isRecording, preview: mode === 'preview', paused }" data-testid="recording-status">
      <span class="status-dot" /><span>{{ stateLabel }}</span>
    </span>
    <button type="button" class="status-toggle" :title="t(paused ? 'resume' : 'pause')" :aria-label="t(paused ? 'resume' : 'pause')" :disabled="busy || mode === 'preview'" data-action="toggle-pause" @click="emit('toggle')"><UiIcon :name="paused ? 'play' : 'pause'" :size="12" /></button>
  </div>
</template>
