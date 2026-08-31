export const LLMWIKI_ERROR_CODES = [
  'NOT_INITIALIZED',
  'INVALID_PATH',
  'SOURCE_NOT_FOUND',
  'PAGE_NOT_FOUND',
  'INVALID_PAGE',
  'LIMIT_EXCEEDED',
  'ABORTED',
  'UNSAFE_FILESYSTEM',
  'INDEX_CORRUPT',
  'INVALID_CURSOR',
  'CATALOG_CORRUPT',
] as const

export type LlmWikiErrorCode = (typeof LLMWIKI_ERROR_CODES)[number]

export interface SerializedLlmWikiError {
  readonly code: LlmWikiErrorCode
  readonly message: string
}

export class LlmWikiError extends Error {
  readonly code: LlmWikiErrorCode

  constructor(code: LlmWikiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmWikiError'
    this.code = code
  }

  toJSON(): SerializedLlmWikiError {
    return { code: this.code, message: this.message }
  }
}

export function isLlmWikiError(value: unknown): value is LlmWikiError {
  return value instanceof LlmWikiError
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new LlmWikiError('ABORTED', 'The operation was aborted.')
  }
}

export function invalidPath(message: string, options?: ErrorOptions): LlmWikiError {
  return new LlmWikiError('INVALID_PATH', message, options)
}

export function unsafeFilesystem(message: string, options?: ErrorOptions): LlmWikiError {
  return new LlmWikiError('UNSAFE_FILESYSTEM', message, options)
}
