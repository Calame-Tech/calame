import { defineWorkspace } from 'vitest/config';

// Each package/EE module is its own vitest project so the root coverage run
// (`vitest run --coverage`) honours per-package settings — notably
// `packages/web` which needs the jsdom environment + jest-dom setup. Without
// this, the root config's default node environment makes web component tests
// fail with "document is not defined".
export default defineWorkspace(['packages/*', 'ee/rag-*', 'ee/sso']);
