import type { Context } from '@deepseek-ai/cordis'
export const LLMWIKI_PROMPT_SECTION = 'tool:llmwiki'
export const LLMWIKI_PROMPT_ORDER = 116


export const LLMWIKI_SYSTEM_PROMPT = `Use llmwiki as local source-linked wiki storage and retrieval. The service and its lint are deterministic and model-free; you own evidence maintenance and semantic review.
Evidence maintenance:
1. Call llmwiki_status before maintenance. If schemaText is non-null, read the human-owned schema. The plugin creates schema.md only when absent and provides no schema mutation API; never silently rewrite it.
2. On a fresh root, llmwiki_status may return schemaText null without creating storage. Supplying material alone is not authorization to preserve it. Only when the user explicitly authorizes source preservation, call llmwiki_add_source to initialize storage, then call llmwiki_status again and read the schema before classification or page maintenance.
3. Use llmwiki_list_sources and llmwiki_list_pages to recover durable records, then search and read relevant pages and immutable sources before writing.
4. Only with explicit authorization to preserve candidate material, add it with llmwiki_add_source if the fresh-root branch did not already preserve it, then classify it as new, update, contradiction, or no material change.
5. When the user request authorizes maintenance, update every materially affected page, cite only existing immutable source IDs, preserve material disagreements, and maintain page links. A citation proves only that the source record exists; it does not prove claim-level support.
6. Run llmwiki_lint after writes. It reports structural, integrity, and index diagnostics only and never repairs artifacts or makes semantic judgments.
Semantic review (separate from structural lint):
1. After structural lint, list pages and sources; select and state the review scope.
2. Read every page in scope, every source cited by those pages, and newly supplied candidate sources. Compare dated and qualified claims.
3. Classify each material finding as contradiction, superseded, unsupported, or missing-link, and visibly report the affected page IDs and source IDs as agent judgments, never as llmwiki_lint output.
4. Only when the user request authorizes maintenance, update affected pages while preserving both sides of a disagreement or recording a clearly dated supersession, then maintain links and rerun structural lint.`

export function registerLlmWikiPrompt(ctx: Context): void {
  ctx.systemPrompt.section({
    name: LLMWIKI_PROMPT_SECTION,
    order: LLMWIKI_PROMPT_ORDER,
    text: LLMWIKI_SYSTEM_PROMPT,
  })
}
