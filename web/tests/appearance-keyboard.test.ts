import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'
import * as appearanceModule from '../src/composables/useAppearance'
import * as keyboardModule from '../src/composables/useHistoryKeyboard'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  document.body.replaceChildren()
  document.documentElement.className = ''
  document.documentElement.lang = ''
  document.documentElement.removeAttribute('data-theme-mode')
  document.documentElement.removeAttribute('data-theme-accent')
})
const scoped = <T>(factory: () => T): T => {
  const scope = effectScope(); scopes.push(scope); return scope.run(factory)!
}
const settle = async () => { await nextTick(); await Promise.resolve(); await nextTick() }

function keyboardEvent(key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

describe('host appearance compatibility', () => {
  it('defaults to Chinese rather than using the browser language as an implicit override', () => {
    expect(appearanceModule.useAppearance).toBeTypeOf('function')
    const preferences = scoped(() => appearanceModule.useAppearance())
    expect(preferences.locale.value).toBe('zh-CN')
    expect(preferences.t('title')).toBe('剪贴板历史')
  })

  it('honors existing injected dark mode and locale before rendering', () => {
    expect(appearanceModule.useAppearance).toBeTypeOf('function')
    document.documentElement.classList.add('dark')
    document.documentElement.lang = 'en-US'
    const preferences = scoped(() => appearanceModule.useAppearance())
    expect(preferences.theme.value).toBe('dark')
    expect(preferences.locale.value).toBe('en-US')
    expect(preferences.t('title')).toBe('Clipboard history')
  })

  it('responds to the host actual DOM theme and locale sync events without any host status API', async () => {
    expect(appearanceModule.useAppearance).toBeTypeOf('function')
    const preferences = scoped(() => appearanceModule.useAppearance())
    window.dispatchEvent(new CustomEvent('otools-theme-changed', { detail: { themeMode: 'dark', resolvedTheme: 'dark', themeAccent: 'emerald' } }))
    document.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale: 'en-US' } }))
    await settle()
    expect(preferences.theme.value).toBe('dark')
    expect(document.documentElement.dataset.themeAccent).toBe('emerald')
    expect(preferences.locale.value).toBe('en-US')
    expect(preferences.t('copy')).toBe('Copy')
  })

  it('observes root attribute sync and releases listeners on component disposal', async () => {
    expect(appearanceModule.useAppearance).toBeTypeOf('function')
    const preferences = scoped(() => appearanceModule.useAppearance())
    document.documentElement.lang = 'en-US'
    document.documentElement.classList.add('dark')
    await settle()
    expect(preferences.theme.value).toBe('dark')
    expect(preferences.locale.value).toBe('en-US')
    scopes.at(-1)!.stop()
    window.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale: 'zh-CN' } }))
    expect(preferences.locale.value).toBe('en-US')
  })

  it('ignores arbitrary unrelated window messages claiming to set host appearance', () => {
    expect(appearanceModule.useAppearance).toBeTypeOf('function')
    const preferences = scoped(() => appearanceModule.useAppearance())
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'otools:theme-sync', resolvedTheme: 'dark' }, source: null }))
    expect(preferences.theme.value).toBe('light')
  })
})

describe('panel-local keyboard behavior', () => {
  it('moves selection with arrow keys and requests copy on Enter without browser or global shortcuts', () => {
    expect(keyboardModule.useHistoryKeyboard).toBeTypeOf('function')
    const changes: number[] = []
    let copies = 0
    scoped(() => keyboardModule.useHistoryKeyboard({ move: delta => { changes.push(delta) }, copy: () => { copies++ }, focusSearch: () => {}, isBlocked: () => false }))
    expect(keyboardEvent('ArrowDown').defaultPrevented).toBe(true)
    keyboardEvent('ArrowUp')
    expect(keyboardEvent('Enter').defaultPrevented).toBe(true)
    expect(changes).toEqual([1, -1])
    expect(copies).toBe(1)
  })

  it('focuses search with both Ctrl-F and Cmd-F but leaves editing and dialog Enter alone', () => {
    expect(keyboardModule.useHistoryKeyboard).toBeTypeOf('function')
    let focused = 0
    let copied = 0
    let moved = 0
    let blocked = false
    scoped(() => keyboardModule.useHistoryKeyboard({ move: () => { moved++ }, copy: () => { copied++ }, focusSearch: () => { focused++ }, isBlocked: () => blocked }))
    keyboardEvent('f', { ctrlKey: true })
    keyboardEvent('F', { metaKey: true })
    expect(focused).toBe(2)
    const input = document.createElement('input'); document.body.append(input)
    expect(keyboardEvent('Enter', {}, input).defaultPrevented).toBe(false)
    keyboardEvent('ArrowDown', {}, input)
    const editable = document.createElement('div'); editable.setAttribute('contenteditable', 'true'); document.body.append(editable)
    keyboardEvent('Enter', {}, editable)
    blocked = true
    expect(keyboardEvent('Enter').defaultPrevented).toBe(false)
    keyboardEvent('f', { ctrlKey: true })
    expect(focused).toBe(2)
    expect(copied).toBe(0)
    expect(moved).toBe(0)
  })

  it('does not steal normal button Enter, but supports a focused history row and cleans up on dispose', () => {
    expect(keyboardModule.useHistoryKeyboard).toBeTypeOf('function')
    let copied = 0
    scoped(() => keyboardModule.useHistoryKeyboard({ move: () => {}, copy: () => { copied++ }, focusSearch: () => {}, isBlocked: () => false }))
    const button = document.createElement('button'); document.body.append(button)
    keyboardEvent('Enter', {}, button)
    expect(copied).toBe(0)
    button.dataset.historyRow = 'text-1'
    keyboardEvent('Enter', {}, button)
    expect(copied).toBe(1)
    scopes.at(-1)!.stop()
    keyboardEvent('Enter')
    expect(copied).toBe(1)
  })
})
