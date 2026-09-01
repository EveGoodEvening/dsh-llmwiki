import { defineConfig } from 'vitest/config'
import { deterministicTestEnvironment } from './vitest.config.ts'

export default defineConfig({
  test: {
    ...deterministicTestEnvironment,
    include: ['tests/agent-smoke.spec.ts'],
    exclude: ['lib/**', 'coverage/**', 'node_modules/**'],
  },
})
