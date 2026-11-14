import { afterEach, describe, expect, it } from 'vitest'
import * as module from '../src/api/clipboard'
import type { ClipboardApi, ClipboardTransport, Unsubscribe } from '../src/types'
import { textItem, textDetail, imageItem, settings, readyStatus, pngDataUrl } from './fixtures'

function createApi(transport: ClipboardTransport): ClipboardApi {
  expect(module.createClipboardApi, 'The central native adapter must exist').toBeTypeOf('function')
  return module.createClipboardApi(transport)
}

const unsubscriptions: Unsubscribe[] = []
afterEach(async () => { for (const unsubscribe of unsubscriptions.splice(0)) await unsubscribe() })

function fixtureTransport(response: unknown): ClipboardTransport {
  return { invoke: async () => response, listen: async () => () => {} }
}

describe('native clipboard API boundary', () => {
  it('maps every operation to the exact native method and flat payload', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const replies: Record<string, unknown> = {
      clipboard_list: { items: [textItem, imageItem], total: 2, offset: 50, limit: 25 },
      clipboard_get: textDetail,
      clipboard_get_image: { dataUrl: pngDataUrl, width: 2, height: 2 },
      clipboard_set_pinned: { removed: 0 }, clipboard_delete: { removed: 1 }, clipboard_clear: { removed: 1 },
      clipboard_get_settings: settings, clipboard_update_settings: { ...settings, paused: true },
      clipboard_status: readyStatus,
    }
    const api = createApi({
      invoke: async (command, payload) => { calls.push([command, payload]); return { ok: true, data: replies[command] } },
      listen: async () => () => {},
    })
    expect(await api.list({ query: 'hello', kind: 'text', pinnedOnly: true, offset: 50, limit: 25 })).toEqual({ items: [textItem, imageItem], total: 2, offset: 50, limit: 25 })
    expect(await api.get('text-1')).toEqual(textDetail)
    expect(await api.getImage('image-1', true)).toEqual({ dataUrl: pngDataUrl, width: 2, height: 2 })
    await api.setPinned('text-1', true)
    await api.delete('text-1')
    expect(await api.clear()).toEqual({ removed: 1 })
    expect(await api.getSettings()).toEqual(settings)
    expect((await api.updateSettings({ paused: true })).paused).toBe(true)
    expect(await api.status()).toEqual(readyStatus)
    expect(calls).toEqual([
      ['clipboard_list', { query: 'hello', kind: 'text', pinnedOnly: true, offset: 50, limit: 25 }],
      ['clipboard_get', { id: 'text-1' }], ['clipboard_get_image', { id: 'image-1', thumbnail: true }],
      ['clipboard_set_pinned', { id: 'text-1', pinned: true }], ['clipboard_delete', { id: 'text-1' }],
      ['clipboard_clear', { includePinned: false }], ['clipboard_get_settings', {}],
      ['clipboard_update_settings', { paused: true }], ['clipboard_status', {}],
    ])
  })

  it('passes an explicit date window through and omits it entirely otherwise', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const api = createApi({
      invoke: async (command, payload) => { calls.push([command, payload]); return { ok: true, data: { items: [], total: 0, offset: 0, limit: 40 } } },
      listen: async () => () => {},
    })
    await api.list({ from: 1_799_990_000_000, until: 1_799_998_640_000 })
    await api.list({ query: '', kind: 'all', pinnedOnly: false })
    expect(calls).toEqual([
      ['clipboard_list', { kind: 'all', pinnedOnly: false, offset: 0, limit: 40, from: 1_799_990_000_000, until: 1_799_998_640_000 }],
      ['clipboard_list', { kind: 'all', pinnedOnly: false, offset: 0, limit: 40 }],
    ])
    await expect(api.list({ from: 5, until: 4 })).rejects.toMatchObject({ code: 'INVALID_REQUEST', operation: 'clipboard_list' })
    await expect(api.list({ from: 1.5, until: 9_007_199_254_740_991 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('passes an optional clear window through and rejects malformed bounds', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const api = createApi({
      invoke: async (command, payload) => { calls.push([command, payload]); return { ok: true, data: { removed: 2 } } },
      listen: async () => () => {},
    })
    expect(await api.clear(false, { from: 1_799_990_000_000, until: 1_799_998_640_000 })).toEqual({ removed: 2 })
    expect(await api.clear(true)).toEqual({ removed: 2 })
    expect(calls).toEqual([
      ['clipboard_clear', { includePinned: false, from: 1_799_990_000_000, until: 1_799_998_640_000 }],
      ['clipboard_clear', { includePinned: true }],
    ])
    await expect(api.clear(false, { from: 5, until: 4 })).rejects.toMatchObject({ code: 'INVALID_REQUEST', operation: 'clipboard_clear' })
    await expect(api.clear(false, { from: 1.5, until: 9_007_199_254_740_991 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('accepts an already-unwrapped host reply without reading nested .data', async () => {
    const api = createApi(fixtureTransport({ items: [textItem], total: 1, offset: 0, limit: 40 }))
    expect((await api.list()).items[0]?.id).toBe('text-1')
  })

  it('removes unexpected full text and image blobs from list metadata', async () => {
    const api = createApi(fixtureTransport({ items: [{ ...imageItem, text: 'sensitive', dataUrl: pngDataUrl }], total: 1, offset: 0, limit: 40 }))
    const result = await api.list()
    expect(result.items).toEqual([imageItem])
    expect(result.items[0]).not.toHaveProperty('dataUrl')
    expect(result.items[0]).not.toHaveProperty('text')
  })

  it.each([
    null,
    { ok: true },
    { ok: 'true', data: {} },
    { data: { items: [], total: 0, offset: 0, limit: 40 } },
    { items: [textItem], total: -1, offset: 0, limit: 40 },
    { items: [{ ...textItem, pinned: 'yes' }], total: 1, offset: 0, limit: 40 },
    { items: [], total: 0, offset: 0, limit: 0 },
  ])('rejects malformed list replies (%j)', async (reply) => {
    await expect(createApi(fixtureTransport(reply)).list()).rejects.toThrow('clipboard_list')
  })

  it('propagates native failure as a typed operation error, not an empty history', async () => {
    await expect(createApi(fixtureTransport({ ok: false, error: 'storage_unavailable' })).list()).rejects.toMatchObject({ code: 'NATIVE_ERROR', operation: 'clipboard_list', message: 'storage_unavailable' })
  })

  it('validates safe image data URLs before they reach an image element or copy API', async () => {
    const api = createApi(fixtureTransport({ dataUrl: 'data:image/svg+xml,<svg onload="alert(1)"/>', width: 2, height: 2 }))
    await expect(api.getImage('image-1')).rejects.toThrow('clipboard_get_image')
  })

  it('validates settings patches before invoking native code', async () => {
    let invoked = false
    const api = createApi({ invoke: async () => { invoked = true; return settings }, listen: async () => () => {} })
    await expect(api.updateSettings({ retentionDays: 0 })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' })
    expect(invoked).toBe(false)
  })

  it('maps only invalidation topics through the official listen shim and releases both listeners', async () => {
    const handlers = new Map<string, () => void>()
    const removed: string[] = []
    const api = createApi({ invoke: async () => readyStatus, listen: async (topic, handler) => { handlers.set(topic, handler); return () => { removed.push(topic) } } })
    const received: string[] = []
    const unsubscribe = await api.subscribe(topic => received.push(topic))
    handlers.get('clipboard:changed')?.()
    handlers.get('clipboard:status')?.()
    expect(received).toEqual(['clipboard:changed', 'clipboard:status'])
    await unsubscribe()
    expect(removed.sort()).toEqual(['clipboard:changed', 'clipboard:status'])
  })

  it('uses the real current SDK shim to route official invoke syntax to the plugin identity', async () => {
    const oldApi = window.otools
    window.otools = {
      invokeNative: async () => { throw new Error('unscoped native invoke should not run') },
      getPluginUuid: () => 'otools-clipboard',
      invokeNativePlugin: async (uuid: string, command: string, payload: unknown) => {
        expect(uuid).toBe('otools-clipboard')
        expect(command).toBe('clipboard_list')
        expect(payload).toEqual({ kind: 'all', pinnedOnly: false, offset: 0, limit: 40 })
        return { items: [textItem], total: 1, offset: 0, limit: 40 }
      },
    } as unknown as NonNullable<Window['otools']>
    try {
      const result = await module.createClipboardApi().list()
      expect(result.items).toEqual([textItem])
    } finally { window.otools = oldApi }
  })
})
