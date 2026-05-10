module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
  },
  overrides: [
    {
      // Cross-license boundary: Apache packages must not statically import
      // BUSL-licensed RAG packages at runtime. Type-only imports are allowed
      // (erased at build time, no runtime coupling). Value imports must use
      // dynamic `await import()` so the runtime can degrade gracefully when
      // the EE package is absent (apache-only install).
      //
      // Today only @calame-ee/rag-* is enforced. @calame-ee/sso has legacy
      // static value imports in packages/cli/src/app.ts and packages/web that
      // predate this rule — they will be migrated in a follow-up.
      files: ['packages/**/*.ts', 'packages/**/*.tsx'],
      excludedFiles: ['packages/**/dist/**'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@calame-ee/rag-*'],
                message:
                  'Apache packages cannot statically value-import @calame-ee/rag-* (BUSL). Use a dynamic `await import(\'@calame-ee/...\')` so the host degrades gracefully when the EE package is absent. Type-only imports (`import type`) are allowed.',
                allowTypeImports: true,
              },
            ],
          },
        ],
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '*.hbs'],
};
