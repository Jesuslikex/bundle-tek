import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupReconstructionFixture } from '../test/warmup-reconstruction-fixture';
import { reconstructWarmupExecutionRoot } from './wallet-warmup-execution-budget-review';
import {
  readRetainedWarmupExecutionSource,
  readWarmupExecutionSource,
} from './wallet-warmup-execution-source';
import {
  bindWarmupExecutionRoot,
  bindWarmupExecutionTerms,
} from './wallet-warmup-execution-terms';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
type Fixture = Awaited<ReturnType<typeof warmupReconstructionFixture>>;
const fixtures: Fixture[] = [];
const network = vi.fn(async () => {
  throw Error('No reconstruction network allowed');
});
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal('fetch', network);
});
async function fixture(
  history: 'none' | 'buy' | 'sold' = 'none',
  maximum = false,
) {
  const f = await warmupReconstructionFixture(history, maximum);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.dispose());
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const signal = () => new AbortController().signal;
const read = (
  f: Fixture,
  record: unknown = f.record,
  expected: unknown = f.expected,
  s = signal(),
) => reconstructWarmupExecutionRoot(f.db, f.owner, record, expected, s);
async function rebind(f: Fixture) {
  f.record.root.terms.verifierEvidenceSha256 = await digest(
    canonical(f.record.verifierEvidence),
  );
  f.record.approval.termsSha256 = (
    await bindWarmupExecutionTerms(f.record.root.terms)
  ).termsSha256;
  const bound = await bindWarmupExecutionRoot(
    f.record.root.terms,
    f.record.approval,
  );
  f.record.root = bound.root;
  f.expected.rootSha256 = bound.rootSha256;
}

