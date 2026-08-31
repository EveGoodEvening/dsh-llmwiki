import type { PageId, SourceId } from './ids.ts'

export interface IndexStatus {
  readonly present: boolean
  readonly fresh: boolean
  readonly formatVersion: number | null
  readonly sectionCount: number
}

export interface ReindexReceipt {
  readonly pageCount: number
  readonly sectionCount: number
  readonly formatVersion: number
}

export interface WikiStatus {
  readonly initialized: boolean
  readonly sourceCount: number
  readonly pageCount: number
  readonly schemaText: string | null
  readonly index: IndexStatus
}

export interface AddSourceInput {
  readonly name: string
  readonly content: string
  readonly mediaType?: string
  readonly origin?: string
}

export interface SourceMetadata {
  readonly id: SourceId
  readonly name: string
  readonly mediaType: string
  readonly byteCount: number
  readonly capturedAt: string
  readonly origin?: string
}

export interface SourceReceipt {
  readonly id: SourceId
  readonly deduplicated: boolean
  readonly metadata: SourceMetadata
}

export interface ByteRange {
  readonly offset: number
  readonly limit: number
}

export interface SourceRead {
  readonly id: SourceId
  readonly content: string
  readonly metadata: SourceMetadata
  readonly byteStart: number
  readonly byteEnd: number
  readonly byteCount: number
}

export interface CatalogRequest {
  readonly limit?: number
  readonly cursor?: string
}

export interface SourceCatalogEntry {
  readonly id: SourceId
  readonly name: string
  readonly mediaType: string
  readonly byteCount: number
  readonly capturedAt: string
  readonly origin?: string
}

export interface SourceCatalogPage {
  readonly items: readonly SourceCatalogEntry[]
  readonly nextCursor: string | null
}

export interface PageCatalogEntry {
  readonly id: PageId
  readonly title: string
  readonly summary: string
  readonly sources: readonly SourceId[]
  readonly byteCount: number
  readonly sha256: string
}

export interface PageCatalogPage {
  readonly items: readonly PageCatalogEntry[]
  readonly nextCursor: string | null
}

export interface PageMetadata {
  readonly title: string
  readonly summary: string
  readonly sources: readonly SourceId[]
}

export interface PageRead {
  readonly id: PageId
  readonly markdown: string
  readonly metadata: PageMetadata
}

export interface UpsertPageInput extends PageMetadata {
  readonly id: PageId
  readonly body: string
}

export interface PageReceipt {
  readonly id: PageId
  readonly created: boolean
  readonly sha256: string
}

export interface SearchHit {
  readonly pageId: PageId
  readonly title: string
  readonly headingTrail: readonly string[]
  readonly startLine: number
  readonly score: number
  readonly snippet: string
  readonly sourceIds: readonly SourceId[]
}

export type LintSeverity = 'error' | 'warning'

export interface LintDiagnostic {
  readonly code: string
  readonly severity: LintSeverity
  readonly path: string
  readonly line?: number
  readonly message: string
}

export interface LintReport {
  readonly diagnostics: readonly LintDiagnostic[]
  readonly errorCount: number
  readonly warningCount: number
  readonly filesExamined: number
}
