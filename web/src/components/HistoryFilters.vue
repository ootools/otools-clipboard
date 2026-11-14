<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElButton, ElDatePicker, ElInput } from 'element-plus'
import type { KindFilter } from '../types'
import type { Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'
defineProps<{ query: string; kind: KindFilter; pinnedOnly: boolean; date: string | null; t: Translate }>()
const emit = defineEmits<{ query: [value: string]; kind: [value: KindFilter]; pinned: [value: boolean]; date: [value: string | null] }>()
const input = ref<InstanceType<typeof ElInput>>()
defineExpose({ focus: async () => { await nextTick(); input.value?.focus(); input.value?.input?.select() } })
</script>

<template>
  <div class="toolbar-row row flex-wrap items-center gap-2 shrink-0">
    <ElInput ref="input" class="search-input" :model-value="query" :placeholder="t('search')" :aria-label="t('search')" clearable data-testid="search" @update:model-value="emit('query', $event)">
      <template #prefix><UiIcon name="search" :size="16" /></template>
      <template #suffix><kbd class="hidden sm:inline text-[10px]">⌘ / Ctrl F</kbd></template>
    </ElInput>
    <div class="filter-group row gap-1 p-1" :aria-label="t('all')">
      <ElButton v-for="filter in (['all', 'text', 'image'] as const)" :key="filter" size="small" :class="{ 'filter-active': kind === filter }" :aria-pressed="kind === filter" :data-filter="filter" @click="emit('kind', filter)">
        <UiIcon v-if="filter !== 'all'" :name="filter" :size="14" /><span>{{ t(filter) }}</span>
      </ElButton>
    </div>
    <ElButton size="small" :class="{ 'filter-active': pinnedOnly }" :aria-pressed="pinnedOnly" data-filter="pinned" @click="emit('pinned', !pinnedOnly)">
      <UiIcon name="pin" :size="14" /><span>{{ t('pinnedOnly') }}</span>
    </ElButton>
    <span class="date-field row shrink-0" role="group" :aria-label="t('dateFilter')" :title="t('dateFilter')" data-testid="date-filter">
      <ElDatePicker class="date-filter" :model-value="date" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :placeholder="t('dateAll')" @update:model-value="emit('date', $event as string | null)" />
    </span>
  </div>
</template>
