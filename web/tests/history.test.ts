import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import * as historyModule from '../src/composables/useClipboardHistory'
import type { ClipboardApi, ClipboardCopyHost, HistoryDetail, HistoryItem, HistoryPage, ListRequest, ClipboardTopic } from '../src/types'
import { deferred, textItem, textDetail, imageItem, pngDataUrl, settings, readyStatus } from './fixtures'

const scopes: ReturnType<typeof effectScope>[] = []
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => { for (const scope of scopes.splice(0)) scope.stop(); vi.useRealTimers() })

function baseApi(): ClipboardApi {
  return {
    mode: 'host', list: async (request = {}) => ({ items: [textItem, imageItem], total: 2, offset: request.offset ?? 0, limit: request.limit ?? 40 }),
    get: async id => id === imageItem.id ? imageItem : textDetail, getImage: async () => ({ dataUrl: pngDataUrl, width: 1, height: 1 }),
    setPinned: async () => {}, delete: async () => {}, clear: async () => ({ removed: 1 }),
    getSettings: async () => ({ ...settings }), updateSettings: async patch => ({ ...settings, ...patch }),
    status: async () => ({ ...readyStatus }), subscribe: async () => () => {},
  }
}
function useHistory(api: ClipboardApi, copyHost: ClipboardCopyHost | null = null) {
  expect(historyModule.useClipboardHistory, 'The history state controller must exist').toBeTypeOf('function')
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => historyModule.useClipboardHistory(api, { pageSize: 40, searchDelay: 180, copyHost }))!
}

