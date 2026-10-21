import { afterEach, expect, it, vi } from 'vitest';
import { warmupSessionSettlementStorageFixture } from '@/test/warmup-session-settlement-storage-fixture';
import {
  retainWalletWarmupSessionSettlement as retain,
  readWalletWarmupSessionSettlement as read,
} from './wallet-warmup-session-settlement-storage';
import { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
import { WARMUP_SESSION_REVIEW_GAP_MS } from './wallet-warmup-session-sequence';
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
const clients: { close(): void }[] = [];
const signal = () => new AbortController().signal;
async function fixture(reserve?: string) {
  const f = await warmupSessionSettlementStorageFixture(reserve);
  clients.push(f.client);
  return f;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
});

it('atomically retains a real-parser Buy outcome and advances its journal/head/spending exactly once', async () => {
  const f = await fixture(),
    request = f.request();
  const saved = await retain(
    f.db,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(saved.record).toMatchObject({
    mode: 'applied',
    reason: null,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    settlement: {
      side: 'Buy',
      inputLamports: '1000000',
      acquiredRaw: '101',
      networkFeeLamports: '5000',
    },
  });
  expect(saved.journal.snapshot).toMatchObject({
    completedActions: 1,
    pending: null,
    phase: 'waiting',
    wallets: [
      {
        recordedFurtherBuySpendLamports: '1000000',
        recordedFurtherFeeRentLamports: '5000',
        remainingReserveLamports: '9995000',
      },
    ],
  });
  expect(saved.journal.version).toBe(f.journal.version + 1);
  expect(f.methods).toEqual(['getGenesisHash', 'getTransaction']);
  const recovered = await retain(
    f.db,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(recovered.recordSha256).toBe(saved.recordSha256);
  expect(recovered.journal.snapshot.completedActions).toBe(1);
  expect(f.methods).toHaveLength(2);
});

it('records a verified Sell with its exact session-buy dependency and completes both outcomes', async () => {
  const f = await fixture();
  const buy = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  f.setJournal(buy.journal);
  f.advance(WARMUP_SESSION_REVIEW_GAP_MS);
  const sellAction = JSON.parse(buy.journal.sourceDocument).review.actions[1]
    .id;
  await f.append('begin-review', sellAction);
  await f.append('submitted', sellAction);
  await f.installSell();
  const saved = await retain(
    f.db,
    'owner',
    f.request(f.packets.sell.receiptId),
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(saved.record).toMatchObject({
    mode: 'applied',
    settlement: {
      side: 'Sell',
      buyReceiptId: f.packets.buy.receiptId,
      consumedRaw: '101',
    },
  });
  expect(saved.journal.snapshot).toMatchObject({
    phase: 'complete',
    completedActions: 2,
    pending: null,
    wallets: [
      {
        recordedFurtherBuySpendLamports: '1000000',
        recordedFurtherFeeRentLamports: '10000',
        remainingReserveLamports: '9990000',
      },
    ],
  });
  expect(f.methods).toEqual([
    'getGenesisHash',
    'getTransaction',
    'getGenesisHash',
    'getTransaction',
    'getGenesisHash',
    'getTransaction',
  ]);
});

it('retains an over-reserve actual outcome as held evidence without consuming a replacement budget', async () => {
  const f = await fixture('0.000001');
  const saved = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(saved.record).toMatchObject({
    mode: 'held',
    reason: 'sequence-refused',
    settlement: { networkFeeLamports: '5000' },
  });
  expect(saved.journal.snapshot).toMatchObject({
    phase: 'recovery-required',
    completedActions: 0,
    pending: { state: 'unknown' },
    wallets: [
      {
        recordedFurtherBuySpendLamports: '0',
        recordedFurtherFeeRentLamports: '0',
        remainingReserveLamports: '1000',
      },
    ],
  });
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM warmup_buy_receipts')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  f.setJournal(saved.journal);
  await expect(
    f.append('begin-review', saved.record.actionId),
  ).rejects.toThrow();
});

it('records a verified late outcome after Stop, expiry and archival without resuming', async () => {
  const f = await fixture();
  await f.append('stop');
  f.advance(120000);
  await f.db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2')
    .run();
  const saved = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(saved.journal.snapshot).toMatchObject({
    phase: 'stopped',
    stopped: true,
    sourceReviewFresh: false,
    completedActions: 1,
  });
  expect(saved.record.signingAllowed).toBe(false);
});

it('isolates saved proof owners and rejects extra request-side source/settlement flags', async () => {
  const f = await fixture();
  const request = f.request();
  await retain(f.db, 'owner', request, signal(), f.fetcher, f.clock);
  expect(await read(f.db, 'other', request.id, signal(), f.clock())).toBeNull();
  const count = f.methods.length;
  await expect(
    retain(
      f.db,
      'owner',
      { ...request, settlement: { verified: true } },
      signal(),
      f.fetcher,
      f.clock,
    ),
  ).rejects.toThrow();
  await expect(
    retain(
      f.db,
      'owner',
      { ...request, owner: 'other' },
      signal(),
      f.fetcher,
      f.clock,
    ),
  ).rejects.toThrow();
  expect(f.methods).toHaveLength(count);
});

it('keeps historical proof readable after a later legitimate remaining-unit change without another RPC', async () => {
  const f = await fixture();
  const request = f.request();
  const saved = await retain(
    f.db,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  );
  await f.installSell();
  const recovered = await read(f.db, 'owner', request.id, signal(), f.clock());
  expect(recovered?.recordSha256).toBe(saved.recordSha256);
  expect(f.methods).toHaveLength(2);
});

it('stops on the first provider refusal without writing or retrying', async () => {
  const f = await fixture();
  f.throttle();
  await expect(
    retain(f.db, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow('verification');
  expect(f.methods).toHaveLength(1);
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_settlements')
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(
    (
      await readWalletWarmupSessionJournal(
        f.db,
        'owner',
        f.rootInput.id,
        signal(),
        f.clock(),
      )
    )?.version,
  ).toBe(f.journal.version);
});

function intercept(
  db: D1Database,
  onRun: (run: () => Promise<unknown>) => Promise<unknown>,
) {
  return {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const original = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_settlements'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return { run: () => onRun(() => bound.run()) };
        },
      };
    },
  } as D1Database;
}
async function count(db: D1Database) {
  return (
    await db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_settlements')
      .first<{ n: number }>()
  )?.n;
}

it('recovers a committed lost response with one INSERT and no repeated provider verification', async () => {
  const f = await fixture();
  const request = f.request();
  let writes = 0;
  const wrapped = intercept(f.db, async (run) => {
    writes++;
    await run();
    throw Error('Lost response');
  });
  const saved = await retain(
    wrapped,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(saved.record.mode).toBe('applied');
  expect(writes).toBe(1);
  const recovered = await retain(
    wrapped,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  );
  expect(recovered.recordSha256).toBe(saved.recordSha256);
  expect(writes).toBe(1);
  expect(f.methods).toHaveLength(2);
  expect(await count(f.db)).toBe(1);
  expect(recovered.journal.snapshot.completedActions).toBe(1);
});

it('preserves proof/event/head after cancellation of a response that already committed', async () => {
  const f = await fixture();
  const request = f.request(),
    controller = new AbortController();
  let writes = 0;
  const wrapped = intercept(f.db, async (run) => {
    writes++;
    const result = await run();
    controller.abort();
    return result;
  });
  await expect(
    retain(wrapped, 'owner', request, controller.signal, f.fetcher, f.clock),
  ).rejects.toThrow();
  expect(writes).toBe(1);
  expect(await count(f.db)).toBe(1);
  const saved = await read(f.db, 'owner', request.id, signal(), f.clock());
  expect(saved?.journal.snapshot.completedActions).toBe(1);
  expect(f.methods).toHaveLength(2);
});

it('does not write when cancelled before verification or during the provider response', async () => {
  const f = await fixture();
  const closed = new AbortController();
  closed.abort();
  await expect(
    retain(f.db, 'owner', f.request(), closed.signal, f.fetcher, f.clock),
  ).rejects.toThrow();
  expect(f.methods).toHaveLength(0);
  const live = new AbortController();
  f.setHook(async () => live.abort());
  await expect(
    retain(f.db, 'owner', f.request(), live.signal, f.fetcher, f.clock),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
});

it('refuses source drift at the INSERT boundary without any proof or partial journal effect', async () => {
  const f = await fixture();
  let writes = 0;
  const wrapped = intercept(f.db, async (run) => {
    writes++;
    await f.db
      .prepare("UPDATE warmup_buy_receipts SET remaining_raw='0'")
      .run();
    return run();
  });
  await expect(
    retain(wrapped, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow('original record ID');
  expect(writes).toBe(1);
  expect(f.methods).toHaveLength(2);
  expect(await count(f.db)).toBe(0);
  const journal = await readWalletWarmupSessionJournal(
    f.db,
    'owner',
    f.rootInput.id,
    signal(),
    f.clock(),
  );
  expect(journal?.version).toBe(f.journal.version);
  expect(journal?.snapshot.completedActions).toBe(0);
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM warmup_buy_receipts')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});

it('guards the linked buy counter for Sell at the same INSERT boundary', async () => {
  const f = await fixture();
  const buy = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  f.setJournal(buy.journal);
  f.advance(WARMUP_SESSION_REVIEW_GAP_MS);
  const action = JSON.parse(buy.journal.sourceDocument).review.actions[1].id;
  await f.append('begin-review', action);
  await f.append('submitted', action);
  await f.installSell();
  const wrapped = intercept(f.db, async (run) => {
    await f.db
      .prepare("UPDATE warmup_buy_receipts SET remaining_raw='1'")
      .run();
    return run();
  });
  await expect(
    retain(
      wrapped,
      'owner',
      f.request(f.packets.sell.receiptId),
      signal(),
      f.fetcher,
      f.clock,
    ),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(1);
  expect(f.methods).toHaveLength(6);
  const journal = await readWalletWarmupSessionJournal(
    f.db,
    'owner',
    f.rootInput.id,
    signal(),
    f.clock(),
  );
  expect(journal?.snapshot.completedActions).toBe(1);
  expect(journal?.snapshot.wallets[0].recordedFurtherFeeRentLamports).toBe(
    '5000',
  );
});

it('allows one of two fully verified competing inserts and identifies the owned original record', async () => {
  const f = await fixture();
  let arrivals = 0,
    release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = intercept(f.db, async (run) => {
    if (++arrivals === 2) release();
    await barrier;
    return run();
  });
  const outcomes = await Promise.allSettled([
    retain(wrapped, 'owner', f.request(), signal(), f.fetcher, f.clock),
    retain(wrapped, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ]);
  expect(arrivals).toBe(2);
  const passed = outcomes.filter((v) => v.status === 'fulfilled');
  expect(passed).toHaveLength(1);
  const winner = passed[0];
  if (winner.status !== 'fulfilled') throw Error('Expected winner');
  const refused = outcomes.find((v) => v.status === 'rejected');
  if (refused?.status !== 'rejected') throw Error('Expected refusal');
  expect(refused.reason.recoveryId).toBe(winner.value.record.id);
  expect(await count(f.db)).toBe(1);
  expect(winner.value.journal.snapshot.completedActions).toBe(1);
  expect(
    winner.value.journal.snapshot.wallets[0].recordedFurtherFeeRentLamports,
  ).toBe('5000');
});

it('rolls back the proof and event if the head update fails, leaving the actual receipt intact', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "CREATE TRIGGER fixture_settlement_head_failure BEFORE UPDATE ON wallet_warmup_session_journal_heads BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    .run();
  await expect(
    retain(f.db, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
  const journal = await readWalletWarmupSessionJournal(
    f.db,
    'owner',
    f.rootInput.id,
    signal(),
    f.clock(),
  );
  expect(journal?.version).toBe(f.journal.version);
  expect(journal?.snapshot.completedActions).toBe(0);
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM warmup_buy_receipts')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});

it('does not retry an unknown failed write whose original ID is absent', async () => {
  const f = await fixture();
  let writes = 0;
  const wrapped = intercept(f.db, async () => {
    writes++;
    throw Error('Connection lost');
  });
  await expect(
    retain(wrapped, 'owner', f.request(), signal(), f.fetcher, f.clock),
  ).rejects.toThrow('original record ID');
  expect(writes).toBe(1);
  expect(await count(f.db)).toBe(0);
  expect(f.methods).toHaveLength(2);
});

it('refuses changing the saved identity, receipt or predecessor without another provider request', async () => {
  const f = await fixture(),
    request = f.request();
  await retain(f.db, 'owner', request, signal(), f.fetcher, f.clock);
  for (const change of [
    { journalId: crypto.randomUUID() },
    { receiptId: crypto.randomUUID() },
    { version: request.version + 1 },
    { headSha256: 'a'.repeat(64) },
  ])
    await expect(
      retain(
        f.db,
        'owner',
        { ...request, ...change },
        signal(),
        f.fetcher,
        f.clock,
      ),
    ).rejects.toThrow();
  expect(f.methods).toHaveLength(2);
  expect(await count(f.db)).toBe(1);
});

it('blocks UPDATE, DELETE, replacement and generic finalized client labels', async () => {
  const f = await fixture();
  const saved = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  await expect(
    f.db
      .prepare('UPDATE wallet_warmup_session_settlements SET mode=mode')
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    f.db.prepare('DELETE FROM wallet_warmup_session_settlements').run(),
  ).rejects.toThrow('immutable');
  await expect(
    f.db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_settlements SELECT * FROM wallet_warmup_session_settlements',
      )
      .run(),
  ).rejects.toThrow();
  f.setJournal(saved.journal);
  await expect(f.append('finalized', saved.record.actionId)).rejects.toThrow();
  const document = JSON.stringify({
    eventId: crypto.randomUUID(),
    version: saved.journal.version + 1,
    previousSha256: saved.journal.headSha256,
    at: new Date(f.clock()).toISOString(),
    operation: 'finalized',
    actionId: saved.record.actionId,
    settlement: saved.record.settlement,
    proofSha256: saved.recordSha256,
  });
  const { walletWarmupSessionDigest } =
    await import('./wallet-warmup-session-digest');
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        f.rootInput.id,
        JSON.parse(document).eventId,
        saved.journal.version + 1,
        saved.journal.headSha256,
        document,
        await walletWarmupSessionDigest(document),
        new Date(f.clock()).toISOString(),
      )
      .run(),
  ).rejects.toThrow();
});

it('withholds both proof and journal recovery when settlement guards are missing', async () => {
  const f = await fixture();
  const request = f.request();
  await retain(f.db, 'owner', request, signal(), f.fetcher, f.clock);
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_settlements_apply')
    .run();
  await expect(
    read(f.db, 'owner', request.id, signal(), f.clock()),
  ).rejects.toThrow('not installed');
  await expect(
    readWalletWarmupSessionJournal(
      f.db,
      'owner',
      f.rootInput.id,
      signal(),
      f.clock(),
    ),
  ).rejects.toThrow('not installed');
});

it('withholds journal progress when a retained proof envelope is corrupted out of band', async () => {
  const f = await fixture();
  const request = f.request();
  await retain(f.db, 'owner', request, signal(), f.fetcher, f.clock);
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_settlements_no_update')
    .run();
  await f.db
    .prepare(
      "UPDATE wallet_warmup_session_settlements SET document=document||' '",
    )
    .run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_settlements_no_update BEFORE UPDATE ON wallet_warmup_session_settlements BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(
    read(f.db, 'owner', request.id, signal(), f.clock()),
  ).rejects.toThrow('unavailable or differs');
  await expect(
    readWalletWarmupSessionJournal(
      f.db,
      'owner',
      f.rootInput.id,
      signal(),
      f.clock(),
    ),
  ).rejects.toThrow('unavailable or differs');
});

it('withholds full historical proof recovery when its separately retained source blob is corrupted', async () => {
  const f = await fixture();
  const request = f.request();
  await retain(f.db, 'owner', request, signal(), f.fetcher, f.clock);
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_settlements_no_update')
    .run();
  await f.db
    .prepare("UPDATE wallet_warmup_session_settlements SET source=source||' '")
    .run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_settlements_no_update BEFORE UPDATE ON wallet_warmup_session_settlements BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(
    read(f.db, 'owner', request.id, signal(), f.clock()),
  ).rejects.toThrow('unavailable or differs');
  expect(f.methods).toHaveLength(2);
});

it.each(['wrong-chain', 'changed-balances'])(
  'does not turn %s verification failure into held or applied evidence',
  async (kind) => {
    const f = await fixture();
    const fetcher: typeof fetch =
      kind === 'wrong-chain'
        ? async (_url, init) => {
            const body = JSON.parse(init!.body as string);
            f.methods.push(body.method);
            return Response.json({
              jsonrpc: '2.0',
              id: body.id,
              result: 'not-mainnet',
            });
          }
        : f.fetcher;
    if (kind === 'changed-balances')
      f.packets.buy.raw.meta.postTokenBalances[0].uiTokenAmount.amount = '102';
    await expect(
      retain(f.db, 'owner', f.request(), signal(), fetcher, f.clock),
    ).rejects.toThrow('verification');
    expect(await count(f.db)).toBe(0);
    expect(
      (
        await readWalletWarmupSessionJournal(
          f.db,
          'owner',
          f.rootInput.id,
          signal(),
          f.clock(),
        )
      )?.version,
    ).toBe(f.journal.version);
  },
);

it('refuses a backwards capture clock after provider replay without changing the journal', async () => {
  const f = await fixture();
  let calls = 0;
  const clock = () => (++calls < 3 ? f.clock() : f.clock() - 1);
  await expect(
    retain(f.db, 'owner', f.request(), signal(), f.fetcher, clock),
  ).rejects.toThrow();
  expect(await count(f.db)).toBe(0);
  expect(f.methods).toHaveLength(2);
});

it('points to the owned original proof instead of charging a receipt again through another retained review', async () => {
  const f = await fixture();
  const buy = await retain(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  f.setJournal(buy.journal);
  const { loadWalletWarmupProgress } =
    await import('./wallet-warmup-progress-server');
  const { reviewWalletWarmupSession } =
    await import('./wallet-warmup-session-review');
  const { retainWalletWarmupSessionReview } =
    await import('./wallet-warmup-session-storage');
  const { reviewWalletWarmupSessionConsent, retainWalletWarmupSessionConsent } =
    await import('./wallet-warmup-session-consent');
  const { retainWalletWarmupSessionJournal, appendWalletWarmupSessionJournal } =
    await import('./wallet-warmup-session-journal-storage');
  const { walletWarmupSessionDigest } =
    await import('./wallet-warmup-session-digest');
  const progress = await loadWalletWarmupProgress(
    f.db,
    'owner',
    f.plan.id,
    1,
    false,
    true,
  );
  const review = reviewWalletWarmupSession(
    progress.plan,
    progress.progress,
    progress.performance,
    Date.now(),
  );
  const kept = await retainWalletWarmupSessionReview(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      planId: f.plan.id,
      revision: 1,
      reviewedAt: review.reviewedAt,
      reviewSha256: await walletWarmupSessionDigest(review.contextKey),
    },
    true,
    signal(),
  );
  const terms = {
    reviewId: kept.id,
    reviewSha256: kept.reviewSha256,
    sessionExpiresAt: new Date(
      Math.max(...review.actions.map((a) => Date.parse(a.scheduledAt))) + 60000,
    ).toISOString(),
  };
  const prepared = await reviewWalletWarmupSessionConsent(
    f.db,
    'owner',
    terms,
    signal(),
  );
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    { ...terms, id: crypto.randomUUID(), termsSha256: prepared.termsSha256 },
    true,
    signal(),
  );
  let other = await retainWalletWarmupSessionJournal(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
    },
    true,
    signal(),
  );
  f.advance(WARMUP_SESSION_REVIEW_GAP_MS);
  const firstAction = JSON.parse(buy.journal.sourceDocument).review.actions[1]
    .id;
  await f.append('begin-review', firstAction);
  await f.append('submitted', firstAction);
  const otherAction = review.actions[0].id;
  for (const operation of ['begin-review', 'submitted'])
    other = await appendWalletWarmupSessionJournal(
      f.db,
      'owner',
      {
        id: crypto.randomUUID(),
        journalId: other.id,
        expectedVersion: other.version,
        expectedHeadSha256: other.headSha256,
        command: { operation, actionId: otherAction },
      },
      signal(),
      f.clock,
    );
  await f.installSell();
  const original = await retain(
    f.db,
    'owner',
    f.request(f.packets.sell.receiptId),
    signal(),
    f.fetcher,
    f.clock,
  );
  const request = {
    id: crypto.randomUUID(),
    journalId: other.id,
    version: other.version,
    headSha256: other.headSha256,
    receiptId: f.packets.sell.receiptId,
  };
  const error = await retain(
    f.db,
    'owner',
    request,
    signal(),
    f.fetcher,
    f.clock,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ status: 409, recoveryId: original.record.id });
  expect(await count(f.db)).toBe(2);
  expect(
    (
      await readWalletWarmupSessionJournal(
        f.db,
        'owner',
        other.id,
        signal(),
        f.clock(),
      )
    )?.version,
  ).toBe(other.version);
});
