import type { Branded } from '@deepseek-ai/dsh-brand'
import { invalidPath } from './errors.ts'

export type SourceId = Branded<'SourceId'>
export type PageId = Branded<'PageId'>

const SOURCE_ID_PATTERN = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/u

export function sourceId(value: string): SourceId {
  if (!SOURCE_ID_PATTERN.test(value)) {
    throw invalidPath('Source ID must be exactly 64 lowercase hexadecimal characters.')
  }
  return value as SourceId
}

export function pageId(value: string): PageId {
  if (value.length === 0) {
    throw invalidPath('Page ID must not be empty.')
  }
  if (value.startsWith('/') || value.startsWith('//') || WINDOWS_DRIVE_PATTERN.test(value)) {
    throw invalidPath('Page ID must be a relative POSIX path.')
  }
  if (value.includes('\\')) {
    throw invalidPath('Page ID must use POSIX separators.')
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw invalidPath('Page ID must not contain control characters.')
  }
  if (value.includes('%')) {
    throw invalidPath('Page ID must not contain percent-encoded or ambiguous percent characters.')
  }
  if (value.toLowerCase().endsWith('.md')) {
    throw invalidPath('Page ID must not include the .md extension.')
  }

  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw invalidPath('Page ID must not contain empty, current-directory, or parent-directory segments.')
  }

  return segments.join('/') as PageId
}

export function isSourceId(value: string): value is SourceId {
  return SOURCE_ID_PATTERN.test(value)
}

export function isPageId(value: string): value is PageId {
  try {
    pageId(value)
    return true
  } catch {
    return false
  }
}
