import { readFileSync } from 'node:fs';
import { newAutoSellStrategy } from '../lib/auto-sell';
import { saveAutoSellProfile } from '../lib/auto-sell-profile-storage';
import type { AutoSellProfileTerms } from '../lib/auto-sell-profile';
import type {
  AutoSellRun,
  AutoSellRunAttemptInput,
} from '../lib/auto-sell-run';

export const autoSellRunFixtureWallet = '11111111111111111111111111111111';
export const autoSellRunFixtureMint =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const autoSellRunFixtureArchived =
  'SysvarRent111111111111111111111111111111111';
export async function initializeAutoSellRunStorageFixture(db: D1Database) {
  for (const file of [
    '0011_huge_donald_blake.sql',
    '0024_imported_token_projects.sql',
    '0041_imported_swap_preparations.sql',
    '0149_auto_sell_profiles.sql',
  ])
    for (const sql of readFileSync('drizzle/' + file, 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  await db
    .prepare(
      readFileSync('drizzle/0047_shared_swap_reservations.sql', 'utf8').split(
        '--> statement-breakpoint',
      )[0],
    )
    .run();
  for (const sql of readFileSync('drizzle/0153_auto_sell_runs.sql', 'utf8')
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
}
export function autoSellRunFixtureTerms(
  projectId: string,
): AutoSellProfileTerms {
  const base = {
    ...newAutoSellStrategy(0),
    endMaxSupplyPercent: '',
    endDurationSeconds: 0,
    minSupplyPercentPerSell: '',
    amountUnit: 'tokens' as const,
  };
  return {
    name: 'Owned continuity journal',
    projectId,
    projectRevision: 1,
    token: {
      chain: 'Solana',
      mint: autoSellRunFixtureMint,
      decimals: 0,
      totalSupplyRaw: '18446744073709551615',
    },
    wallets: [{ address: autoSellRunFixtureWallet, revision: 1 }],
    configuration: {
      strategies: [
        { ...base, id: 'counter', mode: 'counter', replicationPercent: '100' },
        {
          ...base,
          id: 'dca',
          mode: 'dca',
          dcaAmount: '10',
          dcaIntervalSeconds: 10,
        },
        {
          ...base,
          id: 'limit',
          mode: 'limit',
          limitOrders: [
            { id: 'first', amount: '3', marketCapUsd: '1000' },
            { id: 'second', amount: '4', marketCapUsd: '2000' },
          ],
        },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 0,
        endMaxSupplyPercent: '',
        maxSlippageBps: 50,
      },
    },
  };
}
export async function setupAutoSellRunStorageFixture(
  db: D1Database,
  options: {
    owner?: string;
    terms?: (terms: AutoSellProfileTerms) => AutoSellProfileTerms;
  } = {},
) {
  const owner = options.owner ?? 'auto-sell-owner-' + crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    profileSaveId = crypto.randomUUID();
  const base = autoSellRunFixtureTerms(projectId),
    terms = options.terms ? options.terms(base) : base;
  const sourceDocument = JSON.stringify({
    token: {
      chain: 'Solana',
      address: terms.token.mint,
      decimals: terms.token.decimals,
      totalSupplyRaw: terms.token.totalSupplyRaw,
    },
  });
  const stamp = new Date().toISOString();
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      terms.token.mint,
      sourceDocument,
      1,
      0,
      'source',
      stamp,
    )
    .run();
  for (const [address, archived] of [
    [autoSellRunFixtureWallet, 0],
    [autoSellRunFixtureArchived, 1],
  ] as const)
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(
        owner,
        'Solana',
        address,
        'folder',
        'Observed wallet',
        'Holder',
        archived,
        1,
        stamp,
      )
      .run();
  const profile = await saveAutoSellProfile(
    db,
    owner,
    {
      id: profileSaveId,
      profileId: crypto.randomUUID(),
      expectedVersion: 0,
      terms,
    },
    new AbortController().signal,
  );
  return {
    owner,
    projectId,
    profileSaveId,
    profileSha256: profile.sha256,
    profile,
    sourceDocument,
    wallet: autoSellRunFixtureWallet,
    mint: terms.token.mint,
    createInput: {
      id: crypto.randomUUID(),
      projectId,
      profileSaveId,
      profileSha256: profile.sha256,
      consent: 'record-auto-sell-run-v1' as const,
    },
  };
}
export function autoSellRunAttemptFixture(
  run: AutoSellRun,
  options: Partial<AutoSellRunAttemptInput> = {},
): AutoSellRunAttemptInput {
  return {
    id: crypto.randomUUID(),
    runId: run.id,
    expectedSequence: 0,
    expectedHeadSha256: run.sha256,
    strategyId: 'counter',
    wallet: autoSellRunFixtureWallet,
    walletRevision: 1,
    inputRaw: '10',
    occurrence: {
      kind: 'counter',
      sourceIds: ['outside-event'],
      bufferedRaw: '10',
    },
    consent: 'reserve-auto-sell-attempt-v1',
    ...options,
  };
}
