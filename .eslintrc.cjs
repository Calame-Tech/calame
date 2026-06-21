module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
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
      // Cross-license boundary: Apache packages must not statically value-import
      // BUSL-licensed EE packages at runtime. Type-only imports are allowed
      // (erased at build time, no runtime coupling). Value imports must use
      // dynamic `await import()` so the runtime can degrade gracefully when
      // the EE package is absent (apache-only install).
      //
      // Coverage: all @calame-ee/* packages. The rule used to cover only
      // @calame-ee/rag-* because @calame-ee/sso had legacy static imports;
      // those have since been migrated (sso-runtime.ts mirrors rag-runtime.ts),
      // so the boundary is now enforced uniformly across the whole EE org.
      //
      // Test files (`__tests__/**`, `*.test.ts(x)`) are intentionally excluded:
      // tests directly import EE modules to mock and exercise them — they are
      // never shipped as part of the published Apache binary, so the boundary
      // constraint does not apply to them.
      files: ['packages/**/*.ts', 'packages/**/*.tsx'],
      excludedFiles: [
        'packages/**/dist/**',
        'packages/**/__tests__/**',
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
      ],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@calame-ee/*'],
                message:
                  'Apache packages cannot statically value-import @calame-ee/* (BUSL). Use a dynamic `await import(\'@calame-ee/...\')` (or React.lazy for components) so the host degrades gracefully when the EE package is absent. Type-only imports (`import type`) are allowed.',
                allowTypeImports: true,
              },
            ],
          },
        ],
      },
    },
    {
      // Root tooling scripts and CommonJS config files are plain Node JS
      // (require / module.exports), not TypeScript. Relax the TS-only import
      // rules so `scripts/**/*.js` and root *.cjs/*.js configs lint cleanly.
      files: ['scripts/**/*.js', '*.js', '*.cjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '*.hbs'],
};
