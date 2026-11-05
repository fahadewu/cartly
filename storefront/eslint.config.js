import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

// Lint for the Vue 3 app: ESLint's recommended rules plus eslint-plugin-vue's. `npm run lint` in CI.
export default [
  { ignores: ['dist/**', 'node_modules/**', '**/._*'] },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{js,vue}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.es2021 } },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn', // only agent/format.js output, which escapes first
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { files: ['vite.config.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
]
