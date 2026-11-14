import type { ClipboardApi, ClipboardSettings, ClipboardTopic, HistoryDetail, HistoryItem } from '../types'
import { ClipboardError } from './errors'
import { validateSettingsPatch } from './clipboard'

export const defaultSettings: ClipboardSettings = { maxEntries: 500, retentionDays: 30, maxBytes: 256 * 1024 * 1024, paused: false }
const samplePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const sampleTexts = [
  '周五发布清单\n核对版本 · 运行测试 · 记录验证结果\n\n这是一条人工样例，不来自系统剪贴板。',
  'https://example.com/design/clipboard-history',
  'const greeting = "Hello, OTools";\nconsole.log(greeting);',
  '灵感便签\n让每一次复制都井然有序。',
  '<img src=x onerror="alert(1)"><script>alert("sample")</script>\nHTML-looking text is displayed literally.',
  'Meeting notes\n1. Keep data local\n2. Pins survive automatic cleanup\n3. Ship with tests',
  'SELECT id, kind, pinned FROM clipboard_history ORDER BY last_copied_at DESC;',
  '购物清单\n咖啡豆\n牛奶\n面包',
]

function syntheticItems(): HistoryDetail[] {
  const now = Date.UTC(2026, 10, 13, 9)
  const items: HistoryDetail[] = sampleTexts.map((text, index) => ({
    id: `sample-text-${index + 1}`, kind: 'text', hash: `sample-hash-${index}`, text,
    preview: text.slice(0, 180), byteSize: new TextEncoder().encode(text).byteLength,
    createdAt: now - (index + 1) * 3_600_000, lastCopiedAt: now - index * 180_000,
    copyCount: index % 3 + 1, pinned: index === 0 || index === 3,
  }))
  items.splice(2, 0, {
    id: 'sample-image-1', kind: 'image', hash: 'sample-image-hash', preview: '人工样例图片 · Synthetic PNG',
    byteSize: 77, width: 1, height: 1, createdAt: now - 7_200_000, lastCopiedAt: now - 270_000,
    copyCount: 1, pinned: false,
  })
  return items
}

export const isExplicitPreview = (search: string): boolean => new URLSearchParams(search).get('preview') === '1'
type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

export function createPreviewApi(storage?: SettingsStorage): ClipboardApi {
  let items = syntheticItems()
  let settings = { ...defaultSettings }
  const listeners = new Set<(topic: ClipboardTopic) => void>()
  const storageKey = 'otools-clipboard:synthetic-preview-settings'
  try {
    const stored = storage?.getItem(storageKey)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ClipboardSettings>
      validateSettingsPatch(parsed)
      settings = { ...defaultSettings, ...parsed }
    }
  } catch { /* Invalid or blocked preview preference storage does not affect history. */ }
  const changed = (topic: ClipboardTopic = 'clipboard:changed') => { for (const listener of listeners) listener(topic) }
  const find = (id: string) => {
    const item = items.find(candidate => candidate.id === id)
    if (!item) throw new ClipboardError('NATIVE_ERROR', 'clipboard_get', 'entry_not_found')
    return item
  }
  const metadata = (item: HistoryDetail): HistoryItem => {
    const { text: _text, ...rest } = item
    return { ...rest }
  }
  return {
    mode: 'preview',
    async list(request = {}) {
      const query = request.query?.toLocaleLowerCase() ?? ''
      const windowed = request.from !== undefined && request.until !== undefined
      const filtered = items.filter(item => (!request.kind || request.kind === 'all' || item.kind === request.kind) &&
        (!request.pinnedOnly || item.pinned) && (!query || (item.kind === 'text' && item.text?.toLocaleLowerCase().includes(query))) &&
        (!windowed || (item.lastCopiedAt >= request.from! && item.lastCopiedAt < request.until!)))
        .sort((a, b) => b.lastCopiedAt - a.lastCopiedAt)
      const offset = Math.max(0, request.offset ?? 0)
      const limit = Math.min(100, Math.max(1, request.limit ?? 40))
      return { items: filtered.slice(offset, offset + limit).map(metadata), total: filtered.length, offset, limit }
    },
    async get(id) { return { ...find(id) } },
    async getImage(id) {
      if (find(id).kind !== 'image') throw new ClipboardError('NATIVE_ERROR', 'clipboard_get_image', 'not_an_image')
      return { dataUrl: samplePng, width: 1, height: 1 }
    },
    async setPinned(id, pinned) { find(id).pinned = pinned; changed() },
    async delete(id) { find(id); items = items.filter(item => item.id !== id); changed() },
    async clear(includePinned = false) {
      const before = items.length
      items = includePinned ? [] : items.filter(item => item.pinned)
      changed()
      return { removed: before - items.length }
    },
    async getSettings() { return { ...settings } },
    async updateSettings(patch) {
      validateSettingsPatch(patch)
      settings = { ...settings, ...patch }
      try { storage?.setItem(storageKey, JSON.stringify(settings)) } catch { /* Preview preferences are optional. */ }
      changed('clipboard:status')
      return { ...settings }
    },
    async status() {
      return { ready: false, recording: false, paused: settings.paused, totalEntries: items.length,
        storageBytes: items.reduce((total, item) => total + item.byteSize, 0), droppedEvents: 0,
        lastError: null, sourceStatus: 'preview' }
    },
    async subscribe(handler) { listeners.add(handler); return () => { listeners.delete(handler) } },
  }
}
