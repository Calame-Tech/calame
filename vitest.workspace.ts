import { defineWorkspace } from 'vitest/config';

// Each package/EE module is its own vitest project so the root run
// (`vitest run` / `vitest run --coverage`) honours per-package settings —
// notably `packages/web` which needs the jsdom environment + jest-dom setup,
// while the backend packages run under node. Run tests from the repo root
// (`pnpm test` / `pnpm test:coverage`) so these globs resolve correctly.
export default defineWorkspace(['packages/*', 'ee/rag-*', 'ee/sso']);
