import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupSessionReviewFixture } from '@/test/warmup-session-review-fixture';
import { WalletWarmupSessionSequence } from './wallet-warmup-session-sequence';
import { walletWarmupSessionDigest as hash } from './wallet-warmup-session-digest';
import { replayWalletWarmupSessionJournal as replay } from './wallet-warmup-session-replay';

const start = Date.parse('2026-10-21T00:00:00.000Z');
const iso = (at = start) => new Date(at).toISOString();
async function fixture() {
  const f = warmupSessionReviewFixture(start);
  const body = f.response(start);
  const document = JSON.stringify(body);
  const anchor = {
    sourceSha256: await hash(document),
    startedAt: iso(),
    version: 0,
    headSha256: '',
  };
  anchor.headSha256 = await hash(
    JSON.stringify([
      'wallet-warmup-session-journal-v1',
      anchor.sourceSha256,
      anchor.startedAt,
    ]),
  );
  const records: string[] = [];
  async function append(operation: string, values = {}, at = start) {
    const record = JSON.stringify({
      version: anchor.version + 1,
      previousSha256: anchor.headSha256,
      at: iso(at),
      operation,
      ...values,
    });
    records.push(record);
    anchor.version++;
    anchor.headSha256 = await hash(record);
  }
  const take = new WalletWarmupSessionSequence(body, f.plan, start).beginReview(
    start,
  );
  const actionId = take.action.id;
  const settlement = {
    actionId,
    planId: f.plan.id,
    planRevision: f.plan.revision,
    wallet: take.action.wallet,
    walletRevision: take.action.walletRevision,
    mint: take.action.mint,
    receiptId: '00000000-0000-4000-8000-000000000001',
    network: 'mainnet',
    commitment: 'finalized',
    verified: true,
    networkFeeLamports: '5000',
    rentChangeLamports: '0',
    side: 'Buy',
    inputLamports: take.action.side === 'Buy' ? take.action.inputLamports : '',
    acquiredRaw: '1000',
    decimals: 6,
  };
  return {
    ...f,
    body,
    document,
    anchor,
    records,
    append,
    actionId,
    settlement,
    read: (at = start) => replay(document, f.plan, anchor, records, at),
  };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());

