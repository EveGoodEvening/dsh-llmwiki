import { defineConfig } from 'vitest/config'

import { deterministicTestEnvironment } from './vitest.config.ts'

export default defineConfig({
  test: {
    ...deterministicTestEnvironment,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ['tests/**/*.e2e.spec.ts'],
    exclude: ['lib/**', 'coverage/**', 'node_modules/**'],
  },
})
