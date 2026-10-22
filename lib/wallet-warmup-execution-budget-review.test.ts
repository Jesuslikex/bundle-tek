import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from './server-env';
import { warmupExecutionSourceFixture } from '../test/warmup-execution-source-fixture';
import { pairRentAccount } from '../test/pair-rent-fixture';
import { reviewWarmupExecutionBudget } from './wallet-warmup-execution-budget-review';
import { readWarmupExecutionSource } from './wallet-warmup-execution-source';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import { buildWarmupPlan } from './wallet-warmup';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const fixtures: Awaited<ReturnType<typeof warmupExecutionSourceFixture>>[] = [];
beforeEach(() => {
  env.SOLANA_INDEXER_RPC_URL = 'https://fixture.invalid/private';
});
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.sqlite.close());
  delete env.SOLANA_INDEXER_RPC_URL;
});
const wire = (b: Uint8Array) => btoa(String.fromCharCode(...b));
async function fixture(history: 'none' | 'buy' | 'sold' = 'none') {
  const f = await warmupExecutionSourceFixture(history);
  fixtures.push(f);
  const source = await readWarmupExecutionSource(
    f.db,
    f.owner,
    f.input,
    new AbortController().signal,
    f.clock,
  );
  const input = {
    ...f.input,
    rootId: crypto.randomUUID(),
    consentId: crypto.randomUUID(),
    sessionExpiresAt: new Date(
      Date.parse(source.retainedReview.document.actions.at(-1)!.scheduledAt) +
        300000,
    ).toISOString(),
    feeRentLimits: source.retainedReview.document.actions.map((a) => ({
      actionId: a.id,
      maximumLamports: '5000000',
    })),
  };
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const req = JSON.parse(options!.body as string);
    let result: unknown;
    if (req.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (req.method === 'getSlot') result = 100;
    else {
      reads++;
      const slot = 100 + reads;
      result = {
        context: { slot },
        value: req.params[0].map((a: string) => {
          if (a === 'SysvarRent111111111111111111111111111111111')
            return pairRentAccount(3480n, 2);
          if (a === 'SysvarC1ock11111111111111111111111111111111') {
            const b = new Uint8Array(40),
              v = new DataView(b.buffer);
            v.setBigUint64(0, BigInt(slot), true);
            v.setBigInt64(32, BigInt(Math.floor(f.clock() / 1000)), true);
            return {
              owner: 'Sysvar1111111111111111111111111111111111111',
              executable: false,
              data: [wire(b), 'base64'],
            };
          }
          const b = new Uint8Array(82);
          b[44] = a === SWAP_WRAPPED_SOL ? 9 : 6;
          b[45] = 1;
          return {
            owner: SWAP_TOKEN,
            executable: false,
            data: [wire(b), 'base64'],
          };
        }),
      };
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const run = (value: unknown = input, signal = new AbortController().signal) =>
    reviewWarmupExecutionBudget(f.db, f.owner, value, signal, {
      fetcher,
      now: f.clock,
    });
  return { ...f, source, input, fetcher, run };
}

it.each(['none', 'buy', 'sold'] as const)(
  'derives every current action, source and independent limit with %s history',
  async (history) => {
    const f = await fixture(history);
    const r = await f.run();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(r.terms.intent.actions.map((a) => a.id)).toEqual(
      f.source.retainedReview.document.actions.map((a) => a.id),
    );
    expect(r.terms.intent.wallets).toEqual(
      r.budget.wallets.map(
        ({ wallet, revision, maximumBuyLamports, maximumFeeRentLamports }) => ({
          wallet,
          revision,
          maximumBuyLamports,
          maximumFeeRentLamports,
        }),
      ),
    );
    expect(r.budget.wallets[0].maximumFeeRentLamports).toBe(
      String(f.input.feeRentLimits.length * 5000000),
    );
    expect(r.budget.wallets[0].historicalGrossFeeRent).toBe('not-established');
    expect(r.budget.wallets[0].maximumNewNativeDebitLamports).toBe(
      (
        BigInt(r.budget.wallets[0].maximumBuyLamports) +
        BigInt(r.budget.wallets[0].maximumFeeRentLamports)
      ).toString(),
    );
    expect(r.terms.intent.sourceSha256).toBe(f.source.sourceSnapshotSha256);
    expect(r.terms.intent.createdAt).toBe(f.kept.reviewedAt);
    expect(r.terms.review.reviewExpiresAt).toBe(f.kept.reviewExpiresAt);
    expect(r.budget.refundsAndProceedsReplenishLimits).toBe(false);
    expect(r.budget.fundingSufficiencyVerified).toBe(false);
    expect(r.budget.feeAndSetupCoverageVerified).toBe(false);
    expect(r.budget.humanApprovalVerified).toBe(false);
    expect(
      r.signingAllowed || r.executionAllowed || r.automaticExecutionAllowed,
    ).toBe(false);
    expect(await digest(canonical(r.budget))).toBe(r.budgetSha256);
    expect(await digest(canonical(r.verifierEvidence))).toBe(
      r.verifierEvidenceSha256,
    );
    expect(r.terms.verifierEvidenceSha256).toBe(r.verifierEvidenceSha256);
    expect(() => JSON.stringify(r)).not.toThrow();
    if (history === 'buy') {
      expect(r.terms.intent.savedLots).toHaveLength(1);
      const receipt = JSON.parse(f.source.sourceDocument).buys.find(
        (b: { id: string }) => b.id === r.terms.intent.savedLots[0].receiptId,
      );
      expect(r.terms.intent.savedLots[0].sourceSha256).toBe(
        await digest(canonical(receipt)),
      );
    }
  },
);

it.each([
  'omit',
  'extra',
  'reorder',
  'duplicate',
  'wrong-id',
  'zero',
  'negative',
  'leading-zero',
  'number',
  'u64-overflow',
  'unknown-field',
  'invalid-consent-format',
  'same-root',
  'same-review',
])('refuses %s before any provider call', async (kind) => {
  const f = await fixture();
  const input: Record<string, unknown> = structuredClone(f.input);
  const limits = input.feeRentLimits as Record<string, unknown>[];
  if (kind === 'omit') limits.pop();
  if (kind === 'extra') limits.push({ ...limits[0] });
  if (kind === 'reorder') limits.reverse();
  if (kind === 'duplicate') limits[1].actionId = limits[0].actionId;
  if (kind === 'wrong-id') limits[0].actionId = 'foreign';
  if (kind === 'zero') limits[0].maximumLamports = '0';
  if (kind === 'negative') limits[0].maximumLamports = '-1';
  if (kind === 'leading-zero') limits[0].maximumLamports = '01';
  if (kind === 'number') limits[0].maximumLamports = 1;
  if (kind === 'u64-overflow')
    limits[0].maximumLamports = '18446744073709551616';
  if (kind === 'unknown-field') input.verified = true;
  if (kind === 'invalid-consent-format')
    input.consentId = 'wallet-warmup-session-v2-consent';
  if (kind === 'same-root') input.consentId = input.rootId;
  if (kind === 'same-review') input.rootId = input.reviewId;
  await expect(f.run(input)).rejects.toThrow('Fresh warmup spending review');
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('refuses an overflowing combined wallet ceiling rather than truncating units', async () => {
  const f = await fixture();
  f.input.feeRentLimits[0].maximumLamports = '18446744073709551615';
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
});
it('snapshots the request and returns detached budget, verifier and intent copies', async () => {
  const f = await fixture();
  const promise = f.run();
  f.input.feeRentLimits[0].maximumLamports = '1';
  const r = await promise;
  expect(r.terms.intent.actions[0].maximumFeeRentLamports).toBe('5000000');
  r.budget.feeRentLimits[0].maximumLamports = '2';
  expect(r.terms.intent.actions[0].maximumFeeRentLamports).toBe('5000000');
  expect(r.verifierEvidence.freshBudget.feeRentLimits[0].maximumLamports).toBe(
    '5000000',
  );
  expect(await digest(canonical(r.budget))).not.toBe(r.budgetSha256);
});

it('labels limits above the old reserve as a separate proposal without historical spending or approval claims', async () => {
  const f = await fixture();
  const r = await f.run();
  expect(BigInt(r.budget.wallets[0].maximumFeeRentLamports)).toBeGreaterThan(
    BigInt(f.source.retainedReview.document.wallets[0].feeReserveLamports),
  );
  expect(r.status).toBe('Separate spending approval required');
  expect(r.budget.wallets[0].historicalGrossFeeRent).toBe('not-established');
  expect(r.budget.humanApprovalVerified).toBe(false);
  expect(r.budget.fundingSufficiencyVerified).toBe(false);
});
it('refuses changed current source after provider evidence', async () => {
  const f = await fixture();
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (f.fetcher.mock.calls.length === 4)
      f.sqlite
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
        )
        .run(f.owner);
    return response;
  });
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
});
it('refuses a failed provider without retrying or exposing its body', async () => {
  const f = await fixture();
  f.fetcher.mockResolvedValue(new Response('PRIVATE URL KEY', { status: 429 }));
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('preserves parent cancellation with zero provider calls', async () => {
  const f = await fixture();
  const c = new AbortController();
  c.abort(new Error('cancelled'));
  await expect(f.run(f.input, c.signal)).rejects.toThrow('cancelled');
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(['expired', 'wrong-hash', 'wrong-owner-source'])(
  'refuses %s source before provider reads',
  async (kind) => {
    const f = await fixture();
    if (kind === 'expired') f.advance(60000);
    if (kind === 'wrong-hash') f.input.reviewSha256 = '0'.repeat(64);
    if (kind === 'wrong-owner-source') f.input.reviewId = crypto.randomUUID();
    await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it('refuses source mutation in the final owned-source read after asset verification', async () => {
  const f = await fixture();
  const prepare = f.db.prepare.bind(f.db);
  let reads = 0;
  f.db.prepare = (sql: string) => {
    if (sql.startsWith('SELECT owner_id,id,plan_id,plan_revision')) {
      reads++;
      if (reads === 7)
        f.sqlite
          .prepare(
            'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
          )
          .run(f.owner);
    }
    return prepare(sql);
  };
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  expect(reads).toBeGreaterThanOrEqual(7);
});
it('preserves a shorter requested session deadline and refuses an unreachable one', async () => {
  const f = await fixture();
  f.input.sessionExpiresAt = new Date(
    Date.parse(f.input.sessionExpiresAt) - 60000,
  ).toISOString();
  const r = await f.run();
  expect(r.terms.intent.expiresAt).toBe(f.input.sessionExpiresAt);
  f.input.sessionExpiresAt = new Date(f.at + 1).toISOString();
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
});
it('does not write even the disposable database during a successful proposal', async () => {
  const f = await fixture();
  const changes = f.sqlite.prepare('SELECT total_changes() AS n').get()!.n;
  await f.run();
  expect(f.sqlite.prepare('SELECT total_changes() AS n').get()!.n).toBe(
    changes,
  );
});

it.each([-1, 0, 1])(
  'checks the conservative two-account setup allowance at the %s lamport boundary',
  async (offset) => {
    const f = await fixture();
    // Existing real Rent decoder: (128+165)*3480*2 per classic account.
    const rent = 2n * 293n * 3480n * 2n;
    f.input.feeRentLimits.forEach((limit) => {
      limit.maximumLamports = (rent + BigInt(offset)).toString();
    });
    if (offset < 0)
      await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
    else {
      const r = await f.run();
      expect(
        r.budget.rentAllowances.every(
          (a) =>
            a.conservativeTokenAccountRentAllowanceLamports === rent.toString(),
        ),
      ).toBe(true);
      expect(r.budget.feeAndSetupCoverageVerified).toBe(false);
    }
  },
);
it('binds historical reference values beside the new independent proposal', async () => {
  const f = await fixture('sold');
  const r = await f.run();
  const prior = f.source.retainedReview.document.wallets[0],
    wallet = r.budget.wallets[0];
  expect(wallet.savedPlanFeeReserveLamports).toBe(prior.feeReserveLamports);
  expect(wallet.savedReviewNetRemainingReserveLamports).toBe(
    prior.remainingFeeReserveLamports,
  );
  expect(wallet.savedReviewMaximumNativeSpendLamports).toBe(
    prior.maximumNativeSpendLamports,
  );
  expect(wallet.differenceFromSavedReviewNativeLimitLamports).toBe(
    (
      BigInt(wallet.maximumNewNativeDebitLamports) -
      BigInt(prior.maximumNativeSpendLamports)
    ).toString(),
  );
  expect(r.budget.proposalExpiresAt).toBe(r.verifierEvidence.assets.expiresAt);
  expect(r.budget.proposedSessionExpiresAt).toBe(f.input.sessionExpiresAt);
});
it('does not silently extend the maximum tail after the last captured action', async () => {
  const f = await fixture();
  f.input.sessionExpiresAt = new Date(
    Date.parse(f.input.sessionExpiresAt) + 1,
  ).toISOString();
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
});
it('preserves cancellation after a provider response without another read', async () => {
  const f = await fixture(),
    c = new AbortController();
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    const response = await original(...args);
    c.abort(new Error('cancelled mid-read'));
    return response;
  });
  await expect(f.run(f.input, c.signal)).rejects.toThrow('cancelled mid-read');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it('retains both wallets and both mint policies, including Token-2022 account rent', async () => {
  const f = await fixture();
  const secondWallet = '9o9xp1fS4MyHBKE6xHCrRhN2YqpyLAf8Ae5iyd4o1UJk';
  const secondMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const plan = JSON.parse(f.source.sourceDocument).planDocument;
  const document = JSON.parse(plan);
  document.addresses.push(secondWallet);
  document.walletRevisions.push({ address: secondWallet, revision: 1 });
  document.tokens.push(secondMint);
  document.startAt = new Date(f.clock()).toISOString();
  document.totalBudget = buildWarmupPlan(document, f.clock()).totalBudget;
  f.sqlite
    .prepare(
      "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at) VALUES(?,'Solana',?,'','Second fixture','trading',?)",
    )
    .run(f.owner, secondWallet, new Date(f.clock()).toISOString());
  f.sqlite
    .prepare(
      'UPDATE wallet_warmup_plans SET document=? WHERE owner_id=? AND id=?',
    )
    .run(JSON.stringify(document), f.owner, f.planId);
  const loaded = await loadWalletWarmupProgress(
    f.db,
    f.owner,
    f.planId,
    1,
    false,
    true,
  );
  const reviewed = reviewWalletWarmupSession(
    loaded.plan,
    loaded.progress,
    loaded.performance,
    f.clock(),
  );
  const kept = await retainWalletWarmupSessionReview(
    f.db,
    f.owner,
    {
      id: crypto.randomUUID(),
      planId: f.planId,
      revision: 1,
      reviewedAt: reviewed.reviewedAt,
      reviewSha256: await digest(reviewed.contextKey),
    },
    true,
    new AbortController().signal,
    f.clock,
  );
  Object.assign(f.input, {
    reviewId: kept.id,
    reviewSha256: kept.reviewSha256,
    sessionExpiresAt: new Date(
      Date.parse(reviewed.actions.at(-1)!.scheduledAt) + 300000,
    ).toISOString(),
    feeRentLimits: reviewed.actions.map((a) => ({
      actionId: a.id,
      maximumLamports: '5000000',
    })),
  });
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    const response = await original(...args);
    const req = JSON.parse(args[1]!.body as string);
    if (req.method !== 'getMultipleAccounts') return response;
    const result = (await response.json()) as {
      result: { value: { owner: string }[] };
    };
    result.result.value[req.params[0].indexOf(secondMint)].owner =
      SWAP_TOKEN_2022;
    return Response.json(result);
  });
  const r = await f.run();
  expect(r.terms.intent.wallets).toHaveLength(2);
  expect(r.terms.intent.actions.map((a) => a.id)).toEqual(
    reviewed.actions.map((a) => a.id),
  );
  const extended = r.terms.intent.actions.filter((a) => a.mint === secondMint);
  expect(extended.length).toBeGreaterThan(0);
  expect(
    extended.every(
      (a) => a.tokenProgram === SWAP_TOKEN_2022 && a.decimals === 6,
    ),
  ).toBe(true);
  expect(
    r.budget.rentAllowances.find((a) => a.actionId === extended[0].id)
      ?.targetTokenAccountRentLamports,
  ).toBe(String((128 + 170) * 3480 * 2));
  const allowance =
    BigInt((128 + 170) * 3480 * 2) + BigInt((128 + 165) * 3480 * 2);
  const limit = f.input.feeRentLimits.find(
    (a) => a.actionId === extended[0].id,
  )!;
  limit.maximumLamports = (allowance - 1n).toString();
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
  limit.maximumLamports = allowance.toString();
  expect(
    (await f.run()).terms.intent.actions.find((a) => a.id === extended[0].id)
      ?.maximumFeeRentLamports,
  ).toBe(allowance.toString());
});

it('refuses a saved lot when the current token program differs instead of defaulting it', async () => {
  const f = await fixture('buy');
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    const response = await original(...args);
    const req = JSON.parse(args[1]!.body as string);
    if (req.method !== 'getMultipleAccounts') return response;
    const result = (await response.json()) as {
      result: { value: { owner: string }[] };
    };
    result.result.value[1].owner = SWAP_TOKEN_2022;
    return Response.json(result);
  });
  await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});

it.each([24999, 25000, 60000])(
  'checks final source/asset expiry after %sms clock movement without extending it',
  async (elapsed) => {
    const f = await fixture();
    const prepare = f.db.prepare.bind(f.db);
    let reads = 0;
    f.db.prepare = (sql: string) => {
      if (
        sql.startsWith('SELECT owner_id,id,plan_id,plan_revision') &&
        ++reads === 7
      )
        f.advance(elapsed);
      return prepare(sql);
    };
    if (elapsed < 25000) {
      const r = await f.run();
      expect(r.budget.proposalExpiresAt).toBe(
        r.verifierEvidence.assets.expiresAt,
      );
    } else
      await expect(f.run()).rejects.toThrow('Fresh warmup spending review');
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  },
);
