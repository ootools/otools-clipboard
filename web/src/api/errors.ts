export type ClipboardErrorCode = 'INVALID_REPLY' | 'NATIVE_ERROR' | 'HOST_UNAVAILABLE' | 'INVALID_SETTINGS' | 'COPY_UNAVAILABLE' | 'COPY_FAILED'

export class ClipboardError extends Error {
  constructor(public readonly code: ClipboardErrorCode, public readonly operation: string, message: string) {
    super(message)
    this.name = 'ClipboardError'
  }
}

export function asClipboardError(error: unknown, operation = 'clipboard'): ClipboardError {
  if (error instanceof ClipboardError) return error
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'operation_failed'
  return new ClipboardError('NATIVE_ERROR', operation, message.slice(0, 240))
}
