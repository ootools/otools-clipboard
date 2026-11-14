import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ClipboardApi, ClipboardSettings, ClipboardStatus, ClipboardTransport, HistoryDetail, HistoryItem, HistoryPage, ImageData, ListRequest, Unsubscribe } from '../types'
import { ClipboardError, asClipboardError } from './errors'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const natural = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const malformed = (operation: string): never => { throw new ClipboardError('INVALID_REPLY', operation, `Invalid reply from ${operation}`) }

function unwrap(value: unknown, operation: string): unknown {
  if (!record(value) || !Object.hasOwn(value, 'ok')) return value
  if (value.ok === false) throw new ClipboardError('NATIVE_ERROR', operation, typeof value.error === 'string' ? value.error.slice(0, 240) : 'native_operation_failed')
  if (value.ok !== true || !Object.hasOwn(value, 'data')) return malformed(operation)
  return value.data
}

function parseItem(value: unknown, operation: string): HistoryItem {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.hash !== 'string' || !value.hash ||
    (value.kind !== 'text' && value.kind !== 'image') || typeof value.preview !== 'string' ||
    !natural(value.byteSize) || !natural(value.createdAt) || !natural(value.lastCopiedAt) ||
    !natural(value.copyCount, 1) || typeof value.pinned !== 'boolean' ||
    (value.width !== undefined && !natural(value.width, 1)) || (value.height !== undefined && !natural(value.height, 1))) return malformed(operation)
  return {
    id: value.id, hash: value.hash, kind: value.kind, preview: value.preview, byteSize: value.byteSize,
    createdAt: value.createdAt, lastCopiedAt: value.lastCopiedAt, copyCount: value.copyCount, pinned: value.pinned,
    ...(value.width !== undefined ? { width: value.width as number } : {}),
    ...(value.height !== undefined ? { height: value.height as number } : {}),
  }
}

function parsePage(value: unknown): HistoryPage {
  const operation = 'clipboard_list'
  if (!record(value) || !Array.isArray(value.items) || !natural(value.total) || !natural(value.offset) || !natural(value.limit, 1) || value.limit > 100 || value.items.length > value.limit) return malformed(operation)
  return { items: value.items.map(item => parseItem(item, operation)), total: value.total, offset: value.offset, limit: value.limit }
}

function parseDetail(value: unknown): HistoryDetail {
  const operation = 'clipboard_get'
  const item = parseItem(value, operation)
  if (!record(value) || (item.kind === 'text' && typeof value.text !== 'string')) return malformed(operation)
  return { ...item, ...(item.kind === 'text' ? { text: value.text as string } : {}) }
}

function parseImage(value: unknown): ImageData {
  const operation = 'clipboard_get_image'
  if (!record(value) || typeof value.dataUrl !== 'string' || value.dataUrl.length > 23_000_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) ||
    !natural(value.width, 1) || !natural(value.height, 1) || value.width > 16384 || value.height > 16384 || value.width * value.height > 32_000_000) return malformed(operation)
  return { dataUrl: value.dataUrl, width: value.width, height: value.height }
}

function parseSettings(value: unknown, operation: string): ClipboardSettings {
  if (!record(value) || !natural(value.maxEntries, 1) || !natural(value.retentionDays, 1) || !natural(value.maxBytes, 1) || typeof value.paused !== 'boolean') return malformed(operation)
  return { maxEntries: value.maxEntries, retentionDays: value.retentionDays, maxBytes: value.maxBytes, paused: value.paused }
}

function parseStatus(value: unknown): ClipboardStatus {
  const operation = 'clipboard_status'
  if (!record(value) || typeof value.ready !== 'boolean' || typeof value.recording !== 'boolean' || typeof value.paused !== 'boolean' ||
    !natural(value.totalEntries) || !natural(value.storageBytes) || !natural(value.droppedEvents) ||
    (value.lastError !== null && typeof value.lastError !== 'string') || typeof value.sourceStatus !== 'string') return malformed(operation)
  return {
    ready: value.ready, recording: value.recording, paused: value.paused, totalEntries: value.totalEntries,
    storageBytes: value.storageBytes, droppedEvents: value.droppedEvents,
    lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 240) : null, sourceStatus: value.sourceStatus,
  }
}

export function validateSettingsPatch(patch: Partial<ClipboardSettings>): void {
  for (const key of ['maxEntries', 'retentionDays', 'maxBytes'] as const) {
    if (patch[key] !== undefined && !natural(patch[key], 1)) throw new ClipboardError('INVALID_SETTINGS', 'clipboard_update_settings', `Invalid ${key}`)
  }
  if (patch.paused !== undefined && typeof patch.paused !== 'boolean') throw new ClipboardError('INVALID_SETTINGS', 'clipboard_update_settings', 'Invalid paused')
}

const officialTransport: ClipboardTransport = {
  invoke: (command, payload) => invoke(command, payload),
  listen: (topic, handler) => listen(topic, () => handler()),
}

export function createClipboardApi(transport: ClipboardTransport = officialTransport): ClipboardApi {
  const call = async (operation: string, payload: Record<string, unknown> = {}) => {
    try { return unwrap(await transport.invoke(operation, payload), operation) }
    catch (error) { throw asClipboardError(error, operation) }
  }
  return {
    mode: 'host',
    async list(request: ListRequest = {}) {
      const payload: Record<string, unknown> = { kind: request.kind ?? 'all', pinnedOnly: request.pinnedOnly ?? false, offset: request.offset ?? 0, limit: request.limit ?? 40 }
      if (request.query) payload.query = request.query
      // A date window is optional but must arrive as a well-formed half-open
      // pair of safe integers; anything else is a caller bug, not a filter.
      if (request.from !== undefined || request.until !== undefined) {
        if (!natural(request.from, 0) || !natural(request.until, 0) || request.until < request.from) throw new ClipboardError('INVALID_REQUEST', 'clipboard_list', 'Invalid date window')
        payload.from = request.from
        payload.until = request.until
      }
      return parsePage(await call('clipboard_list', payload))
    },
    async get(id) { return parseDetail(await call('clipboard_get', { id })) },
    async getImage(id, thumbnail = false) { return parseImage(await call('clipboard_get_image', { id, thumbnail })) },
    async setPinned(id, pinned) { await call('clipboard_set_pinned', { id, pinned }) },
    async delete(id) { await call('clipboard_delete', { id }) },
    async clear(includePinned = false) {
      const result = await call('clipboard_clear', { includePinned })
      if (!record(result) || !natural(result.removed)) return malformed('clipboard_clear')
      return { removed: result.removed }
    },
    async getSettings() { return parseSettings(await call('clipboard_get_settings'), 'clipboard_get_settings') },
    async updateSettings(patch) {
      validateSettingsPatch(patch)
      return parseSettings(await call('clipboard_update_settings', { ...patch }), 'clipboard_update_settings')
    },
    async status() { return parseStatus(await call('clipboard_status')) },
    async subscribe(handler) {
      const subscriptions: Unsubscribe[] = []
      try {
        for (const topic of ['clipboard:changed', 'clipboard:status'] as const) subscriptions.push(await transport.listen(topic, () => handler(topic)))
      } catch (error) {
        await Promise.allSettled(subscriptions.map(unsubscribe => unsubscribe()))
        throw asClipboardError(error, 'listen')
      }
      return async () => { await Promise.allSettled(subscriptions.splice(0).map(unsubscribe => unsubscribe())) }
    },
  }
}
