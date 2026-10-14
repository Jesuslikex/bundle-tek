import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@/lib/server-env': path.join(root, 'test/cloudflare-workers.ts'),
      '@': root,
      'cloudflare:workers': path.join(root, 'test/cloudflare-workers.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: [path.join(root, 'test/vercel-compat.ts')],
    // Miniflare-backed route suites start local D1 and run many sequential
    // requests; under full-suite load they exceed Vitest's 5s/10s defaults.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
