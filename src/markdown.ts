import { LlmWikiError } from './errors.ts'
import { sourceId } from './ids.ts'
import type { SourceId } from './ids.ts'
import type { PageMetadata } from './types.ts'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const UTF8_ENCODER = new TextEncoder()
const FRONTMATTER_DELIMITER = '---'
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/u
const SOURCE_ITEM_LINE = /^  - (.+)$/u
const ATX_HEADING = /^(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/u
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u

export interface ParsedPageMarkdown {
  readonly metadata: PageMetadata
  readonly body: string
  readonly bodyStartLine: number
}

export interface MarkdownSection {
  readonly headingTrail: readonly string[]
  readonly startLine: number
  readonly text: string
}

function invalidPage(message: string, cause?: unknown): LlmWikiError {
  return new LlmWikiError('INVALID_PAGE', message, cause === undefined ? undefined : { cause })
}

export function encodeUtf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text)
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw invalidPage('Wiki content is not valid UTF-8.', cause)
  }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function parseQuotedString(value: string, field: 'title' | 'summary'): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw invalidPage(`Frontmatter ${field} must be a double-quoted string.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw invalidPage(`Frontmatter ${field} contains an invalid quoted string.`, cause)
  }
  if (
    typeof parsed !== 'string'
    || parsed.includes('\n')
    || parsed.includes('\r')
    || parsed.includes('\u2028')
    || parsed.includes('\u2029')
  ) {
    throw invalidPage(`Frontmatter ${field} must be a single-line string.`)
  }
  if (parsed.trim().length === 0) {
    throw invalidPage(`Frontmatter ${field} must not be empty.`)
  }
  return parsed
}

function parseSourceItem(value: string): SourceId {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw invalidPage('Frontmatter source IDs must be double-quoted strings.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw invalidPage('Frontmatter contains an invalid quoted source ID.', cause)
  }
  if (typeof parsed !== 'string') throw invalidPage('Frontmatter source IDs must be strings.')
  try {
    return sourceId(parsed)
  } catch (cause) {
    throw invalidPage('Frontmatter contains an invalid source ID.', cause)
  }
}

function parseFrontmatter(lines: readonly string[]): PageMetadata {
  const values: Partial<Record<'title' | 'summary' | 'sources', string | readonly SourceId[]>> = {}
  const seen = new Set<string>()

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) {
      throw invalidPage('Frontmatter must not contain blank lines.')
    }
    const match = KEY_LINE.exec(line)
    if (match === null) throw invalidPage('Frontmatter contains malformed YAML.')
    const key = match[1]
    const rawValue = match[2] ?? ''
    if (key !== 'title' && key !== 'summary' && key !== 'sources') {
      throw invalidPage(`Frontmatter contains unknown key ${JSON.stringify(key)}.`)
    }
    if (seen.has(key)) throw invalidPage(`Frontmatter contains duplicate key ${JSON.stringify(key)}.`)
    seen.add(key)

    if (key === 'sources') {
      if (rawValue.length !== 0) throw invalidPage('Frontmatter sources must use a block list.')
      const sources: SourceId[] = []
      index += 1
      while (index < lines.length) {
        const sourceLine = lines[index]
        if (sourceLine === undefined) break
        const item = SOURCE_ITEM_LINE.exec(sourceLine)
        if (item === null) break
        sources.push(parseSourceItem(item[1] ?? ''))
        index += 1
      }
      if (sources.length === 0) throw invalidPage('Frontmatter sources must not be empty.')
      for (let sourceIndex = 1; sourceIndex < sources.length; sourceIndex += 1) {
        const previous = sources[sourceIndex - 1]
        const current = sources[sourceIndex]
        if (previous === undefined || current === undefined) {
          throw invalidPage('Frontmatter source list is malformed.')
        }
        if (previous === current) throw invalidPage('Frontmatter source IDs must be unique.')
        if (previous > current) throw invalidPage('Frontmatter source IDs must be sorted.')
      }
      values.sources = sources
      continue
    }

    if (!rawValue.startsWith(' ')) throw invalidPage(`Frontmatter ${key} must have one value separator.`)
    values[key] = parseQuotedString(rawValue.slice(1), key)
    index += 1
  }

  if (values.title === undefined || values.summary === undefined || values.sources === undefined) {
    throw invalidPage('Frontmatter must contain title, summary, and sources.')
  }
  return {
    title: values.title as string,
    summary: values.summary as string,
    sources: values.sources as readonly SourceId[],
  }
}

export function parsePageMarkdown(markdown: string): ParsedPageMarkdown {
  const normalized = normalizeLineEndings(markdown)
  const lines = normalized.split('\n')
  if (lines[0] !== FRONTMATTER_DELIMITER) throw invalidPage('Page must begin with YAML frontmatter.')
  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1)
  if (closingIndex < 0) throw invalidPage('Page frontmatter is not closed.')
  if (lines[closingIndex + 1] !== '') throw invalidPage('Page must contain one blank line after frontmatter.')

  const metadata = parseFrontmatter(lines.slice(1, closingIndex))
  const bodyLines = lines.slice(closingIndex + 2)
  const body = bodyLines.join('\n').replace(/\n+$/u, '')
  if (body.trim().length === 0) throw invalidPage('Page Markdown body must not be empty.')
  return { metadata, body: `${body}\n`, bodyStartLine: closingIndex + 3 }
}

export function renderPageMarkdown(metadata: PageMetadata, body: string): string {
  const title = parseQuotedString(JSON.stringify(metadata.title), 'title')
  const summary = parseQuotedString(JSON.stringify(metadata.summary), 'summary')
  if (metadata.sources.length === 0) throw invalidPage('Frontmatter sources must not be empty.')

  const sources = metadata.sources.map((value) => {
    try {
      return sourceId(value)
    } catch (cause) {
      throw invalidPage('Frontmatter contains an invalid source ID.', cause)
    }
  }).sort()
  if (new Set(sources).size !== sources.length) throw invalidPage('Frontmatter source IDs must be unique.')

  const normalizedBody = normalizeLineEndings(body).replace(/\n+$/u, '')
  if (normalizedBody.trim().length === 0) throw invalidPage('Page Markdown body must not be empty.')
  const sourceLines = sources.map((value) => `  - ${JSON.stringify(value)}`).join('\n')
  return `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\nsources:\n${sourceLines}\n---\n\n${normalizedBody}\n`
}

export function splitMarkdownSections(body: string, firstLine = 1): readonly MarkdownSection[] {
  if (!Number.isSafeInteger(firstLine) || firstLine < 1) throw invalidPage('Section start line must be a positive integer.')
  const lines = normalizeLineEndings(body).replace(/\n+$/u, '').split('\n')
  const sections: MarkdownSection[] = []
  const headingTrail: { readonly level: number; readonly title: string }[] = []
  let sectionStart = firstLine
  let sectionLines: string[] = []
  let fenceCharacter: '`' | '~' | undefined
  let fenceLength = 0

  const flush = (): void => {
    const text = sectionLines.join('\n').trimEnd()
    if (text.trim().length > 0 || headingTrail.length > 0) {
      sections.push({ headingTrail: headingTrail.map(({ title }) => title), startLine: sectionStart, text })
    }
    sectionLines = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (fenceCharacter !== undefined) {
      sectionLines.push(line)
      const closePattern = new RegExp(`^[ \\t]{0,3}${fenceCharacter === '`' ? '`' : '~'}{${fenceLength},}[ \\t]*$`, 'u')
      if (closePattern.test(line)) fenceCharacter = undefined
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? ''
      fenceCharacter = marker[0] as '`' | '~'
      fenceLength = marker.length
      sectionLines.push(line)
      continue
    }
    const heading = ATX_HEADING.exec(line)
    if (heading === null) {
      sectionLines.push(line)
      continue
    }

    flush()
    const level = (heading[1] ?? '').length
    const rawHeading = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim()
    for (let ancestor = headingTrail.at(-1); ancestor !== undefined && ancestor.level >= level; ancestor = headingTrail.at(-1)) {
      headingTrail.pop()
    }
    headingTrail.push({ level, title: rawHeading })
    sectionStart = firstLine + index
  }
  flush()
  return sections
}
