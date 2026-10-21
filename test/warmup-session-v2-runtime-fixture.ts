import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { warmupV2AttemptProviderFixture } from './warmup-session-v2-attempt-provider-fixture';
import { warmupRuntimeOrderFixture } from './warmup-runtime-order-fixture';
import { createWalletWarmupV2RuntimeProvider } from '../lib/wallet-warmup-session-v2-runtime-provider';
import { installWarmupRuntimeWalletParents } from './warmup-runtime-wallet-busy-fixture';
export async function installWarmupRuntime(db: D1Database) {
  await installWarmupRuntimeWalletParents(db);
  for (const sql of readFileSync(
    'drizzle/0135_wallet_warmup_session_v2_runtime_observations.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(sql).run();
}
export async function warmupV2RuntimeFixture() {
  const f = await warmupV2AttemptProviderFixture();
  try {
    await installWarmupRuntime(f.db);
    const raw = await warmupRuntimeOrderFixture({ mint: f.packets.mint });
    if (raw.wallet !== f.packets.wallet)
      throw Error('Synthetic wallet mismatch');
    const factory = vi.fn(
      (
        db: D1Database,
        owner: string,
        key: string | undefined,
        lease: Parameters<typeof createWalletWarmupV2RuntimeProvider>[3],
      ) =>
        createWalletWarmupV2RuntimeProvider(db, owner, key, lease, {
          runtime: raw.dependencies,
        }),
    );
    return {
      ...f,
      raw,
      factory,
      selection: () => {
        const { previewRequested: _approved, ...input } = f.input();
        return input;
      },
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
