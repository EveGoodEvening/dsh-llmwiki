import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec, ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { isLlmWikiError, LlmWikiError } from './errors.ts'
import { pageId, sourceId } from './ids.ts'
import { presentLlmWikiCall, presentLlmWikiResult } from './presentation.ts'
import type { LlmWikiToolName } from './presentation.ts'

const requiredString = () => ({ type: 'string', required: true } as const)
const requiredInteger = () => ({ type: 'integer', required: true } as const)
const requiredNumber = () => ({ type: 'number', required: true } as const)
const requiredBoolean = () => ({ type: 'boolean', required: true } as const)
const requiredStringArray = () => ({ type: 'array', required: true, items: { type: 'string' } } as const)
const closed = <const P extends ParameterSchemaSpec>(properties: P) => ({ type: 'object', additionalProperties: false, properties } as const)
const requiredClosed = <const P extends ParameterSchemaSpec>(properties: P) => ({ ...closed(properties), required: true } as const)
const requiredNullableString = { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } as const satisfies ParameterPropertySpec
const requiredNullableInteger = { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] } as const satisfies ParameterPropertySpec
const optionalNullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const satisfies ValueSchemaSpec
const indexSchema = requiredClosed({ present: requiredBoolean(), fresh: requiredBoolean(), formatVersion: requiredNullableInteger, sectionCount: requiredInteger() })
const metadataSchema = requiredClosed({ id: requiredString(), name: requiredString(), mediaType: requiredString(), byteCount: requiredInteger(), capturedAt: requiredString(), origin: optionalNullableString })
const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

function stableFailure(cause: unknown): never {
  if (isLlmWikiError(cause)) throw new LlmWikiError(cause.code, cause.message)
  throw cause
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (cause) { stableFailure(cause) }
}

function presentation(name: LlmWikiToolName) {
  return {
    presentCall: (args: Record<string, unknown>) => presentLlmWikiCall(name, args),
    presentResult: (args: Record<string, unknown>, result: Parameters<typeof presentLlmWikiResult>[2]) => presentLlmWikiResult(name, args, result),
  }
}

