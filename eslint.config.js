import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

const typeScriptFiles = [
  'src/**/*.ts',
  'tests/**/*.ts',
  'scripts/**/*.ts',
  '*.ts',
]

export default [
  {
    ignores: [
      'node_modules/**',
      'lib/**',
      'coverage/**',
      '.cache/**',
      '.eslintcache',
      '*.tsbuildinfo',
      '.llmwiki/**',
      '**/.llmwiki/.index/**',
      '**/.index/**',
      'examples/**/.llmwiki/**',
      'examples/**/demo-wiki/**',
      '.tmp/**',
      'tmp/**',
      '.tmp-*/**',
      '**/.tmp-*/**',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: typeScriptFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,
      ...tseslint.configs['stylistic-type-checked'].rules,
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
]
