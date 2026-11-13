import { onScopeDispose, ref } from 'vue'
import { translate, type Locale, type Translate } from '../i18n/messages'

export function useAppearance() {
  const root = document.documentElement
  const locale = ref<Locale>(/^en(?:-|$)/i.test(root.lang) ? 'en-US' : 'zh-CN')
  const theme = ref<'light' | 'dark'>(root.classList.contains('dark') ? 'dark' : 'light')
  const t: Translate = (key, values) => translate(locale.value, key, values)
  const accents = ['classic', 'violet', 'emerald', 'amber', 'pink']

  function setLocale(value: string) {
    locale.value = /^en(?:-|$)/i.test(value) ? 'en-US' : 'zh-CN'
    if (root.lang !== locale.value) root.lang = locale.value
  }
  function setTheme(value: 'dark' | 'light') {
    theme.value = value
    root.classList.toggle('dark', value === 'dark')
    root.classList.toggle('light', value === 'light')
    root.style.colorScheme = value
  }
  const themeEvent = (event: Event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail
    if (!detail || typeof detail !== 'object') return
    const resolved = detail.resolvedTheme ?? detail.themeMode
    if (resolved === 'light' || resolved === 'dark') setTheme(resolved)
    if (typeof detail.themeMode === 'string' && ['system', 'light', 'dark'].includes(detail.themeMode)) root.dataset.themeMode = detail.themeMode
    if (typeof detail.themeAccent === 'string' && accents.includes(detail.themeAccent)) root.dataset.themeAccent = detail.themeAccent
  }
  const localeEvent = (event: Event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail
    if (detail && typeof detail.locale === 'string') setLocale(detail.locale)
  }
  const messageEvent = (event: MessageEvent) => {
    // Only the embedding parent may forward host theme sync. Never trust unrelated windows.
    if (window.parent === window || event.source !== window.parent || !event.data || event.data.type !== 'otools:theme-sync') return
    themeEvent(new CustomEvent('otools-theme-changed', { detail: event.data }))
  }
  const observer = new MutationObserver(() => {
    theme.value = root.classList.contains('dark') ? 'dark' : 'light'
    locale.value = /^en(?:-|$)/i.test(root.lang) ? 'en-US' : 'zh-CN'
  })
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'lang', 'data-theme-mode', 'data-theme-accent'] })
  window.addEventListener('otools-theme-changed', themeEvent)
  document.addEventListener('otools-theme-changed', themeEvent)
  window.addEventListener('otools-locale-changed', localeEvent)
  document.addEventListener('otools-locale-changed', localeEvent)
  window.addEventListener('message', messageEvent)
  onScopeDispose(() => {
    observer.disconnect()
    window.removeEventListener('otools-theme-changed', themeEvent)
    document.removeEventListener('otools-theme-changed', themeEvent)
    window.removeEventListener('otools-locale-changed', localeEvent)
    document.removeEventListener('otools-locale-changed', localeEvent)
    window.removeEventListener('message', messageEvent)
  })
  return { locale, theme, t, setLocale, setTheme }
}
