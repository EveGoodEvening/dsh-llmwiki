import { defineConfig } from 'vitest/config'

import { deterministicTestEnvironment } from './vitest.config.ts'

export default defineConfig({
  test: {
    ...deterministicTestEnvironment,
    // Package probes rebuild lib/ and temporarily hide shared checkout paths.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ['tests/**/*.e2e.spec.ts'],
    exclude: ['lib/**', 'coverage/**', 'node_modules/**'],
  },
})