describe('history query and concurrency', () => {
  it('loads settings/status/history independently and initializes selection from real metadata', async () => {
    const history = useHistory(baseApi())
    await history.initialize()
    expect(history.items.value.map(item => item.id)).toEqual(['text-1', 'image-1'])
    expect(history.total.value).toBe(2)
    expect(history.selectedId.value).toBe('text-1')
    await settle()
    expect(history.detail.value?.text).toBe('Full text, not just the short preview.')
    expect(history.settings.value).toEqual(settings)
    expect(history.status.value).toEqual(readyStatus)
  })

  it('filters by the selected day, defaults to today, and clears back to all history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 10, 30))
    const requests: ListRequest[] = []
    const api = baseApi()
    api.list = async request => { requests.push({ ...request }); return { items: [textItem], total: 1, offset: request?.offset ?? 0, limit: 40 } }
    const history = useHistory(api)
    await history.initialize()
    // Default view is today: local midnight to the next local midnight.
    expect(requests.at(-1)).toMatchObject({ from: new Date(2026, 10, 14).getTime(), until: new Date(2026, 10, 15).getTime() })
    await history.setDate('2026-11-01')
    expect(requests.at(-1)).toMatchObject({ from: new Date(2026, 10, 1).getTime(), until: new Date(2026, 10, 2).getTime(), offset: 0 })
    await history.setKind('image')
    expect(requests.at(-1)).toMatchObject({ kind: 'image', from: new Date(2026, 10, 1).getTime(), until: new Date(2026, 10, 2).getTime() })
    await history.setDate(null)
    expect(requests.at(-1)?.from).toBeUndefined()
    expect(requests.at(-1)?.until).toBeUndefined()
    await history.setDate('2026-13-40')
    expect('from' in requests.at(-1)!).toBe(false)
    expect(history.date.value).toBe(null)
  })

  it('preserves the exact offset for pagination and resets to page one for type/pin filters', async () => {
    const requests: ListRequest[] = []
    const api = baseApi()
    api.list = async request => { requests.push({ ...request }); return { items: [textItem], total: 95, offset: request?.offset ?? 0, limit: 40 } }
    const history = useHistory(api)
    await history.initialize()
    await history.setDate(null)
    await history.setPage(2)
    expect(history.page.value).toBe(2)
    expect(requests.at(-1)).toEqual({ query: '', kind: 'all', pinnedOnly: false, offset: 40, limit: 40 })
    await history.setKind('image')
    expect(history.page.value).toBe(1)
    expect(requests.at(-1)).toEqual({ query: '', kind: 'image', pinnedOnly: false, offset: 0, limit: 40 })
    await history.setPinnedOnly(true)
    expect(requests.at(-1)?.pinnedOnly).toBe(true)
    expect(requests.at(-1)?.offset).toBe(0)
  })

  it('debounces rapid search input but invalidates an old reply immediately before the delay expires', async () => {
    vi.useFakeTimers()
    const oldPage = deferred<HistoryPage>()
    const requests: ListRequest[] = []
    const api = baseApi()
    api.list = async request => {
      requests.push({ ...request })
      if (requests.length === 1) return oldPage.promise
      return { items: [{ ...textItem, id: 'latest-query' }], total: 1, offset: 0, limit: 40 }
    }
    const history = useHistory(api)
    const initial = history.initialize()
    history.setQuery('a')
    history.setQuery('ab')
    oldPage.resolve({ items: [textItem], total: 1, offset: 0, limit: 40 })
    await initial
    expect(history.items.value).toEqual([])
    await vi.advanceTimersByTimeAsync(179)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
    expect(requests.at(-1)?.query).toBe('ab')
    expect(history.items.value[0]?.id).toBe('latest-query')
    expect(history.page.value).toBe(1)
  })

  it('never lets a late old filter reply overwrite the newer page or totals', async () => {
    const oldPage = deferred<HistoryPage>()
    const api = baseApi()
    api.list = async request => request?.kind === 'image'
      ? { items: [imageItem], total: 1, offset: 0, limit: 40 } : oldPage.promise
    const history = useHistory(api)
    const initial = history.initialize()
    await history.setKind('image')
    oldPage.resolve({ items: [textItem], total: 999, offset: 0, limit: 40 })
    await initial
    expect(history.items.value.map(item => item.id)).toEqual(['image-1'])
    expect(history.total.value).toBe(1)
    expect(history.selectedId.value).toBe('image-1')
  })

  it('discards a late rejection from an obsolete request instead of reporting it for the new filter', async () => {
    const oldPage = deferred<HistoryPage>()
    const api = baseApi()
    api.list = async request => request?.pinnedOnly ? { items: [imageItem], total: 1, offset: 0, limit: 40 } : oldPage.promise
    const history = useHistory(api)
    const initial = history.initialize()
    await history.setPinnedOnly(true)
    oldPage.reject(new Error('old_filter_failed'))
    await initial
    expect(history.listError.value).toBeNull()
    expect(history.items.value[0]?.id).toBe('image-1')
  })

  it('rejects stale selection detail and full-image replies when the user chooses another item', async () => {
    const slowDetail = deferred<HistoryDetail>()
    const slowImage = deferred<{ dataUrl: string; width: number; height: number }>()
    const api = baseApi()
    api.get = id => id === 'image-1' ? slowDetail.promise : Promise.resolve(textDetail)
    api.getImage = (_id, thumbnail) => thumbnail ? Promise.resolve({ dataUrl: pngDataUrl, width: 1, height: 1 }) : slowImage.promise
    const history = useHistory(api)
    await history.initialize()
    const oldSelection = history.select('image-1')
    await settle()
    await history.select('text-1')
    slowDetail.resolve(imageItem)
    slowImage.resolve({ dataUrl: pngDataUrl, width: 1, height: 1 })
    await oldSelection
    expect(history.selectedId.value).toBe('text-1')
    expect(history.detail.value?.id).toBe('text-1')
    expect(history.selectedImage.value).toBeNull()
  })

  it('coalesces pending full-image selections behind one active request', async () => {
    const images = Array.from({length:20}, (_,index)=>({...imageItem,id:`full-${index}`}))
    const api=baseApi()
    api.list=async()=>({items:[textItem,...images],total:21,offset:0,limit:40})
    const requests:string[]=[]
    const pending:Array<ReturnType<typeof deferred<{dataUrl:string;width:number;height:number}>>>=[]
    api.get=async id=>({...imageItem,id})
    api.getImage=(id,thumbnail)=>{
      if (thumbnail) return Promise.resolve({dataUrl:pngDataUrl,width:1,height:1})
      requests.push(id)
      const request=deferred<{dataUrl:string;width:number;height:number}>()
      pending.push(request)
      return request.promise
    }
    const history=useHistory(api)
    await history.initialize()
    const selections=images.map(item=>history.select(item.id))
    await settle()
    expect(requests).toEqual(['full-0'])
    pending.shift()!.resolve({dataUrl:pngDataUrl,width:1,height:1})
    await settle()
    expect(requests).toEqual(['full-0','full-19'])
    pending.shift()!.resolve({dataUrl:pngDataUrl,width:1,height:1})
    await Promise.all(selections)
    expect(history.selectedId.value).toBe('full-19')
    expect(history.selectedImage.value?.dataUrl).toBe(pngDataUrl)
  })

  it('loads at most twelve thumbnails and at most three concurrently, never full images for unselected items', async () => {
    const images: HistoryItem[] = Array.from({ length: 39 }, (_, i) => ({ ...imageItem, id: `image-${i + 1}` }))
    const api = baseApi()
    api.list = async () => ({ items: [textItem, ...images], total: 40, offset: 0, limit: 40 })
    const pending: Array<ReturnType<typeof deferred<{ dataUrl: string; width: number; height: number }>>> = []
    let active = 0
    let peak = 0
    const requests: Array<[string, boolean | undefined]> = []
    api.getImage = async (id, thumbnail) => {
      requests.push([id, thumbnail]); active++; peak = Math.max(peak, active)
      const request = deferred<{ dataUrl: string; width: number; height: number }>()
      pending.push(request)
      const result = await request.promise
      active--
      return result
    }
    const history = useHistory(api)
    await history.initialize()
    await settle()
    expect(requests).toHaveLength(3)
    for (let batch = 0; batch < 4; batch++) {
      for (const request of pending.splice(0)) request.resolve({ dataUrl: pngDataUrl, width: 1, height: 1 })
      await settle()
    }
    expect(requests).toHaveLength(12)
    expect(requests.every(([, thumbnail]) => thumbnail === true)).toBe(true)
    expect(peak).toBe(3)
    expect(Object.keys(history.thumbnails.value)).toHaveLength(12)
  })

  it('releases native listeners and ignores unfinished work after the Vue scope is disposed', async () => {
    const page = deferred<HistoryPage>()
    let unsubscribed = false
    const api = baseApi()
    api.list = () => page.promise
    api.subscribe = async () => () => { unsubscribed = true }
    const history = useHistory(api)
    const initialize = history.initialize()
    await settle()
    scopes.at(-1)!.stop()
    page.resolve({ items: [textItem], total: 1, offset: 0, limit: 40 })
    await initialize
    expect(unsubscribed).toBe(true)
    expect(history.items.value).toEqual([])
  })
})