it('rebuilds the original empty journal without granting a mutable execution handle', async () => {
  const f = await fixture();
  const result = await f.read();
  expect(result).toMatchObject({
    version: 0,
    recoveryRequired: false,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    snapshot: { completedActions: 0, phase: 'review-required' },
  });
  expect(Object.keys(result).sort()).toEqual([
    'automaticExecutionAllowed',
    'executionAllowed',
    'headSha256',
    'recoveryRequired',
    'signingAllowed',
    'snapshot',
    'version',
  ]);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['reviewing', 'submitted', 'unknown'])(
  'holds a recovered %s action under its original identity',
  async (state) => {
    const f = await fixture();
    await f.append('begin-review', { actionId: f.actionId });
    if (state !== 'reviewing')
      await f.append('submitted', { actionId: f.actionId });
    if (state === 'unknown')
      await f.append('unknown', { actionId: f.actionId });
    const result = await f.read(start + 120000);
    expect(result).toMatchObject({
      recoveryRequired: true,
      snapshot: {
        pending: { state, action: { id: f.actionId } },
        sourceReviewFresh: false,
      },
    });
  },
);
it('records a late finalized outcome after Stop and expiry without restarting or refunding reserve', async () => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  await f.append('submitted', { actionId: f.actionId });
  await f.append('stop', {}, start + 1000);
  await f.append(
    'finalized',
    {
      actionId: f.actionId,
      settlement: { ...f.settlement, rentChangeLamports: '-30000' },
    },
    start + 70000,
  );
  const result = await f.read(start + 90000);
  expect(result).toMatchObject({
    recoveryRequired: false,
    snapshot: {
      phase: 'stopped',
      stopped: true,
      completedActions: 1,
      sourceReviewFresh: false,
      wallets: [
        {
          recordedFurtherBuySpendLamports: '1000000',
          recordedFurtherFeeRentLamports: '5000',
          remainingReserveLamports: '9995000',
        },
      ],
    },
  });
  expect(result.snapshot.sourceReviewExpiresAt).toBe(iso(start + 60000));
});
it('preserves the original next-action gap and refuses a catch-up burst', async () => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  await f.append('submitted', { actionId: f.actionId });
  await f.append(
    'finalized',
    { actionId: f.actionId, settlement: f.settlement },
    start + 1000,
  );
  expect((await f.read(start + 1001)).snapshot).toMatchObject({
    phase: 'waiting',
    nextReviewAt: iso(start + 16000),
  });
  await f.append(
    'begin-review',
    { actionId: f.body.review.actions[1].id },
    start + 15999,
  );
  await expect(f.read(start + 16000)).rejects.toThrow('Session journal');
});
it.each([
  'truncated',
  'reordered',
  'duplicate',
  'changed-bytes',
  'wrong-head',
  'wrong-source',
])('refuses %s records against the authoritative anchor', async (kind) => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  await f.append('submitted', { actionId: f.actionId });
  if (kind === 'truncated') f.records.pop();
  if (kind === 'reordered') f.records.reverse();
  if (kind === 'duplicate') f.records[1] = f.records[0];
  if (kind === 'changed-bytes') f.records[0] += ' ';
  if (kind === 'wrong-head') f.anchor.headSha256 = 'a'.repeat(64);
  if (kind === 'wrong-source') f.anchor.sourceSha256 = 'a'.repeat(64);
  await expect(f.read()).rejects.toThrow('Session journal');
});
it.each([
  'future',
  'backwards',
  'noncanonical',
  'extra-field',
  'unknown-operation',
  'wrong-action',
  'wrong-version',
])('refuses a rehashed %s transition', async (kind) => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  await f.append('submitted', { actionId: f.actionId });
  const event = JSON.parse(f.records[1]);
  if (kind === 'future') event.at = iso(start + 1);
  if (kind === 'backwards') event.at = iso(start - 1);
  if (kind === 'noncanonical') event.at = '2026-10-21T00:00:00Z';
  if (kind === 'extra-field') event.executionAllowed = true;
  if (kind === 'unknown-operation') event.operation = 'retry';
  if (kind === 'wrong-action') event.actionId = 'replacement';
  if (kind === 'wrong-version') event.version = 3;
  f.records[1] = JSON.stringify(event);
  f.anchor.headSha256 = await hash(f.records[1]);
  await expect(f.read()).rejects.toThrow('Session journal');
});
it.each([
  'unsubmitted',
  'wrong-receipt-action',
  'over-budget',
  'duplicate-finalized',
])('refuses %s settlement even with a matching journal hash', async (kind) => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  if (kind !== 'unsubmitted')
    await f.append('submitted', { actionId: f.actionId });
  const settlement = { ...f.settlement };
  if (kind === 'wrong-receipt-action') settlement.actionId = 'replacement';
  if (kind === 'over-budget') settlement.networkFeeLamports = '10000001';
  await f.append('finalized', { actionId: f.actionId, settlement });
  if (kind === 'duplicate-finalized')
    await f.append('finalized', { actionId: f.actionId, settlement });
  await expect(f.read()).rejects.toThrow('Session journal');
});
it('does not reopen a stopped session through a rehashed Resume', async () => {
  const f = await fixture();
  await f.append('pause');
  await f.append('stop');
  await f.append('resume');
  await expect(f.read()).rejects.toThrow('Session journal');
});
it('cannot move the historical start forward to renew the review deadline', async () => {
  const f = await fixture();
  f.anchor.startedAt = iso(start + 60000);
  f.anchor.headSha256 = await hash(
    JSON.stringify([
      'wallet-warmup-session-journal-v1',
      f.anchor.sourceSha256,
      f.anchor.startedAt,
    ]),
  );
  await expect(f.read(start + 120000)).rejects.toThrow('Session journal');
});
it('owns the plan and journal before asynchronous hashing', async () => {
  const f = await fixture();
  await f.append('begin-review', { actionId: f.actionId });
  const result = f.read();
  f.records.length = 0;
  f.plan.document.addresses[0] = 'changed';
  f.anchor.headSha256 = 'a'.repeat(64);
  expect((await result).snapshot.pending?.action.id).toBe(f.actionId);
});
it('bounds journal size, versions, malformed JSON and unsafe clocks', async () => {
  const f = await fixture();
  await expect(
    replay(f.document, f.plan, { ...f.anchor, version: 4097 }, [], start),
  ).rejects.toThrow();
  await expect(f.read(NaN)).rejects.toThrow();
  await expect(f.read(start - 1)).rejects.toThrow();
  await expect(
    replay(' '.repeat(4 * 1024 * 1024 + 1), f.plan, f.anchor, [], start),
  ).rejects.toThrow();
  await f.append('pause');
  f.records[0] = '{';
  f.anchor.headSha256 = await hash('{');
  await expect(f.read()).rejects.toThrow('Session journal');
});

