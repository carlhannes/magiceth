import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Maintenance scripts are plain JavaScript, so TypeScript is not there to vouch for the Node
    // globals the way it does for everything under src/. Declared here rather than pulling in a
    // dependency for three names.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', fetch: 'readonly', process: 'readonly' }
    }
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
