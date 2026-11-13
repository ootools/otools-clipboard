<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import type { KindFilter } from '../types'
import type { Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'
defineProps<{ query: string; kind: KindFilter; pinnedOnly: boolean; t: Translate }>()
const emit = defineEmits<{ query: [value: string]; kind: [value: KindFilter]; pinned: [value: boolean] }>()
const input = ref<InstanceType<typeof ElInput>>()
defineExpose({ focus: async () => { await nextTick(); input.value?.focus(); input.value?.input?.select() } })
</script>

<template>
  <div class="flex flex-col gap-3">
    <ElInput ref="input" :model-value="query" :placeholder="t('search')" :aria-label="t('search')" clearable data-testid="search" @update:model-value="emit('query', $event)">
      <template #prefix><UiIcon name="search" :size="17" /></template>
      <template #suffix><kbd class="hidden sm:inline text-[10px]">⌘ / Ctrl F</kbd></template>
    </ElInput>
    <div class="row justify-between flex-wrap gap-y-2">
      <div class="filter-group row gap-1 p-1" :aria-label="t('all')">
        <ElButton v-for="filter in (['all', 'text', 'image'] as const)" :key="filter" size="small" :class="{ 'filter-active': kind === filter }" :aria-pressed="kind === filter" :data-filter="filter" @click="emit('kind', filter)">
          <UiIcon v-if="filter !== 'all'" :name="filter" :size="14" /><span>{{ t(filter) }}</span>
        </ElButton>
      </div>
      <ElButton size="small" :class="{ 'filter-active': pinnedOnly }" :aria-pressed="pinnedOnly" data-filter="pinned" @click="emit('pinned', !pinnedOnly)">
        <UiIcon name="pin" :size="14" /><span>{{ t('pinnedOnly') }}</span>
      </ElButton>
    </div>
  </div>
</template>
