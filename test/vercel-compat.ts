import { vi } from 'vitest';
// Historical route suites own disposable Miniflare databases. Keep that fixture
// injection explicit; adapter and auth integration tests still use real libSQL.
vi.mock('@/db/turso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/turso')>();
  const { env } = await import('cloudflare:workers');
  return { ...actual, getTursoDatabase: () => env.DB };
});
