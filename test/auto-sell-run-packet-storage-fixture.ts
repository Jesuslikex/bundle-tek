import { readFileSync } from 'node:fs';
import { nativeWarmupFixture } from './warmup-native-fixture';
import { initializeAutoSellRunStorageFixture } from './auto-sell-run-storage-fixture';
import { newAutoSellStrategy } from '../lib/auto-sell';
import { saveAutoSellProfile } from '../lib/auto-sell-profile-storage';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
} from '../lib/auto-sell-run-storage';
import {
  unsignedPreparationSummary,
  type SwapPreparationSummary,
} from '../lib/imported-swap-preparation-history';

export async function initializeAutoSellRunPacketStorageFixture(
  db: D1Database,
) {
  await initializeAutoSellRunStorageFixture(db);
  for (const sql of readFileSync(
    'drizzle/0154_auto_sell_run_packets.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
}
/** Synthetic native unsigned packet and actual immutable journal records.
 * Provider requests, signatures, submission and live wallet state are absent. */
export async function setupAutoSellRunPacketStorageFixture(
  db: D1Database,
  options: { start?: boolean; owner?: string } = {},
) {
  const native = await nativeWarmupFixture({
    side: 'Sell',
    existing: true,
    v2: true,
  });
  // This is original synthetic quote metadata, fixed before retention. The
  // historical reader must return this exact expiry, never renew it.
  native.order.expiresAt = new Date(Date.now() + 120000).toISOString();
  const owner = options.owner ?? 'packet-owner-' + crypto.randomUUID(),
    projectId = crypto.randomUUID();
  const token = {
    chain: 'Solana' as const,
    address: native.mint,
    decimals: 6,
    totalSupplyRaw: '1000000000',
  };
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      native.mint,
      JSON.stringify({ token }),
      1,
      0,
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(
      owner,
      'Solana',
      native.wallet,
      'folder',
      'Synthetic packet wallet',
      'Holder',
      0,
      1,
      new Date().toISOString(),
    )
    .run();
  const profile = await saveAutoSellProfile(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
      expectedVersion: 0,
      terms: {
        name: 'Original unsigned packet retention',
        projectId,
        projectRevision: 1,
        token: {
          chain: 'Solana',
          mint: native.mint,
          decimals: 6,
          totalSupplyRaw: token.totalSupplyRaw,
        },
        wallets: [{ address: native.wallet, revision: 1 }],
        configuration: {
          strategies: [
            {
              ...newAutoSellStrategy(0),
              id: 'counter',
              mode: 'counter',
              replicationPercent: '100',
              endMaxSupplyPercent: '',
              endDurationSeconds: 0,
              minSupplyPercentPerSell: '',
            },
          ],
          session: {
            startDelaySeconds: 0,
            endDurationSeconds: 3600,
            endMaxSupplyPercent: '',
            maxSlippageBps: 50,
          },
        },
      },
    },
    new AbortController().signal,
  );
  const run = await createOwnedAutoSellRun(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      projectId,
      profileSaveId: profile.id,
      profileSha256: profile.sha256,
      consent: 'record-auto-sell-run-v1',
    },
    new AbortController().signal,
  );
  const attempt = await reserveOwnedAutoSellAttempt(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      runId: run.id,
      expectedSequence: 0,
      expectedHeadSha256: run.sha256,
      strategyId: 'counter',
      wallet: native.wallet,
      walletRevision: 1,
      inputRaw: native.order.inAmount,
      occurrence: {
        kind: 'counter',
        sourceIds: ['outside-fixture-event'],
        bufferedRaw: native.order.inAmount,
      },
      consent: 'reserve-auto-sell-attempt-v1',
    },
    new AbortController().signal,
  );
  const guard =
    options.start === false
      ? null
      : await startOwnedAutoSellPreparation(
          db,
          owner,
          run.id,
          attempt.id,
          new AbortController().signal,
        );
  const summary: SwapPreparationSummary = {
    ...unsignedPreparationSummary(native.order, native.simulation),
    balance: {
      source: 'fixture.invalid',
      observedAt: new Date().toISOString(),
      requestedRaw: native.order.inAmount,
      amountCovered: true,
      nativeSlot: 100,
    },
  };
  return {
    owner,
    projectId,
    profileSaveId: profile.id,
    profileSha256: profile.sha256,
    profile,
    run,
    attempt,
    guard,
    summary,
    summaryText: JSON.stringify(summary),
    transaction: native.order.preparation.transaction,
    context: {
      projectId,
      projectRevision: 1,
      wallet: native.wallet,
      walletRevision: 1,
    },
    native,
  };
}
