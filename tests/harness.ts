import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import 'node-addon-require-builtin'
import type { Config } from '../src/config.ts'
import * as LlmWikiPlugin from '../src/index.ts'
import { LlmWikiService } from '../src/service.ts'

export interface ServiceHarness {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly temporaryDirectory: string
  readonly root: string
  readonly service: LlmWikiService
  dispose(): Promise<void>
}

export interface RuntimeHarness {
  readonly ctx: Context
  readonly temporaryDirectory: string
  readonly root: string
  readonly fibers: readonly Fiber[]
  dispose(): Promise<void>
}

export interface CordisHarness {
  readonly ctx: Context
  readonly loader: Context['loader']
  readonly temporaryDirectory: string
  readonly root: string
  readonly fibers: readonly Fiber[]
  dispose(): Promise<void>
}

async function disposeFiber(fiber: Fiber | undefined): Promise<void> {
  if (fiber) await Promise.resolve(fiber.dispose())
}

export async function createServiceHarness(config: Config = {}): Promise<ServiceHarness> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-'))
  const configuredRoot = config.root ?? join(temporaryDirectory, 'wiki')
  const root = isAbsolute(configuredRoot) ? configuredRoot : resolve(process.cwd(), configuredRoot)
  const ctx = new Context()
  let fiber: Fiber | undefined
  try {
    fiber = ctx.plugin(LlmWikiService, { ...config, root: configuredRoot })
    await fiber.await()
    let active = true
    return {
      ctx,
      fiber,
      temporaryDirectory,
      root,
      service: ctx.llmwiki,
      async dispose() {
        if (!active) return
        active = false
        try {
          await disposeFiber(fiber)
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true })
        }
      },
    }
  } catch (cause) {
    try {
      await disposeFiber(fiber)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
    throw cause
  }
}
export async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-runtime-'))
  const ctx = new Context()
  const fibers: Fiber[] = []
  let active = true
  return {
    ctx,
    temporaryDirectory,
    root: join(temporaryDirectory, '.llmwiki'),
    fibers,
    async dispose() {
      if (!active) return
      active = false
      try {
        await Promise.allSettled([...fibers].reverse().map(disposeFiber))
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    },
  }
}

export async function createCordisHarness(options: { root?: string; loaderBaseUrl?: string } = {}): Promise<CordisHarness> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-profile-'))
  const root = options.root ?? join(temporaryDirectory, '.llmwiki')
  const ctx = new Context()
  const fibers: Fiber[] = []
  try {
    const loaderFiber = ctx.plugin(Loader, { baseUrl: options.loaderBaseUrl ?? pathToFileURL(join(process.cwd(), 'package.json')).href })
    fibers.push(loaderFiber)
    await loaderFiber.await()
    let active = true
    return {
      ctx,
      loader: ctx.loader,
      temporaryDirectory,
      root,
      fibers,
      async dispose() {
        if (!active) return
        active = false
        try {
          await Promise.allSettled([...fibers].reverse().map(disposeFiber))
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true })
        }
      },
    }
  } catch (cause) {
    await Promise.allSettled([...fibers].reverse().map(disposeFiber))
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw cause
  }
}

export async function mountRuntimeServices(harness: RuntimeHarness): Promise<void> {
  const fibers = harness.fibers as Fiber[]
  for (const plugin of [ToolRuntime, CommandRuntime, SystemPrompt]) {
    const fiber = harness.ctx.plugin(plugin as never, plugin === ToolRuntime ? { mode: 'native' } : {})
    fibers.push(fiber)
    await fiber.await()
  }
}

export async function mountSourcePlugin(harness: RuntimeHarness, config: Config = {}): Promise<Fiber> {
  const fiber = harness.ctx.plugin(LlmWikiPlugin, { ...config, root: config.root ?? harness.root })
  ;(harness.fibers as Fiber[]).push(fiber)
  await fiber.await()
  return fiber
}
