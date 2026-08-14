import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { ResolvedConfig } from './config.ts'
import { isLlmWikiError } from './errors.ts'
import type { IndexStatus, LintDiagnostic, LintReport, ReindexReceipt, WikiStatus } from './types.ts'

const USAGE = 'Usage: /wiki [status|lint|reindex]'

type WikiSubcommand = 'status' | 'lint' | 'reindex'

function parseSubcommand(rawInput: string): WikiSubcommand | undefined {
  const input = rawInput.trim()
  if (input === '') return 'status'
  if (input === 'status' || input === 'lint' || input === 'reindex') return input
  return undefined
}

function formatIndex(index: IndexStatus): string {
  if (!index.present) return 'missing'
  const version = index.formatVersion === null ? 'unknown' : String(index.formatVersion)
  return `${index.fresh ? 'fresh' : 'stale'} (version ${version}, ${index.sectionCount} sections)`
}

function formatStatus(status: WikiStatus): string {
  return [
    'Wiki status',
    `Initialized: ${status.initialized ? 'yes' : 'no'}`,
    `Sources: ${status.sourceCount}`,
    `Pages: ${status.pageCount}`,
    `Index: ${formatIndex(status.index)}`,
  ].join('\n')
}

function formatDiagnostic(diagnostic: LintDiagnostic): string {
  const location = diagnostic.line === undefined ? diagnostic.path : `${diagnostic.path}:${diagnostic.line}`
  return `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${location}: ${diagnostic.message}`
}

function formatLint(report: LintReport, limit: number): string {
  const displayed = report.diagnostics.slice(0, limit)
  const omitted = report.diagnostics.length - displayed.length
  const lines = [
    `Wiki lint: ${report.errorCount} errors, ${report.warningCount} warnings across ${report.filesExamined} files.`,
    ...displayed.map(formatDiagnostic),
  ]
  if (omitted > 0) lines.push(`... ${omitted} more diagnostics omitted.`)
  return lines.join('\n')
}

function formatReindex(receipt: ReindexReceipt): string {
  return `Wiki reindexed: ${receipt.pageCount} pages, ${receipt.sectionCount} sections, index version ${receipt.formatVersion}.`
}

function domainError(error: unknown): CommandResult {
  if (!isLlmWikiError(error)) throw error
  return { kind: 'error', text: `${error.code}: ${error.message}` }
}

export function registerLlmWikiCommand(ctx: Context, config: ResolvedConfig): void {
  const service = ctx.llmwiki
  ctx.commands.register({
    name: 'wiki',
    description: 'Inspect, lint, or reindex the local wiki',
    input: { hint: '[status|lint|reindex]' },
    handler: async invocation => {
      const subcommand = parseSubcommand(invocation.rawInput)
      if (subcommand === undefined) return { kind: 'error', text: USAGE }

      try {
        if (subcommand === 'status') {
          return { kind: 'success', text: formatStatus(await service.status(invocation.signal)) }
        }
        if (subcommand === 'lint') {
          return { kind: 'success', text: formatLint(await service.lint(invocation.signal), config.commandDiagnosticLimit) }
        }
        const receipt = await service.reindex(invocation.signal)
        return { kind: 'success', text: formatReindex(receipt) }
      } catch (error) {
        return domainError(error)
      }
    },
  })
}
