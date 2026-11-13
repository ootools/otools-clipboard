import type { HistoryDetail, HistoryItem, ClipboardSettings, ClipboardStatus } from '../src/types'

export const textItem: HistoryItem = {
  id: 'text-1', kind: 'text', hash: 'hash-text', preview: 'Short preview', byteSize: 40,
  createdAt: 1_799_971_200_000, lastCopiedAt: 1_799_971_202_000, copyCount: 2, pinned: false,
}
export const textDetail: HistoryDetail = { ...textItem, text: 'Full text, not just the short preview.' }
export const imageItem: HistoryItem = {
  id: 'image-1', kind: 'image', hash: 'hash-image', preview: 'Image 2 × 2', byteSize: 77,
  width: 2, height: 2, createdAt: 1_799_971_201_000, lastCopiedAt: 1_799_971_201_000,
  copyCount: 1, pinned: true,
}
export const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
export const settings: ClipboardSettings = { maxEntries: 500, retentionDays: 30, maxBytes: 268_435_456, paused: false }
export const readyStatus: ClipboardStatus = {
  ready: true, recording: true, paused: false, totalEntries: 2, storageBytes: 117,
  droppedEvents: 0, lastError: null, sourceStatus: 'ready',
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