describe('history actions and truthful status', () => {
  it('requires confirmation for deletion and exposes the pinned warning before any mutation', async () => {
    const deleted: string[] = []
    const api = baseApi()
    api.delete = async id => { deleted.push(id) }
    const history = useHistory(api)
    await history.initialize()
    history.requestDelete(imageItem)
    expect(deleted).toEqual([])
    expect(history.confirmation.value).toMatchObject({ type: 'delete', item: { id: 'image-1', pinned: true } })
    history.cancelConfirmation()
    expect(deleted).toEqual([])
    history.requestDelete(imageItem)
    await history.confirmAction()
    expect(deleted).toEqual(['image-1'])
    expect(history.confirmation.value).toBeNull()
  })

  it('defaults clear to unpinned entries and only includes pins after explicit opt-in', async () => {
    const cleared: boolean[] = []
    const api = baseApi()
    api.clear = async includePinned => { cleared.push(includePinned ?? false); return { removed: 1 } }
    const history = useHistory(api)
    await history.initialize()
    history.requestClear()
    expect(history.confirmation.value).toMatchObject({ type: 'clear', includePinned: false })
    expect(cleared).toEqual([])
    await history.confirmAction()
    history.requestClear()
    history.setClearIncludePinned(true)
    await history.confirmAction()
    expect(cleared).toEqual([false, true])
  })

  it('keeps the confirmation open on a failed destructive operation and shows the error', async () => {
    const api = baseApi()
    api.delete = async () => { throw new Error('disk_unavailable') }
    const history = useHistory(api)
    await history.initialize()
    history.requestDelete(textItem)
    expect(await history.confirmAction()).toBe(false)
    expect(history.confirmation.value?.type).toBe('delete')
    expect(history.operationError.value?.message).toBe('disk_unavailable')
  })

  it('does not submit duplicate mutations while a confirmation is already in flight', async () => {
    const removal = deferred<void>()
    let calls = 0
    const api = baseApi()
    api.delete = async () => { calls++; await removal.promise }
    const history = useHistory(api)
    await history.initialize()
    history.requestDelete(textItem)
    const first = history.confirmAction()
    await history.confirmAction()
    expect(calls).toBe(1)
    removal.resolve()
    await first
  })

  it('clears only the chosen date range when a range scope is confirmed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 10, 30))
    const calls: Array<Record<string, unknown>> = []
    const api = baseApi()
    api.clear = async (includePinned, window) => { calls.push({ includePinned: includePinned ?? false, ...(window ?? {}) }); return { removed: 2 } }
    const history = useHistory(api)
    await history.initialize()
    history.requestClear()
    expect(history.confirmation.value).toMatchObject({ scope: 'all', from: null, until: null })
    await history.confirmAction()
    expect(calls).toEqual([{ includePinned: false }])
    history.requestClear()
    await history.setClearScope('range')
    // Switching to range prefills with the active day filter (or today).
    expect(history.confirmation.value).toMatchObject({ scope: 'range', from: '2026-11-14', until: '2026-11-14' })
    await history.setClearRange({ from: '2026-11-01', until: '2026-11-03' })
    await history.confirmAction()
    expect(calls.at(-1)).toEqual({ includePinned: false, from: new Date(2026, 10, 1).getTime(), until: new Date(2026, 10, 4).getTime() })
    history.requestClear()
    await history.setClearScope('range')
    await history.setClearRange({ from: '2026-11-03', until: '2026-11-01' })
    expect(await history.confirmAction()).toBe(false)
    expect(calls).toHaveLength(2)
    await history.setClearRange({ from: '2026-13-40', until: '2026-12-01' })
    expect(await history.confirmAction()).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('persists pause via the native settings contract and only changes UI after its acknowledgement', async () => {
    const update = deferred<typeof settings>()
    const patches: unknown[] = []
    const api = baseApi()
    api.updateSettings = patch => { patches.push(patch); return update.promise }
    const history = useHistory(api)
    await history.initialize()
    const pause = history.togglePaused()
    expect(history.paused.value).toBe(false)
    expect(patches).toEqual([{ paused: true }])
    update.resolve({ ...settings, paused: true })
    await pause
    expect(history.paused.value).toBe(true)
  })

  it('discards an old get-settings reply when a later pause update has already completed', async () => {
    const oldSettings = deferred<typeof settings>()
    const api = baseApi()
    api.getSettings = () => oldSettings.promise
    const history = useHistory(api)
    const initial = history.initialize()
    await history.saveSettings({ paused: true })
    oldSettings.resolve(settings)
    await initial
    expect(history.settings.value?.paused).toBe(true)
  })

  it('does not claim recording when native has not received the host started handshake', async () => {
    const api = baseApi()
    api.status = async () => ({ ...readyStatus, ready: false, recording: false, sourceStatus: 'idle' })
    const history = useHistory(api)
    await history.initialize()
    expect(history.protocolRequired.value).toBe(true)
    expect(history.isRecording.value).toBe(false)
  })

  it('records a visible copy request only after the existing host adapter accepts it', async () => {
    const history = useHistory(baseApi(), { copyText: () => true, copyImage: () => true })
    await history.initialize()
    expect(await history.copySelected()).toBe(true)
    expect(history.feedback.value).toEqual({ key: 'copyRequested' })
  })

  it('shows host-required copy failure in browser preview without a success toast', async () => {
    const api = baseApi()
    api.mode = 'preview'
    const history = useHistory(api)
    await history.initialize()
    expect(await history.copySelected()).toBe(false)
    expect(history.operationError.value?.code).toBe('COPY_UNAVAILABLE')
    expect(history.feedback.value).toBeNull()
  })

  it('updates pause from a status event immediately even while get-settings is delayed', async () => {
    vi.useFakeTimers()
    let handler!: (topic: ClipboardTopic) => void
    const api = baseApi()
    let requests = 0
    const delayedSettings = deferred<typeof settings>()
    api.getSettings = async () => ++requests === 1 ? settings : delayedSettings.promise
    api.subscribe = async listener => { handler = listener; return () => {} }
    const history = useHistory(api)
    await history.initialize()
    api.status = async () => ({ ...readyStatus, paused: true, recording: false })
    handler('clipboard:status')
    await vi.advanceTimersByTimeAsync(100)
    expect(history.paused.value).toBe(true)
    expect(history.isRecording.value).toBe(false)
    delayedSettings.resolve({ ...settings, paused: true })
    await settle()
  })

  it('uses newer status pause if an older get-settings request arrives after it', async () => {
    vi.useFakeTimers()
    const api = baseApi()
    const slowStatus = deferred<typeof readyStatus>()
    const oldSettings = deferred<typeof settings>()
    let handler!: (topic: ClipboardTopic) => void
    api.subscribe = async listener => { handler = listener; return () => {} }
    const history = useHistory(api)
    await history.initialize()
    api.status = () => slowStatus.promise
    api.getSettings = () => oldSettings.promise
    handler('clipboard:status')
    await vi.advanceTimersByTimeAsync(100)
    slowStatus.resolve({ ...readyStatus, paused: true, recording: false })
    await settle()
    expect(history.paused.value).toBe(true)
    oldSettings.resolve(settings)
    await settle()
    expect(history.paused.value).toBe(true)
  })

  it('settles a successful delete even if the subsequent list refresh is still loading', async () => {
    const api = baseApi()
    const history = useHistory(api)
    await history.initialize()
    const refresh = deferred<HistoryPage>()
    api.list = () => refresh.promise
    history.requestDelete(textItem)
    let completed = false
    const action = history.confirmAction().then(() => { completed = true })
    await settle()
    expect(completed).toBe(true)
    expect(history.busy.value).toBe(false)
    expect(history.confirmation.value).toBeNull()
    expect(history.listLoading.value).toBe(true)
    refresh.resolve({ items: [], total: 0, offset: 0, limit: 40 })
    await action
  })

  it('coalesces status-only invalidation events and keeps rendered history independent of listening support', async () => {
    vi.useFakeTimers()
    let eventHandler!: (topic: ClipboardTopic) => void
    let pageRequests = 0
    const api = baseApi()
    api.list = async request => { pageRequests++; return { items: [textItem], total: 1, offset: request?.offset ?? 0, limit: 40 } }
    api.subscribe = async handler => { eventHandler = handler; return () => {} }
    const history = useHistory(api)
    await history.initialize()
    eventHandler('clipboard:changed')
    eventHandler('clipboard:changed')
    eventHandler('clipboard:status')
    await vi.advanceTimersByTimeAsync(100)
    expect(pageRequests).toBe(2)
    expect(history.items.value[0]?.id).toBe('text-1')
  })
})
