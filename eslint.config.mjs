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
    // A built-in plugin must have the same shape as one a user drops into Documents: Node built-ins
    // and its own folder at runtime, `import type` from shared/ for the contract, and the host it
    // is given for everything else. The build checks the bundle for the same thing.
    files: ['src/plugins/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/renderer/**', '**/preload/**', '**/shared/**'],
              allowTypeImports: true,
              message:
                'A plugin is standalone: Node built-ins and its own folder at runtime, `import type` from shared/ only.'
            },
            {
              group: ['electron', 'electron/*'],
              message: 'A plugin talks to the app through the host it is given.'
            }
          ]
        }
      ]
    }
  },
  {
    // The example plugin is what a user would write: plain CommonJS, so `module` and `exports`
    // are the globals, not ES modules.
    files: ['examples/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', exports: 'writable', require: 'readonly' }
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
