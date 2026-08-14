import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Config } from '../src/config.ts'
import { LlmWikiService } from '../src/service.ts'

export interface ServiceHarness {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly temporaryDirectory: string
  readonly root: string
  readonly service: LlmWikiService
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
