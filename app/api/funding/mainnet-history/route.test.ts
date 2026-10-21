import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { nativeWithdrawalFixture } from '../../../../test/native-withdrawal-fixture';
import { tokenWithdrawalFixture } from '../../../../test/token-withdrawal-fixture';
import { validateFunding, type SavedFunding } from '@/lib/funding-plan';
import { selectedFundingCapture, fundingLegs } from '@/lib/mainnet-funding';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { decodeNativeWithdrawalReceipt } from '@/lib/native-withdrawal-server';
import { decodeTokenWithdrawalReceipt } from '@/lib/token-withdrawal-server';
import type {
  NativeWithdrawalReview,
  NativeWithdrawalReceipt,
} from '@/lib/native-withdrawal';
import {
  withdrawalInput,
  inspectNativeWithdrawal,
} from '@/lib/native-withdrawal';
import { solanaTransferMessage } from '@/lib/solana-transfer-message';
import { prepareNativeWithdrawal } from '@/lib/native-withdrawal-server';
import {
  decodeMainnetFundingHistory,
  mainnetFundingHistoryCursor,
} from '@/lib/mainnet-funding-history';
const context = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => context.user,
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      args[4] !== fetch ? actual.balanceRpc(...args) : context.rpc(...args),
  };
});
import { GET } from './route';
import { POST as recoverWithdrawal } from '../../wallet-workspace/withdrawals/route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
let mf: Miniflare, fixture: Awaited<ReturnType<typeof nativeWithdrawalFixture>>;
const date = '2026-10-13T00:00:00.000Z';
const planId = 'saved-funding';
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'mainnet-funding-history-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'mainnet-funding-history-only' } },
        },
      },
    ],
  });
  context.db = await mf.getD1Database('DB', 'mainnet-funding-history-test');
  const journal = JSON.parse(
    await readFile('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sql = await readFile(`drizzle/${entry.tag}.sql`, 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .filter((value) => value.trim()))
      await context.db.prepare(statement).run();
  }
  fixture = await nativeWithdrawalFixture();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  context.user = { userId: 'alice' };
  context.rpc.mockReset().mockImplementation(() => {
    throw new Error('Unexpected RPC read.');
  });
  await context.db
    .prepare('DROP TRIGGER IF EXISTS native_withdrawal_delete')
    .run();
  await context.db
    .prepare('DROP TRIGGER IF EXISTS native_withdrawal_event_delete')
    .run();
  for (const table of [
    'native_withdrawal_events',
    'native_withdrawals',
    'solana_execution_reservations',
    'solana_execution_signatures',
    'funding_plans',
  ])
    await context.db.prepare(`DELETE FROM ${table}`).run();
  await context.db
    .prepare(
      "CREATE TRIGGER native_withdrawal_delete BEFORE DELETE ON native_withdrawals BEGIN SELECT RAISE(ABORT,'History retained'); END",
    )
    .run();
  await context.db
    .prepare(
      "CREATE TRIGGER native_withdrawal_event_delete BEFORE DELETE ON native_withdrawal_events BEGIN SELECT RAISE(ABORT,'History retained'); END",
    )
    .run();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('External provider calls forbidden.');
    }),
  );
});
async function plan(
  revision = 1,
  owner = 'alice',
  selected = fixture.review,
): Promise<SavedFunding> {
  const document = validateFunding({
    name: 'Funding',
    chain: 'Solana',
    currency: selected.token ? 'USDC' : 'SOL',
    ...(selected.token ? { assetAddress: selected.token.mint } : {}),
    source: 'Wallet',
    sourceLabel: '',
    funderAddress: selected.wallet,
    startAt: date,
    delaySeconds: 0,
    recipients: [{ address: selected.recipient, amount: selected.amount }],
  });
  await context.db
    .prepare(
      'INSERT INTO funding_plans(owner_id,id,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,0,?,?)',
    )
    .bind(
      owner,
      planId,
      JSON.stringify(document),
      revision,
      crypto.randomUUID(),
      date,
    )
    .run();
  return { id: planId, revision, archived: false, updatedAt: date, document };
}
async function insert(
  n: number,
  saved: SavedFunding,
  owner = 'alice',
  selected = fixture.review,
  item = 1,
  leg?: number,
) {
  const review: NativeWithdrawalReview = { ...selected, id: id(n) };
  review.funding = await selectedFundingCapture(
    saved,
    {
      planId,
      revision: saved.revision,
      item,
      ...(leg === undefined ? {} : { leg }),
    },
    review,
  );
  await withdrawalInsert(review, owner).run();
  return review;
}
function withdrawalInsert(review: NativeWithdrawalReview, owner: string) {
  return context.db
    .prepare(
      "INSERT INTO native_withdrawals(id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',NULL,NULL,?,?)",
    )
    .bind(
      review.id,
      owner,
      review.wallet,
      review.walletRevision,
      JSON.stringify(review),
      date,
      date,
    );
}
async function proxyPlan() {
  const saved = await plan();
  const proxy = bs58.encode(new Uint8Array(32).fill(10));
  saved.document = validateFunding({
    ...saved.document,
    recipients: [
      { address: fixture.recipient, amount: '0.01', proxies: [proxy] },
    ],
  });
  await context.db
    .prepare('UPDATE funding_plans SET document=? WHERE owner_id=? AND id=?')
    .bind(JSON.stringify(saved.document), 'alice', saved.id)
    .run();
  const first = await prepareNativeWithdrawal(
    withdrawalInput(fixture.wallet, proxy, '0.0101', 1),
    new AbortController().signal,
    fixture.fetcher,
  );
  const last = await prepareNativeWithdrawal(
    withdrawalInput(proxy, fixture.recipient, '0.01', 1),
    new AbortController().signal,
    fixture.fetcher,
  );
  return { saved, first, last };
}
it('keeps every proxy leg and replaces only a newer attempt of that same leg', async () => {
  const { saved, first, last } = await proxyPlan();
  const a = await insert(1, saved, 'alice', first, 1, 1);
  await insert(2, saved, 'alice', last, 1, 2);
  await transition(a, 'cancelled', null, null, null, date);
  await insert(3, saved, 'alice', first, 1, 1);
  const history = await read();
  expect(
    history.progress.records.map((r) => [
      r.funding.item,
      r.funding.leg,
      r.withdrawalId,
    ]),
  ).toEqual([
    [1, 1, id(3)],
    [1, 2, id(2)],
  ]);
  expect(history.events.some((r) => r.withdrawalId === id(1))).toBe(true);
  expect(context.rpc).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('returns every one of400 route steps across100 recipients while paginating only transitions', async () => {
  const address = (n: number) => {
    const b = new Uint8Array(32);
    b[0] = 1;
    b[30] = n >> 8;
    b[31] = n & 255;
    return bs58.encode(b);
  };
  const saved = await plan();
  saved.document = validateFunding({
    ...saved.document,
    recipients: Array.from({ length: 100 }, (_, i) => ({
      address: address(i * 4 + 1),
      amount: '0.01',
      proxies: [address(i * 4 + 2), address(i * 4 + 3), address(i * 4 + 4)],
    })),
  });
  await context.db
    .prepare('UPDATE funding_plans SET document=? WHERE owner_id=? AND id=?')
    .bind(JSON.stringify(saved.document), 'alice', saved.id)
    .run();
  const fixtureStarted = performance.now();
  for (let item = 1; item <= 100; item++) {
    if (performance.now() - fixtureStarted > 90000)
      throw new Error(
        'Local capacity-fixture setup exceeded its90second budget.',
      );
    const statements: D1PreparedStatement[] = [];
    const legs = fundingLegs(saved.document, item);
    for (const [n, leg] of legs.entries()) {
      // Offline capacity fixtures: canonical unsigned packets, not runtime qualification.
      const message = solanaTransferMessage(
        leg.wallet,
        leg.recipient,
        fixture.review.blockhash,
        BigInt(leg.amountRaw),
      );
      const bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
      );
      const review: NativeWithdrawalReview = {
        ...fixture.review,
        id: id((item - 1) * 4 + n + 1),
        wallet: leg.wallet,
        recipient: leg.recipient,
        amount: formatNativeBalance(leg.amountRaw, 9),
        amountRaw: leg.amountRaw,
        maximumDebitRaw: (
          BigInt(leg.amountRaw) + BigInt(fixture.review.feeLamports)
        ).toString(),
        transaction: btoa(String.fromCharCode(...bytes)),
        sha256: [...digest]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      };
      await inspectNativeWithdrawal(review, review.transaction, false);
      review.funding = await selectedFundingCapture(
        saved,
        { planId: saved.id, revision: saved.revision, item, leg: n + 1 },
        review,
      );
      // Preserve exclusive wallet holds: release each unsigned fixture before reuse.
      statements.push(
        withdrawalInsert(review, 'alice'),
        context.db
          .prepare(
            "UPDATE native_withdrawals SET state='cancelled',updated_at=? WHERE id=?",
          )
          .bind(date, review.id),
      );
    }
    await context.db.batch(statements);
  }
  const firstReadStarted = performance.now();
  const history = await read();
  expect(history.progress.records).toHaveLength(400);
  expect(
    history.progress.records.map((r) => [r.funding.item, r.funding.leg]),
  ).toEqual(
    Array.from({ length: 400 }, (_, i) => [Math.floor(i / 4) + 1, (i % 4) + 1]),
  );
  expect(history.events).toHaveLength(50);
  expect(history.nextCursor).not.toBeNull();
  const firstReadMs = performance.now() - firstReadStarted;
  const olderStarted = performance.now();
  const older = await read({ cursor: history.nextCursor! });
  if (process.env.BUNDLE_FUNDING_HISTORY_CAPACITY_DIAGNOSTICS === '1') {
    const directory = new URL('../../../../work/release-qa/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL('proxy-funding-capacity-timing-20261021.json', directory),
      JSON.stringify(
        {
          rows: 400,
          fixtureMs: firstReadStarted - fixtureStarted,
          firstReadMs,
          olderReadMs: performance.now() - olderStarted,
          scope:
            'local synthetic history only, not a live latency qualification',
        },
        null,
        2,
      ),
    );
  }
  expect(older.progress.records).toHaveLength(400);
  expect(
    older.events.some((r) =>
      history.events.some((e) => e.sequence === r.sequence),
    ),
  ).toBe(false);
  expect(context.rpc).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps validated transitions when a current-revision progress root is inconsistent', async () => {
  const saved = await plan();
  const recipient = bs58.encode(new Uint8Array(32).fill(6));
  saved.document = validateFunding({
    ...saved.document,
    recipients: [
      ...saved.document.recipients,
      { address: recipient, amount: '0.01' },
    ],
  });
  await context.db
    .prepare('UPDATE funding_plans SET document=?')
    .bind(JSON.stringify(saved.document))
    .run();
  const a = await insert(1, saved);
  await transition(a, 'cancelled', null, null, null, date);
  // Synthetic legacy inconsistency: distinct valid captures under one revision.
  const changed = {
    ...saved,
    document: validateFunding({
      ...saved.document,
      name: 'Changed legacy document',
    }),
  };
  await context.db
    .prepare('UPDATE funding_plans SET document=?')
    .bind(JSON.stringify(changed.document))
    .run();
  const second = await prepareNativeWithdrawal(
    withdrawalInput(fixture.wallet, recipient, '0.01', 1),
    new AbortController().signal,
    fixture.fetcher,
  );
  await insert(2, changed, 'alice', second, 2);
  const response = await GET(request());
  expect(response.status).toBe(200);
  const history = decodeMainnetFundingHistory(
    await response.json(),
    planId,
    null,
  );
  expect(history.events).toHaveLength(3);
  expect(history.progress).toEqual({
    revision: 1,
    records: null,
    unavailable: true,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps validated transitions when only the progress SELECT fails', async () => {
  const saved = await plan();
  await insert(1, saved);
  const actual = context.db;
  context.db = {
    prepare(sql: string) {
      if (sql.includes('MAX(last.sequence)'))
        return {
          bind: () => ({
            all: async () => {
              throw new Error('private progress-store detail');
            },
          }),
        } as unknown as D1PreparedStatement;
      return actual.prepare(sql);
    },
  } as D1Database;
  try {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    const history = decodeMainnetFundingHistory(body, planId, null);
    expect(history.events).toHaveLength(1);
    expect(history.progress.records).toBeNull();
    expect(history.progress.unavailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('private progress-store');
  } finally {
    context.db = actual;
  }
});
async function transition(
  review: NativeWithdrawalReview,
  state: string,
  signature: string | null = null,
  receipt: NativeWithdrawalReceipt | null = null,
  failure: unknown = null,
  recordedAt = new Date().toISOString(),
) {
  await context.db
    .prepare(
      'UPDATE native_withdrawals SET state=?,signature=?,receipt=?,failure_receipt=?,updated_at=? WHERE id=?',
    )
    .bind(
      state,
      signature,
      receipt ? JSON.stringify(receipt) : null,
      failure ? JSON.stringify(failure) : null,
      recordedAt,
      review.id,
    )
    .run();
}
async function finalized(review: NativeWithdrawalReview) {
  const result = await decodeNativeWithdrawalReceipt(
    fixture.receipt,
    review,
    fixture.signed.signature,
  );
  if ('failed' in result)
    throw new Error('Expected synthetic success receipt.');
  await transition(review, 'signing');
  await transition(review, 'signed', fixture.signed.signature);
  await transition(review, 'submitted', fixture.signed.signature);
  await transition(review, 'finalized', fixture.signed.signature, result);
}
const request = (extra: Record<string, string> = {}) =>
  new Request(
    'http://localhost/api/funding/mainnet-history?' +
      new URLSearchParams({ id: planId, ...extra }),
  );
const read = async (extra: Record<string, string> = {}) => {
  const response = await GET(request(extra));
  expect(response.status).toBe(200);
  const history = decodeMainnetFundingHistory(
    await response.json(),
    planId,
    extra.revision ? Number(extra.revision) : null,
  );
  if (history.progress.unavailable)
    throw new Error('Expected available fixture progress.');
  return { ...history, progress: history.progress };
};
it('requires owner access, rejects cross-plan/revision cursors and never calls a provider', async () => {
  const saved = await plan();
  await insert(1, saved);
  context.user = null;
  expect((await GET(request())).status).toBe(401);
  context.user = { userId: 'bob' };
  expect((await GET(request())).status).toBe(404);
  context.user = { userId: 'alice' };
  const invalidContexts: Record<string, string>[] = [
    { id: 'bad/id' },
    { revision: '0' },
    { cursor: mainnetFundingHistoryCursor('other-plan', null, 1) },
    { revision: '1', cursor: mainnetFundingHistoryCursor(planId, null, 1) },
    { cursor: mainnetFundingHistoryCursor(planId, null, 99999) },
  ];
  for (const extra of invalidContexts)
    expect((await GET(request(extra))).status).toBe(400);
  await read();
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps immutable pre-outcome states separate from exact finalized delivery and strips packet fields', async () => {
  const saved = await plan();
  const review = await insert(1, saved);
  await finalized(review);
  const page = await read();
  expect(page.events.map((event) => event.state)).toEqual([
    'finalized',
    'submitted',
    'signed',
    'signing',
    'awaiting_signature',
  ]);
  expect(page.events.slice(1).every((event) => event.receipt === null)).toBe(
    true,
  );
  expect(page.events[0].receipt).toMatchObject({
    deliveredRaw: '10000000',
    networkFeeLamports: '5000',
  });
  expect(page.progress.records).toHaveLength(1);
  expect(page.progress.records[0].state).toBe('finalized');
  const text = JSON.stringify(page);
  for (const forbidden of [
    'transaction',
    'blockhash',
    'sha256',
    'lastValidBlockHeight',
    'document',
    'signedTransaction',
  ])
    expect(text).not.toContain('"' + forbidden + '"');
  expect(text).not.toContain(review.transaction);
  expect(fetch).not.toHaveBeenCalled();
});
it('reads historical revisions after editing and archiving the mutable plan and exposes unresolved recipient progress', async () => {
  const saved = await plan();
  const older = await insert(1, saved);
  await finalized(older);
  await context.db
    .prepare(
      "UPDATE funding_plans SET revision=2,document=json_set(document,'$.name','Edited funding')",
    )
    .run();
  const revised = {
    ...saved,
    revision: 2,
    document: { ...saved.document, name: 'Edited funding' },
  };
  const pending = await insert(2, revised);
  await transition(pending, 'signing');
  await context.db.prepare('UPDATE funding_plans SET archived=1').run();
  const all = await read();
  expect(all.currentRevision).toBe(2);
  expect(all.archived).toBe(true);
  expect(all.name).toBe('Edited funding');
  expect(
    all.events.some(
      (event) =>
        event.funding.revision === 1 &&
        event.receipt?.deliveredRaw === '10000000',
    ),
  ).toBe(true);
  expect(all.progress.records[0]).toMatchObject({
    state: 'signing',
    funding: { revision: 2 },
    receipt: null,
  });
  const history = await read({ revision: '1' });
  expect(history.events.every((event) => event.funding.revision === 1)).toBe(
    true,
  );
  expect(history.progress.records[0].state).toBe('finalized');
});
it('paginates equal-time transitions without repeats and chooses the latest attempt per recipient', async () => {
  const saved = await plan();
  for (let n = 1; n <= 28; n++) {
    const review = await insert(n, saved);
    await transition(review, 'cancelled', null, null, null, date);
  }
  const first = await read();
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const second = await read({ cursor: first.nextCursor! });
  expect(second.events).toHaveLength(6);
  expect(second.nextCursor).toBeNull();
  const sequences = [...first.events, ...second.events].map(
    (event) => event.sequence,
  );
  expect(new Set(sequences).size).toBe(56);
  expect(first.progress.records).toHaveLength(1);
  expect(first.progress.records[0]).toMatchObject({
    withdrawalId: id(28),
    state: 'cancelled',
  });
});
it('separates multiple saved recipients and excludes allocations without retained attempts from progress', async () => {
  const saved = await plan();
  const secondRecipient = bs58.encode(new Uint8Array(32).fill(4));
  saved.document = validateFunding({
    ...saved.document,
    recipients: [
      ...saved.document.recipients,
      { address: secondRecipient, amount: '0.01' },
      { address: bs58.encode(new Uint8Array(32).fill(5)), amount: '0.01' },
    ],
  });
  await context.db
    .prepare('UPDATE funding_plans SET document=?')
    .bind(JSON.stringify(saved.document))
    .run();
  const first = await insert(1, saved);
  await finalized(first);
  const secondReview = await prepareNativeWithdrawal(
    withdrawalInput(fixture.wallet, secondRecipient, '0.01', 1),
    AbortSignal.timeout(10000),
    fixture.fetcher,
  );
  await insert(2, saved, 'alice', secondReview, 2);
  const page = await read();
  expect(
    page.progress.records.map((value) => [
      value.funding.item,
      value.state,
      value.recipient,
    ]),
  ).toEqual([
    [1, 'finalized', fixture.recipient],
    [2, 'awaiting_signature', secondRecipient],
  ]);
  expect(
    page.events.find((value) => value.funding.item === 2)?.receipt,
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('does not project later failure enrichment into an earlier failed transition', async () => {
  const saved = await plan();
  const review = await insert(1, saved);
  await transition(review, 'signing');
  await transition(review, 'signed', fixture.signed.signature);
  await transition(review, 'failed', fixture.signed.signature);
  const failure = await decodeNativeWithdrawalReceipt(
    {
      ...fixture.receipt,
      meta: {
        ...fixture.receipt.meta,
        err: 'AccountNotFound',
        postBalances: ['19995000', '0', '1'],
      },
    },
    review,
    fixture.signed.signature,
  );
  if (!('failed' in failure)) throw new Error('Expected synthetic failure.');
  await transition(review, 'failed', fixture.signed.signature, null, failure);
  const page = await read();
  const failed = page.events.filter((event) => event.state === 'failed');
  expect(failed).toHaveLength(2);
  expect(failed[0].failure).toMatchObject({
    label: 'AccountNotFound',
    networkFeeLamports: '5000',
  });
  expect(failed[1].failure).toBeNull();
  expect(failed.every((event) => event.receipt === null)).toBe(true);
});
it('retains exact Token-2022 recipient net amounts, transfer fees and account rent', async () => {
  const token = await tokenWithdrawalFixture(false, true, true, {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountRaw: 1000000n,
  });
  const saved = await plan(1, 'alice', token.review);
  const review = await insert(1, saved, 'alice', token.review);
  const receipt = await decodeTokenWithdrawalReceipt(
    token.receipt,
    review,
    token.signed.signature,
  );
  if ('failed' in receipt) throw new Error('Expected synthetic token success.');
  await transition(review, 'signing');
  await transition(review, 'signed', token.signed.signature);
  await transition(review, 'finalized', token.signed.signature, receipt);
  const page = await read();
  expect(page.events[0].receipt).toMatchObject({
    deliveredRaw: '999900',
    transferFeeRaw: '100',
    accountRentLamports: token.review.token!.accountRentLamports,
  });
  expect(page.events[0].asset).toMatchObject({
    kind: 'token',
    decimals: 6,
    mint: token.review.token!.mint,
  });
});
it('fails closed for malformed retained captures instead of returning unverified progress', async () => {
  const saved = await plan();
  const review = {
    ...fixture.review,
    id: id(1),
    funding: {
      ...(await selectedFundingCapture(
        saved,
        { planId, revision: 1, item: 1 },
        fixture.review,
      )),
      item: 101,
    },
  };
  await context.db
    .prepare(
      "INSERT INTO native_withdrawals(id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',NULL,NULL,?,?)",
    )
    .bind(
      review.id,
      'alice',
      review.wallet,
      review.walletRevision,
      JSON.stringify(review),
      date,
      date,
    )
    .run();
  expect((await GET(request())).status).toBe(503);
});
it.each(['success', 'failure'])(
  'retains captured %s state but withholds evidence observed after its transition',
  async (outcome) => {
    const saved = await plan();
    const review = await insert(1, saved);
    await transition(review, 'signing');
    await transition(review, 'signed', fixture.signed.signature);
    const raw =
      outcome === 'success'
        ? fixture.receipt
        : {
            ...fixture.receipt,
            meta: {
              ...fixture.receipt.meta,
              err: 'AccountNotFound',
              postBalances: ['19995000', '0', '1'],
            },
          };
    const decoded = await decodeNativeWithdrawalReceipt(
      raw,
      review,
      fixture.signed.signature,
    );
    const future = { ...decoded, observedAt: '2099-01-01T00:00:00.000Z' };
    if ('failed' in future)
      await transition(
        review,
        'failed',
        fixture.signed.signature,
        null,
        future,
      );
    else
      await transition(review, 'finalized', fixture.signed.signature, future);
    const history = await read();
    expect(history.events[0].state).toBe(
      outcome === 'success' ? 'finalized' : 'failed',
    );
    expect(history.events[0].receipt).toBeNull();
    expect(history.events[0].failure).toBeNull();
    expect(history.events[0].evidenceGap).toContain(
      'follows this captured transition',
    );
    expect(history.progress.records[0].evidenceGap).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(['success', 'failure'])(
  'records actual recovery %s transitions after decoded receipt observation',
  async (outcome) => {
    const saved = await plan();
    const review = await insert(1, saved);
    await transition(review, 'signing');
    await transition(review, 'signed', fixture.signed.signature);
    const raw =
      outcome === 'success'
        ? fixture.receipt
        : {
            ...fixture.receipt,
            meta: {
              ...fixture.receipt.meta,
              err: 'AccountNotFound',
              postBalances: ['19995000', '0', '1'],
            },
          };
    context.rpc.mockImplementation(async (_endpoint, method) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getTransaction') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return raw;
      }
      throw new Error('Only recovery reads permitted.');
    });
    const response = await recoverWithdrawal(
      new Request('http://localhost/api/wallet-workspace/withdrawals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'recover', id: review.id }),
      }),
    );
    expect(response.status).toBe(200);
    const history = await read();
    const result = history.events[0];
    expect(result.evidenceGap).toBeNull();
    const proof = outcome === 'success' ? result.receipt : result.failure;
    expect(proof).not.toBeNull();
    expect(Date.parse(proof!.observedAt)).toBeLessThanOrEqual(
      Date.parse(result.createdAt),
    );
    expect(context.rpc.mock.calls.map((call) => call[1])).toEqual([
      'getGenesisHash',
      'getTransaction',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(['2026-10-13T00:00:00Z', '2099-01-01T00:00:00.000Z'])(
  'rejects noncanonical or later attempt creation %s',
  async (createdAt) => {
    const saved = await plan();
    const review = {
      ...fixture.review,
      id: id(1),
      funding: await selectedFundingCapture(
        saved,
        { planId, revision: 1, item: 1 },
        fixture.review,
      ),
    };
    await context.db
      .prepare(
        "INSERT INTO native_withdrawals(id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',NULL,NULL,?,?)",
      )
      .bind(
        review.id,
        'alice',
        review.wallet,
        review.walletRevision,
        JSON.stringify(review),
        createdAt,
        date,
      )
      .run();
    expect((await GET(request())).status).toBe(503);
  },
);
