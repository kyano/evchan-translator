import js from '@eslint/js';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser / Chrome extension APIs
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        NodeFilter: 'readonly',
        Node: 'readonly',
        MutationObserver: 'readonly',
        DOMParser: 'readonly',
        // Built-in types
        Map: 'readonly',
        Set: 'readonly',
        WeakMap: 'readonly',
        Promise: 'readonly',
        Error: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        Symbol: 'readonly',
        RegExp: 'readonly',
        Date: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        // Stream APIs
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        ReadableStream: 'readonly',
        // Compile-time constants (defined by esbuild/vitest)
        __EVCHAN_DEBUG__: 'writable',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      'prettier/prettier': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', 'EVChan Translator', '*.min.js', 'eslint.config.js'],
  },
  // Test files: add vitest globals and Node.js `global` object
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        vitest: 'readonly',
        global: 'writable',
        HTMLElement: 'readonly',
        Event: 'readonly',
      },
    },
  },
  // Build script: Node.js environment
  {
    files: ['build.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
];
