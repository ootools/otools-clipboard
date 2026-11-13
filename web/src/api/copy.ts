import type { ClipboardApi, ClipboardCopyHost, HistoryItem } from '../types'
import { ClipboardError } from './errors'

export function getCopyHost(): ClipboardCopyHost | null {
  const api = typeof window !== 'undefined' ? window.otools as unknown as Partial<ClipboardCopyHost> | undefined : undefined
  return api && typeof api.copyText === 'function' && typeof api.copyImage === 'function' ? api as ClipboardCopyHost : null
}

export async function copyHistoryItem(api: ClipboardApi, item: HistoryItem, host: ClipboardCopyHost | null = getCopyHost()): Promise<{ state: 'requested' }> {
  if (!host) throw new ClipboardError('COPY_UNAVAILABLE', 'copy', 'host_copy_required')
  const detail = item.kind === 'text' ? await api.get(item.id) : null
  const image = item.kind === 'image' ? await api.getImage(item.id, false) : null
  if (detail && typeof detail.text !== 'string') throw new ClipboardError('INVALID_REPLY', 'clipboard_get', 'missing_text')
  try {
    const accepted = detail ? await host.copyText(detail.text!) : await host.copyImage(image!.dataUrl)
    if (accepted !== true) throw new Error('copy_rejected')
    // The existing host API only acknowledges dispatch, not the eventual OS write.
    return { state: 'requested' }
  } catch {
    throw new ClipboardError('COPY_FAILED', 'copy', 'host_copy_failed')
  }
}
