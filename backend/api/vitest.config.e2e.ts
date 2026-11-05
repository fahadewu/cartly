import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.e2e.ts'],
    // The suites share one database and Redis, so run them one after another.
    fileParallelism: false,
    // macOS writes ._* metadata files on external drives
    exclude: ['**/node_modules/**', '**/._*'],
  },
});
