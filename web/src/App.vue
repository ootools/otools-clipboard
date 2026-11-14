<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElButton, ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import type { ClipboardApi, ClipboardSettings } from './types'
import { createClipboardApi } from './api/clipboard'
import { createPreviewApi, isExplicitPreview } from './api/preview'
import { useClipboardHistory } from './composables/useClipboardHistory'
import { useAppearance } from './composables/useAppearance'
import { useHistoryKeyboard } from './composables/useHistoryKeyboard'
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
  detailLoading, busy, listError, detailError, settingsError, statusError, eventsError, operationError, feedback, confirmation,
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
    <main class="clipboard-app flex flex-col w-full h-full min-h-0 p-3 sm:p-4 gap-2.5" :data-mode="mode" :data-theme="theme">
      <header class="row items-center justify-between gap-x-3 gap-y-2 flex-wrap shrink-0">
        <div class="row items-center gap-2.5 min-w-0">
          <span class="app-mark icon-box w-9 h-9"><UiIcon name="clipboard" :size="20" /></span>
          <div class="min-w-0">
            <div class="row flex-wrap items-center gap-x-2 gap-y-1">
              <h1 class="m-0 text-[15px] leading-5 font-semibold tracking-tight">{{ t('title') }}</h1>
              <StatusChips :mode="mode" :status="status" :paused="paused" :is-recording="isRecording" :t="t" />
            </div>
            <p class="m-0 mt-px text-[10px] leading-4 muted truncate">{{ t('subtitle') }}</p>
          </div>
        </div>
        <div class="row shrink-0 gap-1 flex-wrap justify-end">
          <ElButton size="small" :title="t(paused ? 'resume' : 'pause')" :disabled="busy || !settings" data-action="toggle-pause" @click="history.togglePaused()"><UiIcon :name="paused ? 'play' : 'pause'" :size="14" /><span>{{ t(paused ? 'resume' : 'pause') }}</span></ElButton>
          <ElButton size="small" :aria-label="t('refresh')" :title="t('refresh')" :disabled="listLoading || busy" @click="history.refresh(); history.refreshStatus()"><UiIcon name="refresh" :size="15" /></ElButton>
          <ElButton size="small" :aria-label="t('settings')" :title="t('settings')" data-action="open-settings" @click="settingsOpen = true"><UiIcon name="settings" :size="15" /></ElButton>
          <ElButton size="small" :aria-label="t('language')" :title="t('language')" class="locale-button" @click="setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')">{{ locale === 'zh-CN' ? 'EN' : '中' }}</ElButton>
          <ElButton size="small" :aria-label="t('theme')" :title="t('theme')" @click="setTheme(theme === 'dark' ? 'light' : 'dark')"><UiIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" /></ElButton>
        </div>
      </header>
      <StatusNotices :mode="mode" :status="status" :paused="paused" :protocol-required="protocolRequired" :status-failed="statusError !== null" :events-failed="eventsError !== null" :t="t" @retry="history.refreshStatus(); history.refresh()" @preview="showPreview" />
      <div v-if="operationError && !confirmation && !settingsOpen" class="shrink-0"><ErrorNotice :error="operationError" :t="t" compact /></div>
      <div v-else-if="feedback && !confirmation && !settingsOpen" class="feedback-notice row p-2 text-xs shrink-0" role="status"><UiIcon name="check" :size="14" />{{ t(feedback.key, { count: feedback.count ?? 0 }) }}</div>
      <HistoryFilters ref="filters" :query="query" :kind="kind" :pinned-only="pinnedOnly" :date="date" :t="t" @query="history.setQuery" @kind="history.setKind" @pinned="history.setPinnedOnly" @date="history.setDate" />
      <div class="workspace-grid grid gap-3 flex-1 min-h-0" :class="{ 'show-detail': mobileDetail }">
        <HistoryList :items="items" :total="total" :page="page" :page-count="pageCount" :selected-id="selectedId" :thumbnails="thumbnails" :loading="listLoading" :error="listError" :filtered="filtered" :locale="locale" :t="t" @select="select" @page="history.setPage" @retry="history.refresh" />
        <HistoryDetail :item="selectedItem" :detail="detail" :image="selectedImage" :loading="detailLoading" :error="detailError" :busy="busy" :locale="locale" :t="t" @copy="history.copySelected" @pin="history.togglePin()" @delete="history.requestDelete()" @retry="history.select(selectedId)" @back="mobileDetail = false" />
      </div>
      <footer class="row items-center justify-between gap-2 text-[10px] muted shrink-0">
        <span class="row items-center gap-1 min-w-0" :title="t('localHelp')"><UiIcon name="info" :size="12" class="shrink-0" /><span class="truncate">{{ t('localHelp') }}</span></span>
        <span class="row items-center gap-2 shrink-0">
          <span class="hidden lg:inline whitespace-nowrap">{{ t('shortcut') }}</span>
          <ElButton size="small" text class="footer-clear" :disabled="busy || (status?.totalEntries ?? total) === 0" data-action="clear-history" @click="history.requestClear()"><UiIcon name="trash" :size="13" />{{ t('clear') }}</ElButton>
        </span>
      </footer>
      <SettingsDialog :open="settingsOpen" :settings="settings" :busy="busy" :error="operationError ?? settingsError" :t="t" @close="settingsOpen = false" @save="saveSettings" />
      <ConfirmDialog :confirmation="confirmation" :busy="busy" :error="operationError" :t="t" @cancel="history.cancelConfirmation" @confirm="history.confirmAction" @include-pinned="history.setClearIncludePinned" />
    </main>
  </ElConfigProvider>
</template>