it.each(['none', 'buy', 'sold'] as const)(
  'reconstructs original owned %s actions, assets and independent budgets without new reads or authority',
  async (history) => {
    const f = await fixture(history);
    const calls = f.providerCalls();
    const r = await read(f);
    expect(r.root).toEqual(f.record.root);
    expect(r.approval).toEqual(f.record.approval);
    expect(r.budget).toEqual(f.proposed.budget);
    expect(r.sourceSnapshotSha256).toBe(f.source.sourceSnapshotSha256);
    expect(
      r.humanApprovalVerified ||
        r.currentSourceVerified ||
        r.networkObservationReverified ||
        r.signingAllowed ||
        r.executionAllowed ||
        r.automaticExecutionAllowed,
    ).toBe(false);
    expect(f.providerCalls()).toBe(calls);
    expect(() => JSON.stringify(r)).not.toThrow();
  },
);
it('reconstructs every action for the supported maximum800-action plan and10Token2022 mints', async () => {
  const f = await fixture('none', true),
    r = await read(f);
  expect(r.root.terms.intent.actions).toHaveLength(800);
  expect(r.root.terms.intent.wallets).toHaveLength(20);
  expect(
    r.verifierEvidence.assets.tokenAccountRents.filter(
      (a) => a.accountSize === 170,
    ),
  ).toHaveLength(10);
  expect(r.rootSha256).toBe(f.expected.rootSha256);
});
it('keeps the original identities and expiry after the original window has expired', async () => {
  const f = await fixture();
  const a = f.actual!;
  a.advance(60000);
  await expect(
    readWarmupExecutionSource(f.db, f.owner, f.input, signal(), f.clock),
  ).rejects.toThrow('Execution source');
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse('2100-01-01T00:00:00.000Z'));
  try {
    const r = await read(f);
    expect(r.approval.approvedAt).toBe(f.record.approval.approvedAt);
    expect(r.verifierEvidence.assets.expiresAt).toBe(
      f.record.verifierEvidence.assets.expiresAt,
    );
    expect(r.root.terms.review.reviewExpiresAt).toBe(
      f.source.retainedReview.reviewExpiresAt,
    );
  } finally {
    now.mockRestore();
  }
});
it.each(['plan-archived', 'wallet-revision', 'new-buy', 'new-sell'] as const)(
  'preserves historical reconstruction when current source changes: %s',
  async (kind) => {
    const f = await fixture(kind === 'new-sell' ? 'buy' : 'none'),
      a = f.actual!;
    if (kind === 'plan-archived')
      a.sqlite
        .prepare('UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=?')
        .run(f.owner);
    if (kind === 'wallet-revision')
      a.sqlite
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
        )
        .run(f.owner);
    if (kind === 'new-buy') a.buy();
    if (kind === 'new-sell') a.sell();
    await expect(
      readWarmupExecutionSource(f.db, f.owner, f.input, signal(), f.clock),
    ).rejects.toThrow('Execution source');
    expect((await read(f)).rootSha256).toBe(f.expected.rootSha256);
  },
);
it('uses no current-state SQL or database writes during original-source recovery', async () => {
  const f = await fixture();
  const a = f.actual!,
    changes = a.sqlite.prepare('SELECT total_changes() AS n').get()!.n;
  const prepare = vi.spyOn(f.db, 'prepare');
  const old = await readRetainedWarmupExecutionSource(
    f.db,
    f.owner,
    f.input,
    signal(),
  );
  expect(old.sourceSnapshotSha256).toBe(f.source.sourceSnapshotSha256);
  expect(old.currentSourceVerified).toBe(false);
  await read(f);
  expect(
    prepare.mock.calls.every(
      ([sql]) =>
        sql.includes('FROM wallet_warmup_session_reviews') ||
        sql.includes('FROM sqlite_master'),
    ),
  ).toBe(true);
  expect(
    prepare.mock.calls.every(([sql]) => !sql.includes(' AS current')),
  ).toBe(true);
  expect(a.sqlite.prepare('SELECT total_changes() AS n').get()!.n).toBe(
    changes,
  );
});
it.each(['owner', 'id', 'consentId', 'reviewId', 'rootSha256'] as const)(
  'requires an independently supplied owned %s selector',
  async (field) => {
    const f = await fixture(),
      expected = structuredClone(f.expected);
    if (field === 'owner')
      await expect(
        reconstructWarmupExecutionRoot(
          f.db,
          'other-owner',
          f.record,
          expected,
          signal(),
        ),
      ).rejects.toThrow('Retained execution root');
    else {
      expected[field] =
        field === 'rootSha256' ? '0'.repeat(64) : crypto.randomUUID();
      await expect(read(f, f.record, expected)).rejects.toThrow(
        'Retained execution root',
      );
    }
  },
);
it.each([
  'planId',
  'planRevision',
  'sourceSha256',
  'buyAmount',
  'schedule',
  'shorterOriginalReview',
  'feeMismatch',
] as const)(
  'refuses a self-consistent rehashed model with changed owned %s',
  async (kind) => {
    const f = await fixture(),
      intent = f.record.root.terms.intent;
    if (kind === 'planId') intent.planId = 'other-plan';
    if (kind === 'planRevision') intent.planRevision++;
    if (kind === 'sourceSha256') {
      expect(f.source.sourceSha256).not.toBe(f.source.sourceSnapshotSha256);
      intent.sourceSha256 = f.source.sourceSha256;
    }
    if (kind === 'buyAmount') {
      const buy = intent.actions.find((a) => a.side === 'Buy')!;
      if (buy.side === 'Buy')
        buy.inputLamports = (BigInt(buy.inputLamports) + 1n).toString();
      intent.wallets.find((w) => w.wallet === buy.wallet)!.maximumBuyLamports =
        (BigInt(intent.wallets[0].maximumBuyLamports) + 1n).toString();
    }
    if (kind === 'schedule')
      intent.actions[2].scheduledAt = new Date(
        Date.parse(intent.actions[2].scheduledAt) + 1000,
      ).toISOString();
    if (kind === 'shorterOriginalReview')
      f.record.root.terms.review.reviewExpiresAt = new Date(
        Date.parse(f.record.root.terms.review.reviewExpiresAt) - 1,
      ).toISOString();
    if (kind === 'feeMismatch') {
      intent.actions[0].maximumFeeRentLamports = (
        BigInt(intent.actions[0].maximumFeeRentLamports) + 1n
      ).toString();
      intent.wallets[0].maximumFeeRentLamports = (
        BigInt(intent.wallets[0].maximumFeeRentLamports) + 1n
      ).toString();
    }
    await rebind(f);
    await expect(read(f)).rejects.toThrow('Retained execution root');
  },
);
it.each([
  'netReserve',
  'oldMax',
  'nativeSum',
  'difference',
  'rentAllowance',
  'budgetHash',
  'assetHash',
  'claimFunded',
  'extraBudgetField',
] as const)(
  'refuses rehashed claimed %s instead of trusting verifier fields',
  async (kind) => {
    const f = await fixture(),
      v = f.record.verifierEvidence,
      b = v.freshBudget;
    if (kind === 'netReserve')
      b.wallets[0].savedReviewNetRemainingReserveLamports = '1';
    if (kind === 'oldMax')
      b.wallets[0].savedReviewMaximumNativeSpendLamports = '1';
    if (kind === 'nativeSum') b.wallets[0].maximumNewNativeDebitLamports = '1';
    if (kind === 'difference')
      b.wallets[0].differenceFromSavedReviewNativeLimitLamports = '1';
    if (kind === 'rentAllowance')
      b.rentAllowances[0].conservativeTokenAccountRentAllowanceLamports = '1';
    if (kind === 'budgetHash') v.freshBudgetSha256 = '0'.repeat(64);
    if (kind === 'assetHash') v.assetEvidenceSha256 = '0'.repeat(64);
    if (kind === 'claimFunded')
      (b as Record<string, unknown>).fundingSufficiencyVerified = true;
    if (kind === 'extraBudgetField')
      (b as Record<string, unknown>).verified = true;
    if (kind !== 'budgetHash') v.freshBudgetSha256 = await digest(canonical(b));
    await rebind(f);
    await expect(read(f)).rejects.toThrow('Retained execution root');
  },
);
it.each([-1, 0, 1])(
  'keeps the approval exclusive original asset expiry boundary at%s ms',
  async (offset) => {
    const f = await fixture();
    f.record.approval.approvedAt = new Date(
      Date.parse(f.record.verifierEvidence.assets.expiresAt) + offset,
    ).toISOString();
    await rebind(f);
    const work = read(f);
    if (offset < 0)
      expect((await work).approval.approvedAt).toBe(
        f.record.approval.approvedAt,
      );
    else await expect(work).rejects.toThrow('Retained execution root');
  },
);
it('refuses approval before captured asset evidence even when the model review window permits it', async () => {
  const f = await fixture();
  f.record.approval.approvedAt = f.source.retainedReview.reviewedAt;
  await rebind(f);
  await expect(read(f)).rejects.toThrow('Retained execution root');
});
it('snapshots all incoming verifier, root, approval and selector fields before awaiting', async () => {
  const f = await fixture();
  const expectedRoot = structuredClone(f.record.root),
    work = read(f);
  f.record.root.terms.intent.planId = 'mutated';
  f.record.approval.approvedAt = 'invalid';
  f.record.verifierEvidence.assets.after.accounts[0].account.data[0] = 'AA==';
  f.record.verifierEvidence.freshBudget.wallets[0].maximumNewNativeDebitLamports =
    '1';
  f.expected.id = crypto.randomUUID();
  expect((await work).root).toEqual(expectedRoot);
});
it('preserves cancellation before lookup and during a historical source read', async () => {
  const f = await fixture(),
    c = new AbortController();
  c.abort(new Error('cancelled root'));
  const prepare = vi.spyOn(f.db, 'prepare');
  await expect(read(f, f.record, f.expected, c.signal)).rejects.toThrow(
    'cancelled root',
  );
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  const second = new AbortController(),
    original = f.db.prepare.bind(f.db);
  f.db.prepare = (sql: string) => {
    if (sql.startsWith('SELECT owner_id,id,plan_id,plan_revision'))
      second.abort(new Error('cancelled source'));
    return original(sql);
  };
  await expect(read(f, f.record, f.expected, second.signal)).rejects.toThrow(
    'cancelled source',
  );
});

