import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import App from '../src/App.vue'
import type { ClipboardApi, ClipboardSettings, HistoryItem } from '../src/types'
import { textItem, textDetail, imageItem, pngDataUrl, settings, readyStatus } from './fixtures'

const apps: VueApp[] = []
const oldOtools = window.otools
const flush = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  document.body.replaceChildren()
  document.documentElement.lang = ''
  document.documentElement.className = ''
  window.otools = oldOtools
})

function baseApi(): ClipboardApi {
  return {
    mode: 'host', list: async request => ({ items: [textItem, imageItem], total: 2, offset: request?.offset ?? 0, limit: 40 }),
    get: async id => id === imageItem.id ? imageItem : textDetail,
    getImage: async () => ({ dataUrl: pngDataUrl, width: 1, height: 1 }),
    setPinned: async () => {}, delete: async () => {}, clear: async () => ({ removed: 1 }),
    getSettings: async () => settings, updateSettings: async patch => ({ ...settings, ...patch }),
    status: async () => readyStatus, subscribe: async () => () => {},
  }
}
async function mount(api: ClipboardApi) {
  const node = document.createElement('div'); document.body.append(node)
  const app = createApp(App, { api }); apps.push(app); app.mount(node)
  await flush()
  return node
}
async function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector)
  expect(element, `Missing interactive element ${selector}`).not.toBeNull()
  element!.click(); await flush()
}
async function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)
  expect(element, `Missing input ${selector}`).not.toBeNull()
  element!.value = value
  element!.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

