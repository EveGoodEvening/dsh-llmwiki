import { defineConfig } from 'tsdown'

const neverBundle = [
  /^@deepseek-ai\/(?:cordis|dsh-[^/]+|schemastery)(?:\/|$)/,
]

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: { neverBundle },
  dts: false,
  sourcemap: true,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
})
