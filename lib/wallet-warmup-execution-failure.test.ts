import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { getBase64Encoder } from '@solana/kit';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { executionAuditFixture } from '../test/warmup-execution-audit-fixture';
import {
  executionManifest,
  executionNow as t,
  executionId as id,
  executionHash as hash,
} from '../test/warmup-execution-ledger-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { parseBalanceJson } from './wallet-balances';
import {
  bindWarmupExecutionFailure,
  WARMUP_FAILURE_RECEIPT_BYTES,
} from './wallet-warmup-execution-failure';
const signal = () => new AbortController().signal;
async function fixture(
  side: 'Buy' | 'Sell' = 'Buy',
  lookup = false,
  mode = 'dispatch',
) {
  const f = await nativeWarmupFixture({ side, lookup, v2: true });
  const review: WarmupSigningReview = {
    settlement: await requireWarmupSigningReview(f.order, f.simulation),
    wallet: f.wallet,
    sha256: f.order.preparation.sha256,
    transaction: f.order.preparation.transaction,
    network: 'mainnet',
    expiresAt: f.order.expiresAt,
    maximumFeeLamports: f.simulation.networkFeeLamports,
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
    id: id(100),
    preparationId: id(101),
  };
  const m = executionManifest();
  const base = {
    id: 'action',
    wallet: f.wallet,
    mint: f.mint,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as const,
    decimals: 6,
    scheduledAt: new Date(t).toISOString(),
    maximumFeeRentLamports: '10',
  };
  m.actions =
    side === 'Buy'
      ? [
          { ...base, side, inputLamports: review.inputRaw },
          {
            ...base,
            id: 'follow-sell',
            side: 'Sell',
            maximumFeeRentLamports: '0',
            source: { kind: 'action-buy', actionId: base.id },
          },
        ]
      : [{ ...base, side, source: { kind: 'saved-buy', receiptId: id(400) } }];
  m.savedLots =
    side === 'Buy'
      ? []
      : [
          {
            receiptId: id(400),
            wallet: f.wallet,
            mint: f.mint,
            tokenProgram: base.tokenProgram,
            decimals: 6,
            remainingRaw: review.inputRaw,
            sourceSha256: hash(5),
          },
        ];
  m.wallets = [
    {
      wallet: f.wallet,
      revision: 1,
      maximumBuyLamports: side === 'Buy' ? review.inputRaw : '0',
      maximumFeeRentLamports: '10',
    },
  ];
  if (side === 'Sell' && mode === 'action-buy') {
    m.actions = [
      {
        ...base,
        id: 'previous-buy',
        side: 'Buy',
        inputLamports: '1',
        maximumFeeRentLamports: '0',
      },
      {
        ...base,
        side: 'Sell',
        source: { kind: 'action-buy', actionId: 'previous-buy' },
      },
    ];
    m.savedLots = [];
    m.wallets[0].maximumBuyLamports = '1';
  }
  const a = await executionAuditFixture(m);
  const bytes = getBase64Encoder().encode(f.signed.transaction);
  const signedHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  if (mode === 'action-buy') {
    await a.step('reserve');
    await a.step('qualify', { evidenceSha256: hash(80) });
    await a.step('prepare', {
      qualificationEvidenceSha256: hash(80),
      packetSha256: hash(81),
      minimumOutputRaw: '1',
    });
    await a.step('authorize', {
      id: id(80),
      packetSha256: hash(81),
      recheckSha256: hash(82),
    });
    const sig = bs58.encode(new Uint8Array(64).fill(8));
    await a.step('dispatch-intent', {
      id: id(81),
      authorizationId: id(80),
      packetSha256: hash(81),
      signedPacketSha256: hash(83),
      signature: sig,
    });
    await a.step('settle', {
      packetSha256: hash(81),
      signedPacketSha256: hash(83),
      receiptId: id(400),
      sourceSha256: hash(84),
      signature: sig,
      inputRaw: '1',
      outputRaw: review.inputRaw,
      networkFeeLamports: '0',
      rentDebitLamports: '0',
      rentRefundLamports: '0',
      landedFailure: false,
    });
    a.time(t + 32000);
  }
  await a.step('reserve');
  await a.step('qualify', { evidenceSha256: hash(10) });
  await a.step('prepare', {
    qualificationEvidenceSha256: hash(10),
    packetSha256: review.sha256,
    minimumOutputRaw: review.minimumOutputRaw,
  });
  await a.step('authorize', {
    id: review.id,
    packetSha256: review.sha256,
    recheckSha256: hash(11),
  });
  if (mode === 'missing-dispatch') {
    await a.step('unknown');
    await a.step('recover-signed', {
      packetSha256: review.sha256,
      signedPacketSha256: signedHash,
      signature: f.signed.signature,
    });
  } else
    await a.step('dispatch-intent', {
      id: id(200),
      authorizationId: review.id,
      packetSha256: review.sha256,
      signedPacketSha256: signedHash,
      signature: f.signed.signature,
    });
  const raw = {
    ...f.receipt,
    meta: {
      ...f.receipt.meta,
      fee: '5001',
      err: { InstructionError: [0, { Custom: 42 }] },
      postBalances: f.receipt.meta.preBalances.map((v, i) =>
        i === 0 ? (BigInt(v) - 5001n).toString() : v,
      ),
      postTokenBalances: f.receipt.meta.preTokenBalances,
    },
  };
  const context = {
    rootId: a.bound.manifest.id,
    rootSha256: a.bound.rootSha256,
    manifestSha256: a.bound.manifestSha256,
    actionId: 'action',
    actionIndex: mode === 'action-buy' ? 1 : 0,
    expectedVersion: a.ledger.snapshot().version,
    now: mode === 'action-buy' ? t + 32000 : t + 2000,
    packetSha256: review.sha256,
    signedPacketSha256: signedHash,
    authorizationId: review.id,
    dispatchId: mode === 'missing-dispatch' ? null : id(200),
    lotReceiptId: side === 'Sell' ? id(400) : null,
    signature: f.signed.signature,
    receiptId: id(300),
    inputRaw: review.inputRaw,
    minimumOutputRaw: review.minimumOutputRaw,
  };
  const wire = (value = raw) =>
    canonical(parseBalanceJson(JSON.stringify(value)));
  const bind = (
    changes: Partial<typeof context> = {},
    rawValue = wire(),
    selected = a.selector,
    selectedReview: unknown = review,
    selectedSnapshot: unknown = a.ledger.snapshot(),
  ) =>
    bindWarmupExecutionFailure(
      a.bound.root,
      a.approval,
      selected,
      { ...context, ...changes },
      selectedReview,
      selectedSnapshot,
      rawValue,
      signal(),
    );
  return { f, a, raw, review, context, wire, bind };
}
it.each([
  ['Buy', false],
  ['Buy', true],
  ['Sell', false],
  ['Sell', true],
] as const)(
  'binds exact signed %s failure lookup=%s and retains held actual exposure',
  async (side, lookup) => {
    const f = await fixture(side, lookup),
      before = f.a.ledger.snapshot();
    const result = await f.bind();
    expect(result).toMatchObject({
      scope: 'failure-bookkeeping-candidate-only',
      receiptProvenanceVerified: false,
      networkProvenanceVerified: false,
      finalityProvenanceVerified: false,
      currentHeadVerified: false,
      financialReservationVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(result.event).toMatchObject({
      inputRaw: '0',
      outputRaw: '0',
      rentDebitLamports: '0',
      rentRefundLamports: '0',
      networkFeeLamports: '5001',
      landedFailure: true,
    });
    expect(result.evidence.observation.reviewedFeeLimitExceeded).toBe(true);
    expect(result.evidence).not.toHaveProperty('observedAt');
    f.a.ledger.apply(result.event);
    expect(f.a.ledger.snapshot()).toMatchObject({
      phase: 'held',
      completedActions: 0,
      pending: { state: 'held' },
      wallets: [
        {
          spentBuyLamports: '0',
          spentFeeRentLamports: '0',
          heldFeeRentLamports: '5001',
          remainingFeeRentLamports: '-4991',
        },
      ],
    });
    expect(f.a.ledger.snapshot().wallets[0].heldBuyLamports).toBe(
      before.wallets[0].heldBuyLamports,
    );
    expect(f.a.ledger.outcome(f.context.receiptId)).toMatchObject({
      disposition: 'held',
      reason: 'landed-failure',
    });
    if (side === 'Sell')
      expect(f.a.ledger.lot(id(400))).toMatchObject({
        bookedRemainingRaw: f.review.inputRaw,
        availableRaw: '0',
        reconciliationRequired: true,
      });
    expect(() => f.a.ledger.apply(result.event)).toThrow();
  },
);
it('recovers after Stop and original approval/session expiry without renewed authority', async () => {
  const f = await fixture();
  f.a.time(t + 3000);
  await f.a.step('stop');
  const result = await f.bind({
    now: t + 180001,
    expectedVersion: f.a.ledger.snapshot().version,
  });
  f.a.ledger.apply(result.event);
  expect(f.a.ledger.snapshot()).toMatchObject({
    stopped: true,
    phase: 'held',
    completedActions: 0,
  });
});
it('retains missing-dispatch priority for an unknown signed packet instead of fabricating a dispatch', async () => {
  const f = await fixture('Buy', true, 'missing-dispatch'),
    result = await f.bind();
  f.a.ledger.apply(result.event);
  expect(f.a.ledger.outcome(f.context.receiptId)).toMatchObject({
    disposition: 'held',
    reason: 'missing-dispatch-intent',
    dispatchId: null,
  });
});
it.each([
  'rootSha256',
  'manifestSha256',
  'packetSha256',
  'signedPacketSha256',
  'actionId',
  'authorizationId',
  'inputRaw',
  'minimumOutputRaw',
  'lotReceiptId',
] as const)('refuses changed independent %s', async (key) => {
  const f = await fixture();
  const value =
    key === 'actionId'
      ? 'different'
      : key === 'authorizationId' || key === 'lotReceiptId'
        ? id(900)
        : key === 'inputRaw' || key === 'minimumOutputRaw'
          ? '999999'
          : hash(999);
  await expect(f.bind({ [key]: value })).rejects.toThrow(
    'Exact original warmup failure',
  );
});
it('refuses successful, contradictory native/token rollback, wrong signature and changed lookup metadata', async () => {
  const f = await fixture('Buy', true);
  for (const change of ['success', 'native', 'tokens', 'lookup']) {
    const raw = structuredClone(f.raw);
    if (change === 'success') raw.meta.err = null as never;
    if (change === 'native')
      raw.meta.postBalances[1] = (
        BigInt(raw.meta.postBalances[1]) + 1n
      ).toString();
    if (change === 'tokens')
      raw.meta.postTokenBalances = structuredClone(
        f.f.receipt.meta.postTokenBalances,
      );
    if (change === 'lookup')
      raw.meta.loadedAddresses = { writable: [], readonly: [] };
    await expect(f.bind({}, f.wire(raw))).rejects.toThrow();
  }
  await expect(f.bind({ signature: '1'.repeat(64) })).rejects.toThrow();
});
it('refuses malformed, oversized, noncanonical and trailing packet evidence without partial output', async () => {
  const f = await fixture();
  for (const wire of [
    '{',
    ' ' + f.wire(),
    'x'.repeat(WARMUP_FAILURE_RECEIPT_BYTES + 1),
  ])
    await expect(f.bind({}, wire)).rejects.toThrow();
  const raw = structuredClone(f.raw);
  raw.transaction[0] += 'AAAA';
  await expect(f.bind({}, f.wire(raw))).rejects.toThrow();
});
it('binds original raw evidence deterministically without retaining current decoder time/provider labels', async () => {
  const f = await fixture(),
    first = await f.bind();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    expect(new Date().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    const next = await f.bind();
    expect(next.sourceSha256).toBe(first.sourceSha256);
    expect(next.evidence).toEqual(first.evidence);
    expect(next.evidence.observation).not.toHaveProperty('observedAt');
    expect(next.evidence.observation).not.toHaveProperty('source');
  } finally {
    vi.useRealTimers();
  }
  const raw = structuredClone(f.raw);
  Object.assign(raw.meta, { logMessages: ['changed retained material'] });
  expect((await f.bind({}, f.wire(raw))).sourceSha256).not.toBe(
    first.sourceSha256,
  );
});
it('retains fee exposure above the JavaScript safe integer without changing the original spending budget', async () => {
  const f = await fixture(),
    raw = structuredClone(f.raw);
  const fee = 9007199254740993n,
    before = (1n << 64n) - 1n;
  raw.meta.fee = fee.toString();
  raw.meta.preBalances[0] = before.toString();
  raw.meta.postBalances[0] = (before - fee).toString();
  const result = await f.bind({}, f.wire(raw));
  expect(result.event.networkFeeLamports).toBe(fee.toString());
  f.a.ledger.apply(result.event);
  expect(f.a.ledger.snapshot().wallets[0]).toMatchObject({
    spentFeeRentLamports: '0',
    heldFeeRentLamports: fee.toString(),
    remainingFeeRentLamports: (10n - fee).toString(),
  });
});
it('refuses missing token metadata, changed token ownership and a mismatched saved Sell lot', async () => {
  const f = await fixture('Sell', true),
    raw = structuredClone(f.raw);
  await expect(f.bind({ lotReceiptId: id(999) })).rejects.toThrow();
  delete (raw.meta as { preTokenBalances?: unknown }).preTokenBalances;
  await expect(f.bind({}, f.wire(raw))).rejects.toThrow();
  const changed = structuredClone(f.raw);
  changed.meta.postTokenBalances = structuredClone(
    changed.meta.postTokenBalances,
  );
  changed.meta.postTokenBalances[0].owner = f.f.mint;
  await expect(f.bind({}, f.wire(changed))).rejects.toThrow();
});
it('preserves caller cancellation and never treats context-supplied authority flags as approval', async () => {
  const f = await fixture(),
    c = new AbortController(),
    reason = Error('cancelled');
  c.abort(reason);
  await expect(
    bindWarmupExecutionFailure(
      f.a.bound.root,
      f.a.approval,
      f.a.selector,
      f.context,
      f.review,
      f.a.ledger.snapshot(),
      f.wire(),
      c.signal,
    ),
  ).rejects.toBe(reason);
  await expect(f.bind({ executionAllowed: true } as never)).rejects.toThrow();
});
it.each([
  'dispatch',
  'version',
  'cursor',
  'action',
  'root',
  'authorization',
  'packet',
  'signedPacket',
  'signature',
  'lot',
  'input',
  'minimum',
  'qualification',
  'extra',
] as const)(
  'refuses a changed independently selected pending snapshot: %s',
  async (change) => {
    const f = await fixture('Sell', true),
      snapshot = structuredClone(f.a.ledger.snapshot());
    const p = snapshot.pending!;
    if (change === 'dispatch') p.signed!.dispatchId = id(999);
    if (change === 'version') snapshot.version++;
    if (change === 'cursor') snapshot.completedActions++;
    if (change === 'action') p.actionId = 'other';
    if (change === 'root') snapshot.rootSha256 = hash(999);
    if (change === 'authorization') p.authorization!.id = id(999);
    if (change === 'packet') p.prepared!.packetSha256 = hash(999);
    if (change === 'signedPacket') p.signed!.signedPacketSha256 = hash(999);
    if (change === 'signature')
      p.signed!.signature = bs58.encode(new Uint8Array(64).fill(9));
    if (change === 'lot') p.lotReceiptId = id(999);
    if (change === 'input') p.inputRaw = '999';
    if (change === 'minimum') p.prepared!.minimumOutputRaw = '999';
    if (change === 'qualification')
      p.authorization!.qualificationEvidenceSha256 = hash(999);
    if (change === 'extra')
      Object.assign(snapshot, { currentHeadVerified: true });
    await expect(
      f.bind({}, f.wire(), f.a.selector, f.review, snapshot),
    ).rejects.toThrow();
  },
);
it('refuses forged dispatch/version context even when the rest of the root and signed receipt agree', async () => {
  const f = await fixture();
  await expect(f.bind({ dispatchId: id(999) })).rejects.toThrow();
  await expect(
    f.bind({ expectedVersion: f.context.expectedVersion + 1 }),
  ).rejects.toThrow();
});
it('retains a failed Sell against its actual prior action-Buy lot without consuming it', async () => {
  const f = await fixture('Sell', true, 'action-buy'),
    before = f.a.ledger.snapshot();
  expect(before.completedActions).toBe(1);
  const result = await f.bind();
  f.a.ledger.apply(result.event);
  expect(f.a.ledger.snapshot()).toMatchObject({
    phase: 'held',
    completedActions: 1,
  });
  expect(f.a.ledger.lot(id(400))).toMatchObject({
    bookedRemainingRaw: f.review.inputRaw,
    availableRaw: '0',
    buyActionId: 'previous-buy',
    reconciliationRequired: true,
  });
});
it('refuses a valid-length single-byte signature mutation after context and selected signature agree', async () => {
  const f = await fixture(),
    bytes = bs58.decode(f.context.signature);
  bytes[0] ^= 1;
  const signature = bs58.encode(bytes),
    snapshot = structuredClone(f.a.ledger.snapshot());
  snapshot.pending!.signed!.signature = signature;
  expect(bs58.decode(signature)).toHaveLength(64);
  await expect(
    f.bind({ signature }, f.wire(), f.a.selector, f.review, snapshot),
  ).rejects.toThrow();
});
