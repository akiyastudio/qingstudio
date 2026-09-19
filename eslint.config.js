import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const sourceFiles = ['src/**/*.{ts,tsx}']

export default [
  { ignores: ['artifacts/**', '.cache/**', '**/artifacts/**', '**/.cache/**', '**/dist/**', '.venv', 'node_modules'] },
  {
    files: ['electron/main.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-undef': 'error' },
  },
  { ...js.configs.recommended, files: sourceFiles },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: sourceFiles })),
  {
    files: sourceFiles,
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-hooks/exhaustive-deps': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
]
