import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,

  // Server-side plugin entry — CommonJS, runs in the PeerTube Node process.
  {
    files: ['main.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },

  // Client embed script — ES module, runs in the browser inside the embed iframe.
  {
    files: ['client/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },

  // Shared rule tweaks. The embed script uses intentional empty `catch (_) {}`
  // guards and `_`-prefixed placeholder args; allow those instead of rewriting code.
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  }
]