describe('real Vue panel', () => {
  it('renders HTML-looking clipboard text literally in both list and selected detail', async () => {
    const malicious = '<img src=x onerror="window.hacked=true"><script>alert(1)</script>'
    const item = { ...textItem, preview: malicious }
    const api = baseApi()
    api.list = async () => ({ items: [item], total: 1, offset: 0, limit: 40 })
    api.get = async () => ({ ...item, text: malicious })
    const root = await mount(api)
    expect(root.textContent).toContain('剪贴板历史')
    expect(root.querySelector('[data-history-row]')?.textContent).toContain(malicious)
    expect(root.querySelector('[data-testid="full-text"]')?.textContent).toBe(malicious)
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('img[onerror]')).toBeNull()
  })

  it('labels preview visibly and never labels synthetic entries as automatic recording', async () => {
    const api = baseApi(); api.mode = 'preview'
    api.status = async () => ({ ...readyStatus, ready: false, recording: false, sourceStatus: 'preview' })
    const root = await mount(api)
    expect(root.querySelector('[data-testid="mode-notice"]')?.textContent).toContain('人工样例')
    expect(root.querySelector('[data-testid="recording-status"]')?.textContent).toContain('人工样例预览')
    expect(root.querySelector('[data-testid="recording-status"]')?.textContent).not.toContain('正在记录')
  })

  it('shows protocol-update guidance rather than recording before the host started handshake', async () => {
    const api = baseApi()
    api.status = async () => ({ ...readyStatus, ready: false, recording: false, sourceStatus: 'idle' })
    const root = await mount(api)
    expect(root.textContent).toContain('需要支持原生事件协议')
    expect(root.querySelector('[data-testid="recording-status"]')?.textContent).not.toContain('正在记录')
  })

  it('switches type and pin filters through real controls and exposes accessible selection', async () => {
    const requests: unknown[] = []
    const api = baseApi()
    api.list = async request => { requests.push(request); return { items: request?.kind === 'image' ? [imageItem] : [textItem, imageItem], total: 2, offset: 0, limit: 40 } }
    const root = await mount(api)
    await click('[data-filter="image"]')
    expect(requests.at(-1)).toMatchObject({ kind: 'image', offset: 0 })
    await click('[data-filter="pinned"]')
    expect(requests.at(-1)).toMatchObject({ pinnedOnly: true, offset: 0 })
    expect(root.querySelector('[data-history-row="image-1"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('warns about pins and waits for the actual delete confirmation button', async () => {
    const deleted: string[] = []
    const api = baseApi(); api.delete = async id => { deleted.push(id) }
    await mount(api)
    await click('[data-history-row="image-1"]')
    await click('[data-action="delete-entry"]')
    expect(document.body.textContent).toContain('这是一条置顶记录')
    expect(deleted).toEqual([])
    await click('[data-action="confirm-delete"]')
    expect(deleted).toEqual(['image-1'])
  })

  it('makes include-pins clear an unchecked explicit choice and defaults the confirmed call to false', async () => {
    const cleared: boolean[] = []
    const api = baseApi(); api.clear = async includePinned => { cleared.push(includePinned ?? false); return { removed: 1 } }
    await mount(api)
    await click('[data-action="clear-history"]')
    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="include-pinned"] input')!
    expect(checkbox.checked).toBe(false)
    expect(cleared).toEqual([])
    await click('[data-action="confirm-clear"]')
    expect(cleared).toEqual([false])
    await click('[data-action="clear-history"]')
    await click('[data-testid="include-pinned"] input')
    expect(document.body.textContent).toContain('所有历史都将被删除')
    await click('[data-action="confirm-clear"]')
    expect(cleared).toEqual([false, true])
  })

  it('shows default retention values, blocks invalid settings, and persists a valid pause toggle', async () => {
    const patches: Partial<ClipboardSettings>[] = []
    const api = baseApi(); api.updateSettings = async patch => { patches.push(patch); return { ...settings, ...patch } }
    await mount(api)
    await click('[data-action="open-settings"]')
    expect(document.querySelector<HTMLInputElement>('#max-entries')?.value).toBe('500')
    expect(document.querySelector<HTMLInputElement>('#retention-days')?.value).toBe('30')
    expect(document.querySelector<HTMLInputElement>('#max-mib')?.value).toBe('256')
    await input('#retention-days', '0')
    await click('[data-action="save-settings"]')
    expect(patches).toEqual([])
    expect(document.body.textContent).toContain('正整数')
    await input('#retention-days', '31')
    await click('[data-action="save-settings"]')
    expect(patches).toEqual([{ maxEntries: 500, retentionDays: 31, maxBytes: 268435456 }])
    await click('[data-action="toggle-pause"]')
    expect(patches.at(-1)).toEqual({ paused: true })
    expect(document.querySelector('[data-testid="recording-status"]')?.textContent).toContain('已暂停')
  })

  it('supports ArrowDown/Enter and Ctrl-F without copying while the user edits search', async () => {
    const copied: string[] = []
    window.otools = { copyText: (value: string) => { copied.push(value); return true }, copyImage: (value: string) => { copied.push(value); return true } } as unknown as NonNullable<Window['otools']>
    const root = await mount(baseApi())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await flush()
    expect(root.querySelector('[data-history-row="image-1"]')?.getAttribute('aria-selected')).toBe('true')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush()
    expect(copied).toEqual([pngDataUrl])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })); await flush()
    const search = root.querySelector<HTMLInputElement>('input[data-testid="search"]')!
    expect(document.activeElement).toBe(search)
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await flush()
    expect(copied).toHaveLength(1)
  })

  it('shows an empty-search state distinct from an unfiltered empty history', async () => {
    const api = baseApi(); api.list = async request => ({ items: [], total: 0, offset: request?.offset ?? 0, limit: 40 })
    const root = await mount(api)
    expect(root.textContent).toContain('还没有复制记录')
    await click('[data-filter="pinned"]')
    expect(root.textContent).toContain('没有匹配的记录')
  })

  it('renders the entry type as a gray pill beside the size instead of its own line', async () => {
    const root = await mount(baseApi())
    const row = root.querySelector('[data-history-row="image-1"]')!
    expect(row.querySelector('[data-testid="kind-pill"]')?.textContent).toBe('图片')
    expect(row.querySelector('[data-testid="row-top"]')?.textContent).not.toContain('图片')
    const textRow = root.querySelector('[data-history-row="text-1"]')!
    expect(textRow.querySelector('[data-testid="kind-pill"]')?.textContent).toBe('文本')
    expect(textRow.querySelector('[data-testid="row-top"]')?.textContent).not.toContain('文本')
  })

  it('offers all-history or date-range scope when clearing', async () => {
    const calls: Array<Record<string, unknown>> = []
    const api = baseApi()
    api.clear = async (includePinned, window) => { calls.push({ includePinned: includePinned ?? false, ...(window ?? {}) }); return { removed: 1 } }
    await mount(api)
    await click('[data-action="clear-history"]')
    expect(document.querySelector('[data-testid="clear-scope-all"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="clear-from"]')).toBeNull()
    await click('[data-testid="clear-scope-range"] input')
    const fromInput = document.querySelector<HTMLInputElement>('[data-testid="clear-from"] input')!
    expect(fromInput, 'range mode reveals start and end date pickers').not.toBeNull()
    expect(fromInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(document.querySelector<HTMLInputElement>('[data-testid="clear-to"] input')).not.toBeNull()
    await click('[data-action="confirm-clear"]')
    expect(calls.at(-1)?.from).toBeTypeOf('number')
    expect(calls.at(-1)?.until).toBeTypeOf('number')
  })

  it('keeps clear available when a filter hides every item but stored history still exists', async () => {
    const api = baseApi()
    api.list = async request => ({ items: request?.pinnedOnly ? [] : [textItem], total: request?.pinnedOnly ? 0 : 1, offset: 0, limit: 40 })
    await mount(api)
    await click('[data-filter="pinned"]')
    const clear = document.querySelector<HTMLButtonElement>('[data-action="clear-history"]')!
    expect(clear.disabled).toBe(false)
    await click('[data-action="clear-history"]')
    expect(document.body.textContent).toContain('默认只清除未置顶记录')
  })

  it('preserves a valid one-byte native content budget when editing unrelated settings', async () => {
    const patches: Partial<ClipboardSettings>[] = []
    const api = baseApi()
    api.getSettings = async () => ({ ...settings, maxBytes: 1 })
    api.updateSettings = async patch => { patches.push(patch); return { ...settings, maxBytes: 1, ...patch } }
    await mount(api)
    await click('[data-action="open-settings"]')
    await input('#retention-days', '31')
    await click('[data-action="save-settings"]')
    expect(patches).toEqual([{ maxEntries: 500, retentionDays: 31, maxBytes: 1 }])
  })

  it('moves focus with arrow selection when the active element is a history row', async () => {
    const root = await mount(baseApi())
    const first = root.querySelector<HTMLButtonElement>('[data-history-row="text-1"]')!
    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flush()
    expect(document.activeElement).toBe(root.querySelector('[data-history-row="image-1"]'))
  })

  it('keeps status chips inside the header and search plus filters on one toolbar row', async () => {
    const root = await mount(baseApi())
    const status = root.querySelector('[data-testid="recording-status"]')
    expect(status, 'recording status chips must exist').not.toBeNull()
    expect(root.querySelector('header')?.contains(status!), 'status belongs to the header row, not its own block').toBe(true)
    const toolbar = root.querySelector('input[data-testid="search"]')?.closest('.toolbar-row')
    expect(toolbar, 'search and filter buttons share one toolbar row').not.toBeNull()
    expect(toolbar!.querySelector('[data-filter="all"]')).not.toBeNull()
    expect(toolbar!.querySelector('[data-filter="pinned"]')).not.toBeNull()
    const dateFilter = toolbar!.querySelector('[data-testid="date-filter"]')
    expect(dateFilter, 'a date picker sits on the right of the filter row').not.toBeNull()
    expect(dateFilter?.getAttribute('aria-label')).toContain('日期')
  })

  it('explains background local recording and the no-startup-import rule in visible panel text', async () => {
    const root = await mount(baseApi())
    expect(root.textContent).toContain('启动不导入当前剪贴板')
  })

  it('handles unavailable listeners without preventing the initial panel from rendering', async () => {
    const api = baseApi(); api.subscribe = async () => { throw new Error('legacy_listen_unavailable') }
    const root = await mount(api)
    expect(root.querySelector('[data-history-row="text-1"]')).not.toBeNull()
    expect(root.textContent).toContain('自动刷新不可用')
  })
})
