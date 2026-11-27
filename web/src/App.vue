<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import type { ClipboardApi, ClipboardSettings } from './types'
import { createClipboardApi } from './api/clipboard'
import { createPreviewApi, isExplicitPreview } from './api/preview'
import { useClipboardHistory } from './composables/useClipboardHistory'
import { useAppearance } from './composables/useAppearance'
import { useHistoryKeyboard } from './composables/useHistoryKeyboard'
import { formatBytes } from './composables/format'
import StatusChips from './components/StatusChips.vue'
import StatusNotices from './components/StatusNotices.vue'
import HistoryFilters from './components/HistoryFilters.vue'
import HistoryList from './components/HistoryList.vue'
import HistoryDetail from './components/HistoryDetail.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ErrorNotice from './components/ErrorNotice.vue'
import UiIcon from './components/UiIcon.vue'

const props = defineProps<{ api?: ClipboardApi }>()
let previewStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined
try { previewStorage = window.localStorage } catch { /* Host or preview storage can be unavailable. */ }
const api = props.api ?? (isExplicitPreview(window.location.search) ? createPreviewApi(previewStorage) : createClipboardApi())
const history = useClipboardHistory(api)
const { t, locale, theme, setLocale, setTheme } = useAppearance()
const {
  mode, query, kind, pinnedOnly, date, page, pageCount, items, total, selectedId, selectedItem, detail,
  selectedImage, thumbnails, settings, status, paused, isRecording, protocolRequired, listLoading,
  detailLoading, busy, listError, detailError, settingsError, statusError, eventsError, operationError,
  feedback, confirmation,
} = history
const settingsOpen = ref(false)
const mobileDetail = ref(false)
const filters = ref<InstanceType<typeof HistoryFilters>>()
const filtered = computed(() => !!query.value || kind.value !== 'all' || pinnedOnly.value)
const uiLocale = computed(() => locale.value === 'en-US' ? en : zhCn)
useHistoryKeyboard({ move: delta => history.moveSelection(delta), copy: () => history.copySelected(), focusSearch: () => { void filters.value?.focus() }, isBlocked: () => settingsOpen.value || confirmation.value !== null || busy.value })
onMounted(() => { void history.initialize() })
async function saveSettings(patch: Partial<ClipboardSettings>) { if (await history.saveSettings(patch)) settingsOpen.value = false }
function showPreview() { const url = new URL(window.location.href); url.searchParams.set('preview', '1'); window.location.assign(url.toString()) }
function select(id: string) { mobileDetail.value = true; void history.select(id) }
</script>

<template>
  <ElConfigProvider :locale="uiLocale" size="small">
    <main class="clipboard-app flex flex-col w-full h-full min-h-0" :data-mode="mode" :data-theme="theme">
      <header class="app-header shrink-0">
        <div class="command-bar">
          <div class="brand-lockup">
            <span class="app-mark"><UiIcon name="clipboard" :size="16" /></span>
            <h1 class="app-title">{{ t('title') }}</h1>
          </div>
          <HistoryFilters ref="filters" :query="query" :kind="kind" :pinned-only="pinnedOnly" :date="date" :t="t" :locale="locale" @query="history.setQuery" @kind="history.setKind" @pinned="history.setPinnedOnly" @date="history.setDate" />
          <StatusChips :mode="mode" :status="status" :paused="paused" :is-recording="isRecording" :busy="busy" :t="t" @toggle="history.togglePaused()" />
          <button type="button" class="text-link settings-entry" data-action="open-settings" @click="settingsOpen = true"><UiIcon name="settings" :size="14" /><span>{{ t('settings') }}</span></button>
        </div>
        <StatusNotices :mode="mode" :status="status" :paused="paused" :protocol-required="protocolRequired" :status-failed="statusError !== null" :events-failed="eventsError !== null" :t="t" @retry="history.refreshStatus(); history.refresh()" @preview="showPreview" />
        <div class="inline-alerts">
          <div v-if="operationError && !confirmation && !settingsOpen" class="alert alert-error"><ErrorNotice :error="operationError" :t="t" compact /></div>
          <div v-else-if="feedback && !confirmation && !settingsOpen" class="alert alert-ok" role="status"><UiIcon name="check" :size="13" />{{ t(feedback.key, { count: feedback.count ?? 0 }) }}</div>
        </div>
      </header>

      <div class="workspace-grid" :class="{ 'show-detail': mobileDetail }">
        <HistoryList :items="items" :total="total" :page="page" :page-count="pageCount" :page-size="history.pageSize" :selected-id="selectedId" :thumbnails="thumbnails" :loading="listLoading" :error="listError" :filtered="filtered" :locale="locale" :t="t" @select="select" @page="history.setPage" @retry="history.refresh" />
        <HistoryDetail :item="selectedItem" :detail="detail" :image="selectedImage" :loading="detailLoading" :error="detailError" :busy="busy" :locale="locale" :t="t" @copy="history.copySelected" @pin="history.togglePin()" @delete="history.requestDelete()" @retry="history.select(selectedId)" @back="mobileDetail = false" />
      </div>

      <footer class="status-bar">
        <span class="status-hint" :title="t('localHelp')"><UiIcon name="info" :size="12" /><span class="truncate">{{ t('localHelp') }}</span></span>
        <span class="status-spacer" />
        <span class="status-metrics">
          <span v-if="status" class="whitespace-nowrap">{{ status.totalEntries }} {{ t('entries') }} · {{ formatBytes(status.storageBytes) }}</span>
          <span class="status-shortcut whitespace-nowrap">{{ t('shortcut') }}</span>
        </span>
        <span class="status-divider" />
        <button type="button" class="text-link danger" :disabled="busy || (status?.totalEntries ?? total) === 0" data-action="clear-history" @click="history.requestClear()"><UiIcon name="trash" :size="12" /><span>{{ t('clear') }}</span></button>
        <span class="version">v0.1.3</span>
      </footer>

      <SettingsDialog :open="settingsOpen" :settings="settings" :busy="busy" :error="operationError ?? settingsError" :locale="locale" :theme="theme" :t="t" @close="settingsOpen = false" @save="saveSettings" @locale="setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')" @theme="setTheme(theme === 'dark' ? 'light' : 'dark')" />
      <ConfirmDialog :confirmation="confirmation" :busy="busy" :error="operationError" :t="t" @cancel="history.cancelConfirmation" @confirm="history.confirmAction" @include-pinned="history.setClearIncludePinned" @scope="history.setClearScope" @range="history.setClearRange" />
    </main>
  </ElConfigProvider>
</template>
