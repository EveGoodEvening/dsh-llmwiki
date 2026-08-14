import { defineConfig } from 'tsdown'

const external = [
  /^@deepseek-ai\/cordis(?:\/|$)/,
  /^@deepseek-ai\/dsh-(?:commands|session|system-prompt|tools)(?:\/|$)/,
  /^@deepseek-ai\/schemastery(?:\/|$)/,
]

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  external,
  dts: false,
  sourcemap: true,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
})
