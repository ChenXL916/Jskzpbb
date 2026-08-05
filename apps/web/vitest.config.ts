import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: [
      'app/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
      'lib/**/*.test.{ts,tsx}',
      'test/**/*.test.{ts,tsx}'
    ],
    exclude: ['node_modules/**', 'node_modules_*/**', '.next/**']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname)
    }
  }
});
