import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { ClipboardApi, ClipboardCopyHost, ClipboardSettings, ClipboardStatus, HistoryDetail, HistoryItem, ImageData, KindFilter, Unsubscribe } from '../types'
import { asClipboardError, type ClipboardError } from '../api/errors'
import { copyHistoryItem } from '../api/copy'
import { validateSettingsPatch } from '../api/clipboard'

export type Confirmation = { type: 'delete'; item: HistoryItem } | { type: 'clear'; includePinned: boolean }
export interface HistoryOptions { pageSize?: number; searchDelay?: number; copyHost?: ClipboardCopyHost | null }
export interface Feedback { key: 'copyRequested' | 'settingsSaved' | 'pinUpdated' | 'entryDeleted' | 'historyCleared'; count?: number }

function todayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Local-millisecond half-open bounds [from, until) for a YYYY-MM-DD key. */
export function dayBounds(value: string): { from: number; until: number } | null {
  const [year, month, day] = value.split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null
  const from = new Date(year, month - 1, day).getTime()
  const until = new Date(year, month - 1, day + 1).getTime()
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until)) return null
  return { from, until }
}

export function useClipboardHistory(api: ClipboardApi, options: HistoryOptions = {}) {
  const pageSize = options.pageSize ?? 40
  const query = ref('')
  const kind = ref<KindFilter>('all')
  const pinnedOnly = ref(false)
  // The date filter defaults to today (local calendar day); null shows every entry.
  const date = ref<string | null>(todayKey())
  const page = ref(1)
  const items = shallowRef<HistoryItem[]>([])
  const total = ref(0)
  const selectedId = ref<string | null>(null)
  const detail = shallowRef<HistoryDetail | null>(null)
  const selectedImage = shallowRef<ImageData | null>(null)
  const thumbnails = shallowRef<Record<string, string>>({})
  const settings = shallowRef<ClipboardSettings | null>(null)
  const status = shallowRef<ClipboardStatus | null>(null)
  const listLoading = ref(false)
  const detailLoading = ref(false)
  const busy = ref(false)
  const listError = shallowRef<ClipboardError | null>(null)
  const detailError = shallowRef<ClipboardError | null>(null)
  const settingsError = shallowRef<ClipboardError | null>(null)
  const statusError = shallowRef<ClipboardError | null>(null)
  const eventsError = shallowRef<ClipboardError | null>(null)
  const operationError = shallowRef<ClipboardError | null>(null)
  const feedback = shallowRef<Feedback | null>(null)
  const confirmation = shallowRef<Confirmation | null>(null)
  const paused = computed(() => settings.value?.paused ?? status.value?.paused ?? false)
  const isRecording = computed(() => api.mode === 'host' && status.value?.ready === true && status.value.recording && !paused.value)
  const protocolRequired = computed(() => api.mode === 'host' && status.value !== null && !status.value.ready)
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
  const selectedItem = computed(() => items.value.find(item => item.id === selectedId.value) ?? null)

  let disposed = false
  let initialized = false
  let pageEpoch = 0
  let selectionEpoch = 0
  let thumbnailEpoch = 0
  let settingsEpoch = 0
  let statusEpoch = 0
  let pauseRevision = 0
  let effectivePause: boolean | undefined
  let unsubscribe: Unsubscribe | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  let contentDirty = false
  let statusDirty = false
  let activeThumbnails = 0
  let thumbnailQueue: Array<{ id: string; epoch: number }> = []
  let activeSelection = false
  let pendingSelection: { id: string; epoch: number; resolve: () => void } | undefined

  function dropPendingSelection() {
    pendingSelection?.resolve()
    pendingSelection = undefined
  }
  function pumpSelection() {
    if (activeSelection || disposed || !pendingSelection) return
    const next = pendingSelection
    pendingSelection = undefined
    if (next.epoch !== selectionEpoch) { next.resolve(); pumpSelection(); return }
    activeSelection = true
    void api.getImage(next.id, false).then(value => {
      if (!disposed && next.epoch === selectionEpoch) selectedImage.value = value
    }).catch(error => {
      if (!disposed && next.epoch === selectionEpoch) detailError.value = asClipboardError(error, 'clipboard_get_image')
    }).finally(() => { activeSelection = false; next.resolve(); pumpSelection() })
  }

  const stopSearchTimer = () => { if (searchTimer !== undefined) clearTimeout(searchTimer); searchTimer = undefined }
  function clearSelection() {
    selectionEpoch++
    dropPendingSelection()
    selectedId.value = null
    detail.value = null
    selectedImage.value = null
    detailError.value = null
    detailLoading.value = false
  }
  function invalidateQuery() {
    pageEpoch++
    thumbnailEpoch++
    thumbnailQueue = []
    thumbnails.value = {}
    page.value = 1
    total.value = 0
    items.value = []
    listError.value = null
    listLoading.value = true
    clearSelection()
  }

  function pumpThumbnails() {
    while (!disposed && activeThumbnails < 3 && thumbnailQueue.length) {
      const next = thumbnailQueue.shift()!
      if (next.epoch !== thumbnailEpoch) continue
      activeThumbnails++
      void api.getImage(next.id, true).then(image => {
        if (!disposed && next.epoch === thumbnailEpoch) thumbnails.value = { ...thumbnails.value, [next.id]: image.dataUrl }
      }).catch(() => {
        // A missing thumbnail keeps the metadata placeholder; full detail has its own visible error.
      }).finally(() => { activeThumbnails--; pumpThumbnails() })
    }
  }
  function loadThumbnails() {
    thumbnailEpoch++
    thumbnails.value = {}
    thumbnailQueue = items.value.filter(item => item.kind === 'image').slice(0, 12).map(item => ({ id: item.id, epoch: thumbnailEpoch }))
    pumpThumbnails()
  }

  async function select(id: string | null) {
    const item = items.value.find(candidate => candidate.id === id)
    if (!item || disposed) { clearSelection(); return }
    const epoch = ++selectionEpoch
    selectedId.value = item.id
    detail.value = null
    selectedImage.value = null
    detailError.value = null
    detailLoading.value = true
    const getDetail = api.get(item.id).then(value => {
      if (!disposed && epoch === selectionEpoch) detail.value = value
    })
    dropPendingSelection()
    const getImage = item.kind === 'image' ? new Promise<void>(resolve => {
      pendingSelection = { id: item.id, epoch, resolve }
      pumpSelection()
    }) : Promise.resolve()
    try { await Promise.all([getDetail, getImage]) }
    catch (error) { if (!disposed && epoch === selectionEpoch) detailError.value = asClipboardError(error, 'clipboard_get') }
    finally { if (!disposed && epoch === selectionEpoch) detailLoading.value = false }
  }

  async function refresh() {
    if (disposed) return
    stopSearchTimer()
    const epoch = ++pageEpoch
    const offset = (page.value - 1) * pageSize
    listLoading.value = true
    listError.value = null
    try {
      const bounds = date.value ? dayBounds(date.value) : null
      const result = await api.list({ query: query.value, kind: kind.value, pinnedOnly: pinnedOnly.value, offset, limit: pageSize, ...(bounds ? { from: bounds.from, until: bounds.until } : {}) })
      if (disposed || epoch !== pageEpoch) return
      if (offset > 0 && offset >= result.total) {
        page.value = Math.max(1, Math.ceil(result.total / pageSize))
        await refresh()
        return
      }
      items.value = result.items
      total.value = result.total
      loadThumbnails()
      const nextId = result.items.some(item => item.id === selectedId.value) ? selectedId.value : result.items[0]?.id ?? null
      void select(nextId)
    } catch (error) {
      if (!disposed && epoch === pageEpoch) listError.value = asClipboardError(error, 'clipboard_list')
    } finally {
      if (!disposed && epoch === pageEpoch) listLoading.value = false
    }
  }

  function acceptPause(value: boolean) {
    effectivePause = value
    pauseRevision++
    if (settings.value) settings.value = { ...settings.value, paused: value }
  }
  async function loadSettings() {
    const epoch = ++settingsEpoch
    const revision = pauseRevision
    try {
      const result = await api.getSettings()
      if (!disposed && epoch === settingsEpoch) {
        if (revision === pauseRevision) acceptPause(result.paused)
        settings.value = { ...result, paused: effectivePause ?? result.paused }
        settingsError.value = null
      }
    } catch (error) { if (!disposed && epoch === settingsEpoch) settingsError.value = asClipboardError(error, 'clipboard_get_settings') }
  }
  async function refreshStatus() {
    const epoch = ++statusEpoch
    const revision = pauseRevision
    // A status read started during a mutation must not undo its newer settings ACK.
    const syncPause = !busy.value
    try {
      const result = await api.status()
      if (!disposed && epoch === statusEpoch) {
        status.value = result
        statusError.value = null
        if (syncPause && revision === pauseRevision) acceptPause(result.paused)
      }
    } catch (error) { if (!disposed && epoch === statusEpoch) statusError.value = asClipboardError(error, 'clipboard_status') }
  }

  async function connectEvents() {
    try {
      const stop = await api.subscribe(topic => {
        if (disposed) return
        if (topic === 'clipboard:changed') contentDirty = true
        statusDirty = true
        if (eventTimer !== undefined) return
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          if (disposed) return
          const needsContent = contentDirty
          const needsStatus = statusDirty
          contentDirty = statusDirty = false
          if (needsContent && searchTimer === undefined) void refresh()
          if (needsStatus) { void refreshStatus(); if (!busy.value) void loadSettings() }
        }, 100)
      })
      if (disposed) await stop()
      else { unsubscribe = stop; eventsError.value = null }
    } catch (error) { if (!disposed) eventsError.value = asClipboardError(error, 'listen') }
  }

  async function initialize() {
    if (initialized || disposed) return
    initialized = true
    void connectEvents()
    await Promise.all([refresh(), loadSettings(), refreshStatus()])
  }
  function setQuery(value: string) {
    if (query.value === value || disposed) return
    query.value = value
    stopSearchTimer()
    invalidateQuery()
    searchTimer = setTimeout(() => { searchTimer = undefined; void refresh() }, options.searchDelay ?? 180)
  }
  async function setKind(value: KindFilter) {
    if (kind.value === value || disposed) return
    kind.value = value
    stopSearchTimer()
    invalidateQuery()
    await refresh()
  }
  async function setPinnedOnly(value: boolean) {
    if (pinnedOnly.value === value || disposed) return
    pinnedOnly.value = value
    stopSearchTimer()
    invalidateQuery()
    await refresh()
  }
  async function setDate(value: string | null) {
    // Reject malformed keys instead of silently filtering with broken bounds.
    if (value !== null && dayBounds(value) === null) return
    if (date.value === value || disposed) return
    date.value = value
    stopSearchTimer()
    invalidateQuery()
    await refresh()
  }
  async function setPage(value: number) {
    const next = Math.min(pageCount.value, Math.max(1, Math.trunc(value)))
    if (next === page.value || disposed) return
    page.value = next
    clearSelection()
    await refresh()
  }
  async function moveSelection(delta: number) {
    if (!items.value.length) return
    const current = items.value.findIndex(item => item.id === selectedId.value)
    const next = Math.min(items.value.length - 1, Math.max(0, current + delta))
    await select(items.value[next]!.id)
  }

  async function runMutation(work: () => Promise<Feedback>, operation: string): Promise<boolean> {
    if (busy.value || disposed) return false
    busy.value = true
    operationError.value = null
    feedback.value = null
    try {
      const result = await work()
      if (disposed) return false
      feedback.value = result
      // Native mutation acknowledgement is authoritative; do not keep its dialog
      // locked while a separate read refresh is slow or unavailable.
      void refresh()
      void refreshStatus()
      return true
    } catch (error) {
      if (!disposed) operationError.value = asClipboardError(error, operation)
      return false
    } finally { if (!disposed) busy.value = false }
  }
  async function copySelected() {
    const item = selectedItem.value
    if (!item || busy.value || disposed) return false
    return runMutation(async () => {
      await copyHistoryItem(api, item, options.copyHost)
      return { key: 'copyRequested' }
    }, 'copy')
  }
  async function togglePin(item: HistoryItem = selectedItem.value!) {
    if (!item) return false
    return runMutation(async () => { await api.setPinned(item.id, !item.pinned); return { key: 'pinUpdated' } }, 'clipboard_set_pinned')
  }
  async function saveSettings(patch: Partial<ClipboardSettings>) {
    return runMutation(async () => {
      validateSettingsPatch(patch)
      const epoch = ++settingsEpoch
      const result = await api.updateSettings(patch)
      if (!disposed && epoch === settingsEpoch) {
        acceptPause(result.paused)
        settings.value = result
        settingsError.value = null
      }
      return { key: 'settingsSaved' }
    }, 'clipboard_update_settings')
  }
  async function togglePaused() { return saveSettings({ paused: !paused.value }) }
  function requestDelete(item: HistoryItem = selectedItem.value!) {
    if (!item || busy.value) return
    operationError.value = null
    confirmation.value = { type: 'delete', item: { ...item } }
  }
  function requestClear() {
    if (busy.value) return
    operationError.value = null
    confirmation.value = { type: 'clear', includePinned: false }
  }
  function setClearIncludePinned(value: boolean) {
    if (confirmation.value?.type === 'clear' && !busy.value) confirmation.value = { type: 'clear', includePinned: value }
  }
  function cancelConfirmation() { if (!busy.value) confirmation.value = null }
  async function confirmAction() {
    const pending = confirmation.value
    if (!pending || busy.value) return false
    const success = await runMutation(async () => {
      if (pending.type === 'delete') { await api.delete(pending.item.id); return { key: 'entryDeleted' } }
      const result = await api.clear(pending.includePinned)
      return { key: 'historyCleared', count: result.removed }
    }, pending.type === 'delete' ? 'clipboard_delete' : 'clipboard_clear')
    if (success && confirmation.value === pending) confirmation.value = null
    return success
  }

  onScopeDispose(() => {
    disposed = true
    pageEpoch++; selectionEpoch++; thumbnailEpoch++; settingsEpoch++; statusEpoch++
    stopSearchTimer()
    if (eventTimer !== undefined) clearTimeout(eventTimer)
    thumbnailQueue = []
    dropPendingSelection()
    if (unsubscribe) void Promise.resolve(unsubscribe()).catch(() => {})
  })

  return {
    mode: api.mode, pageSize, query, kind, pinnedOnly, date, page, pageCount, items, total, selectedId, selectedItem,
    detail, selectedImage, thumbnails, settings, status, paused, isRecording, protocolRequired,
    listLoading, detailLoading, busy, listError, detailError, settingsError, statusError, eventsError, operationError,
    feedback, confirmation, initialize, refresh, refreshStatus, setQuery, setKind, setPinnedOnly, setDate, setPage, select,
    moveSelection, copySelected, togglePin, saveSettings, togglePaused, requestDelete, requestClear,
    setClearIncludePinned, cancelConfirmation, confirmAction,
  }
}

export type ClipboardHistory = ReturnType<typeof useClipboardHistory>