it('replays a complete two-cycle journal with exact sell dependencies and original budgets', async () => {
  const f = await fixture();
  const live = new WalletWarmupSessionSequence(f.body, f.plan, start);
  for (let index = 0; index < 4; index++) {
    const at = start + index * 15001;
    const take = live.beginReview(at);
    const actionId = take.action.id;
    await f.append('begin-review', { actionId }, at);
    live.recordSubmission(actionId, at);
    await f.append('submitted', { actionId }, at);
    const settlement = {
      actionId,
      planId: f.plan.id,
      planRevision: f.plan.revision,
      wallet: take.action.wallet,
      walletRevision: take.action.walletRevision,
      mint: take.action.mint,
      receiptId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      network: 'mainnet',
      commitment: 'finalized',
      verified: true,
      networkFeeLamports: '5000',
      rentChangeLamports: '0',
      ...(take.action.side === 'Buy'
        ? {
            side: 'Buy',
            inputLamports: take.action.inputLamports,
            acquiredRaw: '1234',
            decimals: 6,
          }
        : {
            side: 'Sell',
            buyReceiptId: take.sellSource!.buyReceiptId,
            consumedRaw: take.sellSource!.remainingRaw,
          }),
    };
    live.recordFinalized(settlement, at);
    await f.append('finalized', { actionId, settlement }, at);
    expect((await f.read(at)).snapshot).toEqual(live.snapshot(at));
  }
  expect((await f.read(start + 120000)).snapshot).toMatchObject({
    phase: 'complete',
    completedActions: 4,
    sourceReviewFresh: false,
    wallets: [
      {
        recordedFurtherBuySpendLamports: '2000000',
        recordedFurtherFeeRentLamports: '20000',
        remainingReserveLamports: '9980000',
      },
    ],
  });
});

it('retains Pause across reload, requires explicit Resume and still refuses new work after expiry', async () => {
  const f = await fixture();
  await f.append('pause');
  expect((await f.read(start + 1000)).snapshot.phase).toBe('paused');
  await f.append('resume', {}, start + 2000);
  expect((await f.read(start + 2000)).snapshot.phase).toBe('review-required');
  expect((await f.read(start + 60000)).snapshot.phase).toBe('refresh-required');
  await f.append('begin-review', { actionId: f.actionId }, start + 60000);
  await expect(f.read(start + 60000)).rejects.toThrow('Session journal');
});

it('binds the exact source bytes and rejects a changed plan even with valid journal hashes', async () => {
  const f = await fixture();
  await expect(
    replay(f.document + ' ', f.plan, f.anchor, [], start),
  ).rejects.toThrow();
  f.plan.revision++;
  await expect(f.read()).rejects.toThrow('Session journal');
});

it('supports a canonical durable event ID inside the hashed transition without granting authority', async () => {
  const f = await fixture();
  await f.append('pause', { eventId: '00000000-0000-4000-8000-000000000001' });
  expect((await f.read()).snapshot.phase).toBe('paused');
});

it('refuses a malformed durable event ID even with a matching raw-document digest', async () => {
  const f = await fixture();
  await f.append('pause', { eventId: 'changed' });
  await expect(f.read()).rejects.toThrow('Session journal');
});
