<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElDatePicker } from 'element-plus'
import type { KindFilter } from '../types'
import type { Locale, Translate } from '../i18n/messages'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ query: string; kind: KindFilter; pinnedOnly: boolean; date: string | null; t: Translate; locale: Locale }>()
const emit = defineEmits<{ query: [value: string]; kind: [value: KindFilter]; pinned: [value: boolean]; date: [value: string | null] }>()
const input = ref<HTMLInputElement>()
const panelOpen = ref(false)
const activeCount = () => (props.kind !== 'all' ? 1 : 0) + (props.pinnedOnly ? 1 : 0) + (props.date ? 1 : 0)
defineExpose({ focus: async () => { await nextTick(); input.value?.focus(); input.value?.select() } })
</script>

<template>
  <div class="toolbar-row">
    <div class="search-box">
      <UiIcon name="search" :size="15" class="search-icon" />
      <input ref="input" type="search" data-testid="search" class="search-field" :value="query" :placeholder="t('search')" :aria-label="t('search')" @input="emit('query', ($event.target as HTMLInputElement).value)" />
      <kbd class="search-key">⌘ / Ctrl F</kbd>
    </div>
    <div class="filter-anchor">
      <button type="button" class="filter-trigger" :class="{ active: activeCount() > 0 }" :aria-expanded="panelOpen" data-action="toggle-filter" @click="panelOpen = !panelOpen">
        <UiIcon name="filter" :size="14" /><span>{{ t('filter') }}</span>
        <span v-if="activeCount() > 0" class="filter-count">{{ activeCount() }}</span>
      </button>
      <div v-show="panelOpen" class="filter-popover">
        <div class="popover-head">
          <span class="popover-title">{{ t('filterTitle') }}</span>
          <button type="button" class="popover-close" :aria-label="t('close')" @click="panelOpen = false"><UiIcon name="close" :size="14" /></button>
        </div>
        <div class="popover-section">
          <span class="field-label">{{ t('type') }}</span>
          <div class="segment-group" :aria-label="t('all')">
            <button v-for="value in (['all', 'text', 'image'] as const)" :key="value" type="button" size="small" :class="{ active: kind === value }" :aria-pressed="kind === value" :data-filter="value" @click="emit('kind', value)">{{ t(value) }}</button>
          </div>
        </div>
        <button type="button" class="toggle-row" :class="{ active: pinnedOnly }" :aria-pressed="pinnedOnly" data-filter="pinned" @click="emit('pinned', !pinnedOnly)">
          <UiIcon name="pin" :size="13" /><span>{{ t('pinnedOnly') }}</span><span class="toggle-mark" :class="{ on: pinnedOnly }" />
        </button>
        <div class="popover-section">
          <span class="field-label">{{ t('date') }}</span>
          <span class="date-field" role="group" :aria-label="t('dateFilter')" :title="t('dateFilter')" data-testid="date-filter">
            <ElDatePicker class="date-picker" :model-value="date" type="date" size="small" value-format="YYYY-MM-DD" clearable :teleported="true" :placeholder="t('dateAll')" @update:model-value="emit('date', $event as string | null)" />
          </span>
        </div>
        <div class="popover-foot">
          <button type="button" class="text-link" @click="emit('query', ''); emit('kind', 'all'); emit('pinned', false); emit('date', null)">{{ t('reset') }}</button>
          <button type="button" class="primary-text" @click="panelOpen = false">{{ t('apply') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
