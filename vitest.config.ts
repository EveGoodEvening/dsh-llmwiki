import { defineConfig } from 'vitest/config'

export const deterministicTestEnvironment = {
  environment: 'node',
  globals: false,
  isolate: true,
  pool: 'forks',
  env: {
    TZ: 'UTC',
    LC_ALL: 'C',
    LANG: 'C',
  },
} as const

export default defineConfig({
  test: {
    ...deterministicTestEnvironment,
    include: ['tests/**/*.spec.ts'],
    exclude: [
      'tests/**/*.e2e.spec.ts',
      'lib/**',
      'coverage/**',
      'node_modules/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
})
