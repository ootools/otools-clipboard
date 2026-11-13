<script setup lang="ts">
import { computed } from 'vue'
import type { ClipboardError } from '../api/errors'
import type { Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ error: ClipboardError; t: Translate; compact?: boolean }>()
const message = computed(() => props.t(props.error.code === 'COPY_UNAVAILABLE' ? 'copyUnavailable' : props.error.code === 'COPY_FAILED' ? 'copyFailed' : props.error.code === 'INVALID_SETTINGS' ? 'positiveInteger' : props.error.code === 'INVALID_REPLY' ? 'invalidReply' : 'nativeError'))
</script>

<template>
  <div class="error-notice row text-sm" :class="compact ? 'p-2' : 'p-3'" role="alert">
    <UiIcon name="info" :size="16" />
    <div class="min-w-0 flex-1">
      <p class="m-0 font-medium">{{ message }}</p>
      <p v-if="!['COPY_UNAVAILABLE', 'COPY_FAILED', 'INVALID_SETTINGS'].includes(error.code)" class="m-0 mt-1 text-xs break-words opacity-80">{{ error.operation }} · {{ error.message }}</p>
    </div>
  </div>
</template>
