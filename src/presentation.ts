import type { ToolCallKind, ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

export type LlmWikiToolName =
  | 'llmwiki_status'
  | 'llmwiki_add_source'
  | 'llmwiki_read_source'
  | 'llmwiki_search'
  | 'llmwiki_read_page'
  | 'llmwiki_upsert_page'
  | 'llmwiki_lint'

const PRESENTATION: Readonly<Record<LlmWikiToolName, { readonly title: string; readonly kind: ToolCallKind }>> = Object.freeze({
  llmwiki_status: { title: 'Inspect wiki status', kind: 'read' },
  llmwiki_add_source: { title: 'Preserve wiki source', kind: 'edit' },
  llmwiki_read_source: { title: 'Read wiki source', kind: 'read' },
  llmwiki_search: { title: 'Search wiki', kind: 'search' },
  llmwiki_read_page: { title: 'Read wiki page', kind: 'read' },
  llmwiki_upsert_page: { title: 'Update wiki page', kind: 'edit' },
  llmwiki_lint: { title: 'Lint wiki', kind: 'read' },
})

function salientInput(name: LlmWikiToolName, args: Readonly<Record<string, unknown>>): string | undefined {
  switch (name) {
    case 'llmwiki_add_source': return typeof args.name === 'string' ? args.name : undefined
    case 'llmwiki_read_source': return typeof args.id === 'string' ? args.id : undefined
    case 'llmwiki_search': return typeof args.query === 'string' ? args.query : undefined
    case 'llmwiki_read_page':
    case 'llmwiki_upsert_page': return typeof args.id === 'string' ? args.id : undefined
    default: return undefined
  }
}

export function presentLlmWikiCall(name: LlmWikiToolName, args: Readonly<Record<string, unknown>>): ToolCallView {
  const presentation = PRESENTATION[name]
  return {
    card: 'generic',
    title: presentation.title,
    kind: presentation.kind,
    ...(salientInput(name, args) === undefined ? {} : { rawInput: salientInput(name, args) }),
  }
}

export function presentLlmWikiResult(name: LlmWikiToolName, _args: Readonly<Record<string, unknown>>, result: ToolResult): ToolResultView {
  const presentation = PRESENTATION[name]
  return {
    card: 'generic',
    title: result.isError ? `${presentation.title} failed` : presentation.title,
  }
}
