export type ClipboardKind = 'text' | 'image'
export type KindFilter = 'all' | ClipboardKind

export interface HistoryItem {
  id: string
  kind: ClipboardKind
  hash: string
  preview: string
  byteSize: number
  width?: number
  height?: number
  createdAt: number
  lastCopiedAt: number
  copyCount: number
  pinned: boolean
}

export interface HistoryDetail extends HistoryItem { text?: string }
export interface ImageData { dataUrl: string; width: number; height: number }
export interface ListRequest { query?: string; kind?: KindFilter; pinnedOnly?: boolean; offset?: number; limit?: number; from?: number; until?: number }
export interface HistoryPage { items: HistoryItem[]; total: number; offset: number; limit: number }
export interface ClipboardSettings { maxEntries: number; retentionDays: number; maxBytes: number; paused: boolean }
export interface ClipboardStatus {
  ready: boolean
  recording: boolean
  paused: boolean
  totalEntries: number
  storageBytes: number
  droppedEvents: number
  lastError: string | null
  sourceStatus: string
}
export interface RemovalResult { removed: number }
export type ClipboardTopic = 'clipboard:changed' | 'clipboard:status'
export type Unsubscribe = () => void | Promise<void>
export interface ClipboardApi {
  mode: 'host' | 'preview'
  list(request?: ListRequest): Promise<HistoryPage>
  get(id: string): Promise<HistoryDetail>
  getImage(id: string, thumbnail?: boolean): Promise<ImageData>
  setPinned(id: string, pinned: boolean): Promise<void>
  delete(id: string): Promise<void>
  clear(includePinned?: boolean, window?: { from: number; until: number }): Promise<RemovalResult>
  getSettings(): Promise<ClipboardSettings>
  updateSettings(patch: Partial<ClipboardSettings>): Promise<ClipboardSettings>
  status(): Promise<ClipboardStatus>
  subscribe(handler: (topic: ClipboardTopic) => void): Promise<Unsubscribe>
}
export interface ClipboardTransport {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>
  listen(topic: ClipboardTopic, handler: () => void): Promise<Unsubscribe>
}
export interface ClipboardCopyHost {
  copyText(text: string): boolean | Promise<boolean>
  copyImage(image: string): boolean | Promise<boolean>
}
