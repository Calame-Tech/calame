import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        // Ratchet floor — current real coverage is ~33% (web UI components and
        // scripts are largely untested). This guards against regressions; raise
        // it as tests are added, with 70% as the standing target.
        lines: 30,
      },
    },
  },
});
