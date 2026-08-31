import type { Context } from '@deepseek-ai/cordis'
export const LLMWIKI_PROMPT_SECTION = 'tool:llmwiki'
export const LLMWIKI_PROMPT_ORDER = 116


export const LLMWIKI_SYSTEM_PROMPT = `Use the llmwiki as durable, evidence-backed memory:
- Call llmwiki_status before relying on the wiki.
- Use llmwiki_list_sources and llmwiki_list_pages to recover or inventory durable records when exact IDs are not known.
- Search first, then read only the relevant pages and immutable source records.
- Treat wiki pages as synthesized notes; source records are the preserved evidence.
- Cite real source IDs in every page write. Never invent a source ID.
- Use llmwiki_upsert_page only when new evidence changes durable knowledge.
- llmwiki_lint is read-only. Do not claim that it repaired anything.`

export function registerLlmWikiPrompt(ctx: Context): void {
  ctx.systemPrompt.section({
    name: LLMWIKI_PROMPT_SECTION,
    order: LLMWIKI_PROMPT_ORDER,
    text: LLMWIKI_SYSTEM_PROMPT,
  })
}
