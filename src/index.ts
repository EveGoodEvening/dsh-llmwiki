import type { Context } from '@deepseek-ai/cordis'
import { registerLlmWikiCommand } from './command.ts'
import { resolveConfig } from './config.ts'
import type { Config as LlmWikiConfig } from './config.ts'
import { registerLlmWikiPrompt } from './prompt.ts'
import { LlmWikiService } from './service.ts'
import { registerLlmWikiTools } from './tools.ts'

export { Config } from './config.ts'
export type { Config as LlmWikiConfig, ResolvedConfig } from './config.ts'
export {
  LLMWIKI_ERROR_CODES,
  LlmWikiError,
  isLlmWikiError,
} from './errors.ts'
export type {
  LlmWikiErrorCode,
  SerializedLlmWikiError,
} from './errors.ts'
export {
  isPageId,
  isSourceId,
  pageId,
  sourceId,
} from './ids.ts'
export type { PageId, SourceId } from './ids.ts'
export { LlmWikiService } from './service.ts'
export type * from './types.ts'

export const name = 'llmwiki'
export const inject = ['tools', 'commands', 'systemPrompt']

export function apply(ctx: Context, config: LlmWikiConfig = {}): void {
  const resolvedConfig = resolveConfig(config)
  new LlmWikiService(ctx, resolvedConfig)
  registerLlmWikiPrompt(ctx)
  registerLlmWikiTools(ctx)
  registerLlmWikiCommand(ctx, resolvedConfig)
}
