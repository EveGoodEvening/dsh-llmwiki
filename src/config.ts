import z from '@deepseek-ai/schemastery'

export interface Config {
  readonly root?: string
  readonly maxSourceBytes?: number
  readonly maxPageBytes?: number
  readonly maxResults?: number
  readonly maxSnippetBytes?: number
  readonly commandDiagnosticLimit?: number
}

export interface ResolvedConfig {
  readonly root: string
  readonly maxSourceBytes: number
  readonly maxPageBytes: number
  readonly maxResults: number
  readonly maxSnippetBytes: number
  readonly commandDiagnosticLimit: number
}

const configSchema: z<Config, ResolvedConfig> = z.object({
  root: z.string().min(1).default('.llmwiki'),
  maxSourceBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxPageBytes: z.number().step(1).min(1).default(512 * 1024),
  maxResults: z.number().step(1).min(1).max(100).default(20),
  maxSnippetBytes: z.number().step(1).min(64).max(16_384).default(1200),
  commandDiagnosticLimit: z.number().step(1).min(1).max(100).default(20),
})

function isConfigKey(key: PropertyKey): boolean {
  return key === 'root'
    || key === 'maxSourceBytes'
    || key === 'maxPageBytes'
    || key === 'maxResults'
    || key === 'maxSnippetBytes'
    || key === 'commandDiagnosticLimit'
}

function rejectUnknownKeys(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const unknown = Reflect.ownKeys(value).find(key => !isConfigKey(key))
  if (unknown !== undefined) throw new TypeError(`unknown config key ${String(unknown)}`)
}

type ConfigSchema = z<Config, ResolvedConfig>
type ConfigArguments = Parameters<ConfigSchema>
type ConfigConstructorArguments = ConstructorParameters<ConfigSchema>

function applyConfig(target: ConfigSchema, thisArg: unknown, argumentsList: ConfigArguments): ResolvedConfig {
  rejectUnknownKeys(argumentsList[0])
  return Reflect.apply<unknown, ConfigArguments, ResolvedConfig>(target, thisArg, argumentsList)
}

function constructConfig(target: ConfigSchema, argumentsList: ConfigConstructorArguments, newTarget: ConfigSchema): ResolvedConfig {
  rejectUnknownKeys(argumentsList[0])
  return Reflect.construct<ConfigConstructorArguments, ResolvedConfig>(target, argumentsList, newTarget)
}

export const Config: ConfigSchema = new Proxy(configSchema, {
  apply: (target, thisArg, argumentsList) => applyConfig(target, thisArg, argumentsList as ConfigArguments),
  construct: (target, argumentsList, newTarget) => constructConfig(target, argumentsList as ConfigConstructorArguments, newTarget as ConfigSchema),
})

export function resolveConfig(config: Config = {}): ResolvedConfig {
  return Object.freeze(Config(config))
}
