import { onScopeDispose } from 'vue'

interface KeyboardActions {
  move(delta: number): unknown
  copy(): unknown
  focusSearch(): void
  isBlocked(): boolean
}

export function useHistoryKeyboard(actions: KeyboardActions) {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || actions.isBlocked()) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.altKey) {
      event.preventDefault()
      actions.focusSearch()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
    if (target?.closest('button, a, [role="button"]') && !target.closest('[data-history-row]')) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      void actions.move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void actions.copy()
    }
  }
  window.addEventListener('keydown', onKeydown)
  onScopeDispose(() => window.removeEventListener('keydown', onKeydown))
}