export function registerLlmWikiTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'llmwiki_status',
    description: 'Discover wiki initialization, schema, durable record counts, and derived-index freshness before relying on wiki knowledge. Read-only; no approval or filesystem capability is requested.',
    parameters: {},
    output: { schema: closed({ initialized: requiredBoolean(), sourceCount: requiredInteger(), pageCount: requiredInteger(), schemaText: requiredNullableString, index: indexSchema }), render },
    execute: (_args, exec) => call(async () => {
      const status = await ctx.llmwiki.status(exec.signal)
      return {
        initialized: status.initialized,
        sourceCount: status.sourceCount,
        pageCount: status.pageCount,
        schemaText: status.schemaText,
        index: {
          present: status.index.present,
          fresh: status.index.fresh,
          formatVersion: status.index.formatVersion,
          sectionCount: status.index.sectionCount,
        },
      }
    }),
    isConcurrencySafe: () => true,
    ...presentation('llmwiki_status'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_add_source',
    description: 'Preserve exact UTF-8 evidence supplied in content as an immutable source record. This mutates wiki storage and should be used only with authorized evidence; it cannot read host paths. Completion returns the durable source artifact ID and dedupe state.',
    parameters: {
      name: { type: 'string', required: true, description: 'Non-empty human-readable source name.' },
      content: { type: 'string', required: true, description: 'Exact UTF-8 source content containing at least one byte; whitespace-only content is valid; bounded by deployment maxSourceBytes.' },
      mediaType: { type: 'string', description: 'Optional non-empty media type; defaults to UTF-8 plain text.' },
      origin: { type: 'string', description: 'Optional provenance label or URL containing at least one non-whitespace character; never used as a host path.' },
    },
    output: { schema: closed({ id: requiredString(), deduplicated: requiredBoolean(), metadata: metadataSchema }), render },
    execute: (args, exec) => call(async () => {
      const receipt = await ctx.llmwiki.addSource({ name: args.name, content: args.content, ...(args.mediaType === undefined ? {} : { mediaType: args.mediaType }), ...(args.origin === undefined ? {} : { origin: args.origin }) }, exec.signal)
      return {
        id: receipt.id,
        deduplicated: receipt.deduplicated,
        metadata: {
          id: receipt.metadata.id,
          name: receipt.metadata.name,
          mediaType: receipt.metadata.mediaType,
          byteCount: receipt.metadata.byteCount,
          capturedAt: receipt.metadata.capturedAt,
          ...(receipt.metadata.origin === undefined ? {} : { origin: receipt.metadata.origin }),
        },
      }
    }),
    ...presentation('llmwiki_add_source'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_read_source',
    description: 'Read immutable source evidence by exact source ID, optionally using a configured byte-bounded range. Read-only and returns provenance metadata with the content artifact. A non-EOF range must fit at least one complete UTF-8 code point or returns LIMIT_EXCEEDED instructing the caller to increase limit.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact 64-character lowercase hexadecimal source ID.' },
      offset: { type: 'integer', description: 'Optional non-negative zero-based UTF-8 byte offset; defaults to 0.' },
      limit: { type: 'integer', description: 'Optional positive maximum bytes; defaults to deployment maxSourceBytes and is bounded by it. Increase it if no complete UTF-8 code point fits.' },
    },
    output: { schema: closed({ id: requiredString(), content: requiredString(), metadata: metadataSchema, byteStart: requiredInteger(), byteEnd: requiredInteger(), byteCount: requiredInteger() }), render },
    execute: (args, exec) => call(async () => {
      const range = args.offset === undefined && args.limit === undefined
        ? undefined
        : {
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          }
      const source = await ctx.llmwiki.readSource(sourceId(args.id), range as Parameters<typeof ctx.llmwiki.readSource>[1], exec.signal)
      return {
        id: source.id,
        content: source.content,
        metadata: {
          id: source.metadata.id,
          name: source.metadata.name,
          mediaType: source.metadata.mediaType,
          byteCount: source.metadata.byteCount,
          capturedAt: source.metadata.capturedAt,
          ...(source.metadata.origin === undefined ? {} : { origin: source.metadata.origin }),
        },
        byteStart: source.byteStart,
        byteEnd: source.byteEnd,
        byteCount: source.byteCount,
      }
    }),
    isConcurrencySafe: () => true,
    ...presentation('llmwiki_read_source'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_search',
    description: 'Search the derived section index first for ranked evidence. May rebuild only stale derived index artifacts; it does not alter durable pages or sources. Results are capped by deployment maxResults and snippets by maxSnippetBytes.',
    parameters: {
      query: { type: 'string', required: true, description: 'Non-empty Unicode lexical query containing at least one letter or number.' },
      limit: { type: 'integer', description: 'Optional positive result cap up to 100, additionally bounded by deployment maxResults.' },
    },
    output: { schema: { type: 'array', items: closed({ pageId: requiredString(), title: requiredString(), headingTrail: requiredStringArray(), startLine: requiredInteger(), score: requiredNumber(), snippet: requiredString(), sourceIds: requiredStringArray() }) }, render },
    execute: (args, exec) => call(async () => {
      const hits = await ctx.llmwiki.search(args.query, args.limit, exec.signal)
      return hits.map(hit => ({
        pageId: hit.pageId,
        title: hit.title,
        headingTrail: [...hit.headingTrail],
        startLine: hit.startLine,
        score: hit.score,
        snippet: hit.snippet,
        sourceIds: [...hit.sourceIds],
      }))
    }),
    ...presentation('llmwiki_search'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_read_page',
    description: 'Read one synthesized wiki page by normalized logical page ID. Read-only; use its cited source IDs to inspect immutable evidence when needed.',
    parameters: { id: { type: 'string', required: true, description: 'Non-empty normalized POSIX page ID without a leading slash or .md suffix.' } },
    output: { schema: closed({ id: requiredString(), markdown: requiredString(), metadata: requiredClosed({ title: requiredString(), summary: requiredString(), sources: requiredStringArray() }) }), render },
    execute: (args, exec) => call(async () => {
      const page = await ctx.llmwiki.readPage(pageId(args.id), exec.signal)
      return {
        id: page.id,
        markdown: page.markdown,
        metadata: {
          title: page.metadata.title,
          summary: page.metadata.summary,
          sources: [...page.metadata.sources],
        },
      }
    }),
    isConcurrencySafe: () => true,
    ...presentation('llmwiki_read_page'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_upsert_page',
    description: 'Atomically create or update a synthesized durable Markdown page from structured fields. This mutation requires real preserved source IDs and should be used only when new evidence changes durable knowledge. Returns the page artifact ID, creation state, and content hash.',
    parameters: {
      id: { type: 'string', required: true, description: 'Non-empty normalized POSIX page ID without a leading slash or .md suffix.' },
      title: { type: 'string', required: true, description: 'Non-empty concise page title.' },
      summary: { type: 'string', required: true, description: 'Non-empty concise evidence-backed summary.' },
      sources: { type: 'array', required: true, items: { type: 'string' }, description: 'Non-empty sorted unique 64-character lowercase hexadecimal IDs of preserved source evidence; never invent IDs.' },
      body: { type: 'string', required: true, description: 'Non-empty Markdown body bounded by deployment maxPageBytes after canonical rendering.' },
    },
    output: { schema: closed({ id: requiredString(), created: requiredBoolean(), sha256: requiredString() }), render },
    execute: (args, exec) => call(async () => {
      const receipt = await ctx.llmwiki.upsertPage({ id: pageId(args.id), title: args.title, summary: args.summary, sources: args.sources.map(sourceId), body: args.body }, exec.signal)
      return { id: receipt.id, created: receipt.created, sha256: receipt.sha256 }
    }),
    ...presentation('llmwiki_upsert_page'),
  }))

  ctx.tools.register(defineTool({
    name: 'llmwiki_lint',
    description: 'Run deterministic read-only wiki validation. Reports diagnostics and progress counts but never fixes, deletes, or rewrites artifacts.',
    parameters: {},
    output: { schema: closed({ diagnostics: { type: 'array', required: true, items: closed({ code: requiredString(), severity: { type: 'string', required: true, enum: ['error', 'warning'] }, path: requiredString(), line: requiredNullableInteger, message: requiredString() }) }, errorCount: requiredInteger(), warningCount: requiredInteger(), filesExamined: requiredInteger() }), render },
    execute: (_args, exec) => call(async () => {
      const report = await ctx.llmwiki.lint(exec.signal)
      return {
        diagnostics: report.diagnostics.map(diagnostic => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          path: diagnostic.path,
          line: diagnostic.line ?? null,
          message: diagnostic.message,
        })),
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        filesExamined: report.filesExamined,
      }
    }),
    isConcurrencySafe: () => true,
    ...presentation('llmwiki_lint'),
  }))
}
