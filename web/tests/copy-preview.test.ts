import { afterEach, describe, expect, it } from 'vitest'
import * as copyModule from '../src/api/copy'
import * as previewModule from '../src/api/preview'
import type { ClipboardApi, ClipboardCopyHost } from '../src/types'
import { textItem, textDetail, imageItem, pngDataUrl, settings, readyStatus } from './fixtures'

function fakeApi(): ClipboardApi {
  return {
    mode: 'host', list: async () => ({ items: [textItem, imageItem], total: 2, offset: 0, limit: 40 }),
    get: async () => textDetail, getImage: async () => ({ dataUrl: pngDataUrl, width: 1, height: 1 }),
    setPinned: async () => {}, delete: async () => {}, clear: async () => ({ removed: 1 }),
    getSettings: async () => settings, updateSettings: async patch => ({ ...settings, ...patch }),
    status: async () => readyStatus, subscribe: async () => () => {},
  }
}

const oldClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (oldClipboard) Object.defineProperty(navigator, 'clipboard', oldClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('copy-back adapter', () => {
  it('copies full text through the existing host API, never the bounded preview', async () => {
    expect(copyModule.copyHistoryItem).toBeTypeOf('function')
    const copied: string[] = []
    const host: ClipboardCopyHost = { copyText: value => { copied.push(value); return true }, copyImage: () => { throw new Error('wrong representation') } }
    expect(await copyModule.copyHistoryItem(fakeApi(), textItem, host)).toEqual({ state: 'requested' })
    expect(copied).toEqual(['Full text, not just the short preview.'])
  })

  it('copies the full PNG, not a thumbnail, through the existing host image API', async () => {
    expect(copyModule.copyHistoryItem).toBeTypeOf('function')
    const api = fakeApi()
    const requests: unknown[] = []
    api.getImage = async (id, thumbnail) => { requests.push([id, thumbnail]); return { dataUrl: pngDataUrl, width: 1, height: 1 } }
    const images: string[] = []
    const host: ClipboardCopyHost = { copyText: () => { throw new Error('wrong representation') }, copyImage: value => { images.push(value); return true } }
    await copyModule.copyHistoryItem(api, imageItem, host)
    expect(requests).toEqual([['image-1', false]])
    expect(images).toEqual([pngDataUrl])
  })

  it('reports host rejection and rejected promises without a success result', async () => {
    expect(copyModule.copyHistoryItem).toBeTypeOf('function')
    await expect(copyModule.copyHistoryItem(fakeApi(), textItem, { copyText: () => false, copyImage: () => false })).rejects.toMatchObject({ code: 'COPY_FAILED' })
    await expect(copyModule.copyHistoryItem(fakeApi(), textItem, { copyText: async () => { throw new Error('denied') }, copyImage: () => false })).rejects.toMatchObject({ code: 'COPY_FAILED' })
  })

  it('preserves a failed native content lookup as its original operation error rather than claiming the host rejected copying', async () => {
    const api = fakeApi()
    api.get = async () => { throw new Error('notFound') }
    await expect(copyModule.copyHistoryItem(api, textItem, { copyText: () => true, copyImage: () => true })).rejects.toMatchObject({ message: 'notFound' })
  })

  it('does not access browser clipboard APIs or load content when the host copy API is absent', async () => {
    expect(copyModule.copyHistoryItem).toBeTypeOf('function')
    let browserAccessed = false
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => { browserAccessed = true; throw new Error('clipboard must not be accessed') } })
    const api = fakeApi()
    let loaded = false
    api.get = async () => { loaded = true; return textDetail }
    await expect(copyModule.copyHistoryItem(api, textItem, null)).rejects.toMatchObject({ code: 'COPY_UNAVAILABLE' })
    expect(browserAccessed).toBe(false)
    expect(loaded).toBe(false)
  })
})

describe('explicit synthetic preview', () => {
  it('does not enter preview automatically just because the host is missing', () => {
    expect(previewModule.isExplicitPreview).toBeTypeOf('function')
    expect(previewModule.isExplicitPreview('')).toBe(false)
    expect(previewModule.isExplicitPreview('?preview=0')).toBe(false)
    expect(previewModule.isExplicitPreview('?preview=1')).toBe(true)
  })

  it('shows synthetic metadata only and never reads actual clipboard content', async () => {
    expect(previewModule.createPreviewApi).toBeTypeOf('function')
    let browserAccessed = false
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => { browserAccessed = true; throw new Error('unexpected read') } })
    const api = previewModule.createPreviewApi()
    const page = await api.list({ limit: 40 })
    expect(api.mode).toBe('preview')
    expect(page.total).toBeGreaterThan(2)
    expect(page.items.every(item => item.id.startsWith('sample-'))).toBe(true)
    expect(page.items.every(item => !('text' in item) && !('dataUrl' in item))).toBe(true)
    expect(browserAccessed).toBe(false)
    const status = await api.status()
    expect(status.recording).toBe(false)
    expect(status.sourceStatus).toBe('preview')
  })

  it('supports real filtering, detail, pins and explicit clear behavior within its synthetic store', async () => {
    expect(previewModule.createPreviewApi).toBeTypeOf('function')
    const api = previewModule.createPreviewApi()
    const all = await api.list()
    const text = all.items.find(item => item.kind === 'text')!
    const detail = await api.get(text.id)
    expect(typeof detail.text).toBe('string')
    await api.setPinned(text.id, true)
    const pinned = await api.list({ pinnedOnly: true, kind: 'text' })
    expect(pinned.items.some(item => item.id === text.id)).toBe(true)
    expect((await api.list({ query: 'no-such-synthetic-text-123' })).total).toBe(0)
    await api.clear()
    expect((await api.list()).items.every(item => item.pinned)).toBe(true)
    await api.clear(true)
    expect((await api.list()).total).toBe(0)
  })

  it('persists pause across preview transport instances without persisting clipboard content', async () => {
    expect(previewModule.createPreviewApi).toBeTypeOf('function')
    const storage = new Map<string, string>()
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    const api = previewModule.createPreviewApi(store)
    expect(await api.getSettings()).toEqual({ maxEntries: 500, retentionDays: 30, maxBytes: 268435456, paused: false })
    await api.updateSettings({ paused: true })
    expect((await previewModule.createPreviewApi(store).getSettings()).paused).toBe(true)
    const persisted = [...storage.values()].join('')
    expect(persisted).not.toContain('sample-')
    expect(persisted).not.toContain('data:image')
  })
})