it('does not replace a missing selected review with another existing owned review', async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  f.record.root.terms.review.id = id;
  f.record.approval.reviewId = id;
  f.expected.reviewId = id;
  await rebind(f);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_session_reviews',
      )
      .get()!.n,
  ).toBe(1);
  await expect(read(f)).rejects.toThrow('Retained execution root');
});
it('binds the decoder evidence to the owned original review even after all model hashes are resealed', async () => {
  const f = await fixture(),
    v = f.record.verifierEvidence;
  v.assets.reviewId = crypto.randomUUID();
  v.assetEvidenceSha256 = await digest(canonical(v.assets));
  v.freshBudget.assetEvidenceSha256 = v.assetEvidenceSha256;
  v.freshBudgetSha256 = await digest(canonical(v.freshBudget));
  await rebind(f);
  await expect(read(f)).rejects.toThrow('Retained execution root');
});
it('refuses a parent disappearing in the final original-source recheck without returning a partial root', async () => {
  const f = await fixture();
  let reads = 0;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT owner_id,id,plan_id,plan_revision'))
      return statement;
    const ordinal = ++reads,
      bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      if (ordinal === 4) bound.first = async () => null;
      return bound;
    };
    return statement;
  };
  await expect(read(f)).rejects.toThrow('Retained execution root');
  expect(reads).toBe(4);
});
