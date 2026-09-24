import {defineConfig} from 'vitest/config'

export default defineConfig({
  esbuild: {jsx: 'automatic'},
  test: {
    // Keep isolated reference checkouts and generated projects outside this repository's suite.
    include: ['test/**/*.test.ts'],
    globals: true,
    testTimeout: 10_000,
  },
})
