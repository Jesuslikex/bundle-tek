import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  executionLedgerFixture as fixture,
  executionManifest,
  executionHash,
  executionId,
  executionSignature,
  executionNow as t,
} from '../test/warmup-execution-ledger-fixture';
import {
  WarmupExecutionLedger,
  WARMUP_EXECUTION_MODEL_STEPS,
} from './wallet-warmup-execution-ledger';

it('books Buy -> exact linked Sell without crediting sale proceeds or rent refunds into authority', async () => {
  const f = await fixture();
  f.ready();
  f.outcome();
  expect(f.ledger.snapshot()).toMatchObject({
    completedActions: 1,
    pending: null,
    wallets: [
      {
        spentBuyLamports: '100',
        spentFeeRentLamports: '5',
        remainingBuyLamports: '0',
        remainingFeeRentLamports: '15',
      },
    ],
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(f.ledger.lot(executionId(301))).toMatchObject({
    bookedRemainingRaw: '9',
    sourceSha256: executionHash(7),
    buyActionId: 'buy',
  });
  f.time(t + 30000);
  f.ready(2);
  expect(f.ledger.snapshot().pending).toMatchObject({
    inputRaw: '9',
    lotReceiptId: executionId(301),
  });
  f.outcome(2, {
    inputRaw: '9',
    outputRaw: '500',
    networkFeeLamports: '2',
    rentDebitLamports: '1',
    rentRefundLamports: '10000',
  });
  expect(f.ledger.snapshot()).toMatchObject({
    phase: 'complete',
    completedActions: 2,
    wallets: [
      {
        spentBuyLamports: '100',
        spentFeeRentLamports: '8',
        remainingBuyLamports: '0',
        remainingFeeRentLamports: '12',
      },
    ],
  });
  expect(f.ledger.lot(executionId(301))?.bookedRemainingRaw).toBe('0');
  expect(f.ledger.outcome(executionId(302))).toMatchObject({
    disposition: 'applied',
    actionId: 'sell',
    side: 'Sell',
    lotReceiptId: executionId(301),
    authorizationId: executionId(102),
    dispatchId: executionId(202),
    sourceSha256: executionHash(7),
    inputRaw: '9',
  });
  expect(() => f.step('reserve')).toThrow();
});
it('never changes state or clock on a refused transition and requires local expectedVersion', async () => {
  const f = await fixture();
  const before = f.ledger.snapshot();
  expect(() =>
    f.ledger.apply({
      expectedRootSha256: f.ledger.snapshot().rootSha256,
      operation: 'authorize',
      now: t + 10000,
      expectedVersion: 0,
      id: executionId(9),
      packetSha256: executionHash(4),
      recheckSha256: executionHash(5),
    }),
  ).toThrow();
  expect(f.ledger.snapshot()).toEqual(before);
  f.step('reserve');
  const reserved = f.ledger.snapshot();
  expect(() =>
    f.ledger.apply({
      operation: 'stop',
      now: t,
      expectedVersion: 0,
      expectedRootSha256: f.ledger.snapshot().rootSha256,
    }),
  ).toThrow();
  expect(f.ledger.snapshot()).toEqual(reserved);
  expect(() => f.step('reserve')).toThrow();
  f.qualify();
});
it('refuses an event from another immutable root even at the same local version', async () => {
  const a = await fixture();
  const m = executionManifest();
  m.planRevision = 2;
  const b = await fixture(m);
  a.step('reserve');
  b.step('reserve');
  const before = b.ledger.snapshot();
  expect(() =>
    b.step('qualify', {
      evidenceSha256: executionHash(3),
      expectedRootSha256: a.ledger.snapshot().rootSha256,
    }),
  ).toThrow();
  expect(b.ledger.snapshot()).toEqual(before);
});
it('keeps the 30s qualification gap and three-attempt bound across unsigned cancellation', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    f.time(t + i * 30000 - (i ? 1 : 0));
    f.step('reserve');
    if (i > 0) {
      f.time(t + i * 30000 - 1);
      expect(() => f.qualify()).toThrow();
      f.time(t + i * 30000);
    }
    f.qualify();
    f.step('cancel-unsigned');
  }
  expect(f.ledger.snapshot().qualificationAttempts).toBe(3);
  expect(f.ledger.snapshot().phase).toBe('qualification-exhausted');
  expect(() => f.step('reserve')).toThrow();
});
it.each([true, false])(
  'keeps terminal observation headroom with Stop first=%s',
  async (stopFirst) => {
    const f = await fixture();
    f.step('reserve');
    while (f.ledger.snapshot().version < WARMUP_EXECUTION_MODEL_STEPS - 7)
      f.step(f.ledger.snapshot().paused ? 'resume' : 'pause');
    f.qualify();
    f.prepare();
    f.authorize();
    expect(() => f.step('pause')).toThrow();
    if (stopFirst) f.step('stop');
    f.step('unknown');
    f.step('recover-signed', {
      packetSha256: executionHash(4),
      signedPacketSha256: executionHash(6),
      signature: executionSignature(),
    });
    f.outcome();
    if (!stopFirst) f.step('stop');
    expect(f.ledger.snapshot()).toMatchObject({
      version: WARMUP_EXECUTION_MODEL_STEPS,
      completedActions: 0,
      stopped: true,
      pending: {
        state: 'held',
        outcome: { reason: 'missing-dispatch-intent' },
      },
    });
    expect(() => f.step('unknown')).toThrow();
  },
  60000,
);
it.each(['dispatch', 'held', 'unsigned'] as const)(
  'retains a %s tail at the normal-step limit',
  async (kind) => {
    const f = await fixture();
    if (kind === 'unsigned') {
      f.step('reserve');
      f.qualify();
      f.prepare();
    } else {
      f.ready();
      if (kind === 'held') f.outcome(1, { outputRaw: '0' });
    }
    while (f.ledger.snapshot().version < WARMUP_EXECUTION_MODEL_STEPS - 4)
      f.step(f.ledger.snapshot().paused ? 'resume' : 'pause');
    if (kind === 'dispatch') {
      if (f.ledger.snapshot().pending?.state !== 'unknown') f.step('unknown');
      f.outcome();
      f.step('stop');
      expect(f.ledger.snapshot()).toMatchObject({
        completedActions: 1,
        pending: null,
      });
    } else if (kind === 'unsigned') {
      f.step('cancel-unsigned');
      f.step('stop');
      expect(f.ledger.snapshot()).toMatchObject({
        pending: null,
        qualificationAttempts: 1,
        wallets: [{ heldBuyLamports: '0', heldFeeRentLamports: '0' }],
      });
    } else {
      f.step('stop');
      expect(f.ledger.snapshot()).toMatchObject({
        phase: 'held',
        pending: { outcome: { reason: 'minimum-output' } },
      });
    }
  },
  60000,
);

it('models 4800 actions and14400 qualifications including400 Buys without claiming real SQL/provider capacity', async () => {
  const m = executionManifest(),
    buy = m.actions[0],
    sell = m.actions[1];
  m.wallets = [];
  m.actions = [];
  m.savedLots = [];
  for (let w = 0; w < 20; w++) {
    const wallet = bs58.encode(new Uint8Array(32).fill(10 + w));
    m.wallets.push({
      wallet,
      revision: 1,
      maximumBuyLamports: '2000',
      maximumFeeRentLamports: '240',
    });
    for (let cycle = 0; cycle < 20; cycle++) {
      const id = `buy:${w}:${cycle}`;
      m.actions.push({
        ...buy,
        side: 'Buy',
        wallet,
        id,
        inputLamports: '100',
        maximumFeeRentLamports: '1',
      });
      m.actions.push({
        ...sell,
        side: 'Sell',
        wallet,
        id: `sell:${w}:${cycle}`,
        maximumFeeRentLamports: '1',
        source: { kind: 'action-buy', actionId: id },
      });
    }
  }
  for (let i = 0; i < 4000; i++) {
    const receiptId = executionId(10000 + i),
      wallet = m.wallets[i % 20].wallet;
    m.savedLots.push({
      receiptId,
      wallet,
      mint: sell.mint,
      tokenProgram: sell.tokenProgram,
      decimals: sell.decimals,
      remainingRaw: '1',
      sourceSha256: executionHash(10),
    });
    m.actions.push({
      ...sell,
      side: 'Sell',
      wallet,
      id: `saved-sell:${i}`,
      maximumFeeRentLamports: '1',
      source: { kind: 'saved-buy', receiptId },
    });
  }
  m.actions.forEach((a, i) => {
    a.scheduledAt = new Date(t + i * 90000).toISOString();
  });
  m.expiresAt = new Date(t + 4799 * 90000 + 300000).toISOString();
  const f = await fixture(m);
  for (let i = 0; i < 4800; i++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      f.time(t + i * 90000 + attempt * 30000);
      f.step('reserve');
      f.qualify();
      f.prepare();
      if (attempt < 2) f.step('cancel-unsigned');
    }
    f.authorize(i + 1);
    const bytes = new Uint8Array(64);
    new DataView(bytes.buffer).setUint32(0, i + 1);
    const signature = bs58.encode(bytes);
    f.step('dispatch-intent', {
      id: executionId(20000 + i),
      authorizationId: f.ledger.snapshot().pending!.authorization!.id,
      packetSha256: f.packetHash(),
      signedPacketSha256: f.signedPacketHash(),
      signature,
    });
    f.step('unknown');
    f.outcome(i + 1, {
      receiptId: executionId(30000 + i),
      signature,
      inputRaw: m.actions[i].side === 'Buy' ? '100' : i < 800 ? '9' : '1',
      outputRaw: m.actions[i].side === 'Buy' ? '9' : '1',
      networkFeeLamports: '1',
      rentDebitLamports: '0',
      rentRefundLamports: '0',
    });
  }
  const final = f.ledger.snapshot();
  expect(final).toMatchObject({
    phase: 'complete',
    completedActions: 4800,
    totalQualifications: 14400,
    version: 72000,
  });
  for (const w of final.wallets)
    expect(w).toMatchObject({
      spentBuyLamports: '2000',
      spentFeeRentLamports: '240',
      remainingBuyLamports: '0',
      remainingFeeRentLamports: '0',
    });
  expect(f.ledger.lot(executionId(13999))?.bookedRemainingRaw).toBe('0');
}, 60000);
it('keeps the original 60s qualification deadline and binds preparation and authorization hashes', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  expect(() =>
    f.step('authorize', {
      id: executionId(9),
      packetSha256: executionHash(99),
      recheckSha256: executionHash(5),
    }),
  ).toThrow();
  f.time(t + 60000);
  expect(() => f.authorize()).toThrow();
  expect(f.ledger.snapshot().pending?.qualification?.expiresAt).toBe(t + 60000);
});
it.each([4999, 5000])(
  'enforces the five-second authorization boundary at %dms',
  async (ms) => {
    const f = await fixture();
    f.step('reserve');
    f.qualify();
    f.prepare();
    f.authorize();
    f.time(t + ms);
    if (ms === 4999)
      expect(f.dispatch().pending?.state).toBe('dispatch-intent');
    else expect(() => f.dispatch()).toThrow();
  },
);
it('caps authorization to the original qualification and session deadline', async () => {
  const m = executionManifest();
  m.expiresAt = new Date(t + 59000).toISOString();
  const f = await fixture(m);
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.time(t + 58000);
  f.authorize();
  expect(f.ledger.snapshot().pending?.authorization?.expiresAt).toBe(t + 59000);
  f.time(t + 59000);
  expect(() => f.dispatch()).toThrow();
});
it.each(['pause', 'stop'] as const)(
  'retains the original hold after %s and admits only observation/recovery after expiry',
  async (control) => {
    const f = await fixture();
    f.ready();
    const original = f.ledger.snapshot().pending;
    f.step(control);
    f.time(t + 200000);
    if (f.ledger.snapshot().pending?.state !== 'unknown') f.step('unknown');
    expect(f.ledger.snapshot()).toMatchObject({
      phase: 'recovery-required',
      pending: { ...original, state: 'unknown' },
      wallets: [{ heldBuyLamports: '100', heldFeeRentLamports: '10' }],
    });
    expect(() => f.dispatch()).toThrow();
    expect(() => f.step('cancel-unsigned')).toThrow();
    f.outcome();
    expect(f.ledger.snapshot()).toMatchObject({
      completedActions: 1,
      pending: null,
    });
    expect(() => f.step('reserve')).toThrow();
  },
);
it('records late signed identity without renewing approval or allowing a send', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize();
  f.step('stop');
  f.time(t + 200000);
  f.step('unknown');
  f.step('recover-signed', {
    packetSha256: executionHash(4),
    signedPacketSha256: executionHash(6),
    signature: executionSignature(),
  });
  expect(f.ledger.snapshot().pending).toMatchObject({
    state: 'unknown',
    signed: { dispatchId: null },
    authorization: { expiresAt: t + 5000 },
  });
  expect(() => f.dispatch()).toThrow();
  f.outcome();
  expect(f.ledger.snapshot()).toMatchObject({
    completedActions: 0,
    phase: 'held',
    pending: { outcome: { reason: 'missing-dispatch-intent' } },
  });
});
it('refuses early signed recovery and retains a missing dispatch marker as held evidence', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize();
  const identity = {
    packetSha256: f.packetHash(),
    signedPacketSha256: f.signedPacketHash(),
    signature: executionSignature(),
  };
  expect(() => f.step('recover-signed', identity)).toThrow();
  f.step('unknown');
  f.step('recover-signed', identity);
  f.outcome();
  expect(f.ledger.snapshot()).toMatchObject({
    phase: 'held',
    completedActions: 0,
    heldAcquisition: { observedRaw: '9', availableRaw: '0' },
    pending: { outcome: { reason: 'missing-dispatch-intent' } },
  });
});
it('derives recovery-required status for an expired authorization and stopped dispatch without releasing holds', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize();
  expect(f.ledger.snapshot(t + 5000)).toMatchObject({
    phase: 'recovery-required',
    wallets: [{ heldBuyLamports: '100' }],
  });
  f.time(t + 5000);
  expect(() => f.dispatch()).toThrow();
  const g = await fixture();
  g.ready();
  g.step('stop');
  expect(g.ledger.snapshot()).toMatchObject({
    phase: 'recovery-required',
    pending: { state: 'dispatch-intent' },
  });
});
it('binds dispatch authorization and settlement packet identities and rejects signed-packet reuse', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize();
  expect(() =>
    f.step('dispatch-intent', {
      id: executionId(9),
      authorizationId: executionId(999),
      packetSha256: f.packetHash(),
      signedPacketSha256: f.signedPacketHash(),
      signature: executionSignature(),
    }),
  ).toThrow();
  f.dispatch();
  expect(() => f.outcome(1, { packetSha256: executionHash(999) })).toThrow();
  expect(() =>
    f.outcome(1, { signedPacketSha256: executionHash(999) }),
  ).toThrow();
  const signed = f.signedPacketHash();
  f.outcome();
  f.time(t + 30000);
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize(2);
  expect(() =>
    f.step('dispatch-intent', {
      id: executionId(202),
      authorizationId: f.ledger.snapshot().pending!.authorization!.id,
      packetSha256: f.packetHash(),
      signedPacketSha256: signed,
      signature: executionSignature(2),
    }),
  ).toThrow();
  f.dispatch(2);
});
it('keeps a pending/held Sell unavailable and reports observed partial consumption separately', async () => {
  const f = await fixture();
  f.ready();
  f.outcome();
  f.time(t + 30000);
  f.ready(2);
  expect(f.ledger.lot(executionId(301))).toMatchObject({
    bookedRemainingRaw: '9',
    heldRaw: '9',
    availableRaw: '0',
    observedConsumedRaw: '0',
  });
  f.outcome(2, { inputRaw: '8' });
  expect(f.ledger.lot(executionId(301))).toMatchObject({
    bookedRemainingRaw: '9',
    heldRaw: '9',
    availableRaw: '0',
    observedConsumedRaw: '8',
    reconciliationRequired: true,
  });
});
it('only replaces an unsigned preparation on explicit requalification and keeps its packet semantics stable', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.step('pause');
  expect(() => f.qualify()).toThrow();
  f.step('resume');
  f.advance(30000);
  f.qualify();
  expect(f.ledger.snapshot().pending?.prepared).toBeNull();
  expect(() =>
    f.step('prepare', {
      packetSha256: f.packetHash(),
      minimumOutputRaw: '2',
      qualificationEvidenceSha256:
        f.ledger.snapshot().pending!.qualification!.evidenceSha256,
    }),
  ).toThrow();
  f.prepare();
});
it('Pause -> Resume never restores a pre-pause authorization or permits another dispatch', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  f.prepare();
  f.authorize();
  f.step('pause');
  f.step('resume');
  expect(f.ledger.snapshot()).toMatchObject({
    phase: 'recovery-required',
    pending: { state: 'unknown' },
    wallets: [{ heldBuyLamports: '100' }],
  });
  expect(() => f.dispatch()).toThrow();
  expect(() => f.authorize(2)).toThrow();
  const g = await fixture();
  g.ready();
  g.step('pause');
  g.step('resume');
  expect(() => g.dispatch(2)).toThrow();
  g.outcome();
  expect(g.ledger.snapshot().completedActions).toBe(1);
});
it('distinguishes ordinary finality wait from an expired review and keeps lot status consistent', async () => {
  const f = await fixture();
  f.ready();
  expect(f.ledger.snapshot(t + 5000).phase).toBe('awaiting-outcome');
  f.outcome();
  f.time(t + 30000);
  f.ready(2);
  expect(f.ledger.snapshot(t + 35000).phase).toBe('awaiting-outcome');
  expect(
    f.ledger.lot(executionId(301), t + 35000)?.reconciliationRequired,
  ).toBe(false);
  expect(f.ledger.snapshot(t + 180000).phase).toBe('recovery-required');
  expect(
    f.ledger.lot(executionId(301), t + 180000)?.reconciliationRequired,
  ).toBe(true);
  const g = await fixture();
  g.step('reserve');
  g.qualify();
  g.prepare();
  expect(g.ledger.snapshot(t + 60000).phase).toBe('review-expired');
  expect(g.ledger.snapshot(t + 180000).phase).toBe('expired');
});
it('binds preparation, authorization and outcome to the current qualification reference', async () => {
  const f = await fixture();
  f.step('reserve');
  f.qualify();
  expect(() =>
    f.step('prepare', {
      packetSha256: f.packetHash(),
      minimumOutputRaw: '1',
      qualificationEvidenceSha256: executionHash(999),
    }),
  ).toThrow();
  f.prepare();
  f.advance(30000);
  f.step('qualify', { evidenceSha256: executionHash(42) });
  f.prepare();
  f.authorize();
  f.dispatch();
  f.outcome();
  expect(f.ledger.outcome(executionId(301))).toMatchObject({
    qualificationEvidenceSha256: executionHash(42),
    disposition: 'applied',
  });
});
it.each([
  ['input-mismatch', { inputRaw: '99' }],
  ['minimum-output', { outputRaw: '0' }],
  ['fee-rent-overrun', { networkFeeLamports: '11', rentDebitLamports: '0' }],
  ['landed-failure', { landedFailure: true, inputRaw: '0', outputRaw: '0' }],
] as const)(
  'holds %s without cursor advance, automatic release or fabricated verification',
  async (reason, change) => {
    const f = await fixture();
    f.ready();
    f.outcome(1, change);
    const s = f.ledger.snapshot();
    expect(s).toMatchObject({
      phase: 'held',
      completedActions: 0,
      pending: { outcome: { reason, sourceSha256: executionHash(7) } },
      wallets: [{ heldBuyLamports: '100' }],
    });
    expect(f.ledger.lot(executionId(301))).toBeNull();
    expect(f.ledger.outcome(executionId(301))).toMatchObject({
      disposition: 'held',
      reason,
    });
    expect(() => f.step('reserve')).toThrow();
    expect(() => f.step('cancel-unsigned')).toThrow();
    expect(() => f.outcome()).toThrow();
    if (reason === 'fee-rent-overrun')
      expect(s.wallets[0].heldFeeRentLamports).toBe('11');
  },
);
it('holds a partial linked Sell without falsely consuming the whole lot', async () => {
  const f = await fixture();
  f.ready();
  f.outcome();
  f.time(t + 30000);
  f.ready(2);
  f.outcome(2, { inputRaw: '8' });
  expect(f.ledger.snapshot()).toMatchObject({
    phase: 'held',
    completedActions: 1,
    pending: {
      lotReceiptId: executionId(301),
      inputRaw: '9',
      outcome: { reason: 'input-mismatch' },
    },
  });
  expect(f.ledger.lot(executionId(301))?.bookedRemainingRaw).toBe('9');
});
it('keeps three wallets and repeated cycles separate across interleaved Buy/Sell actions', async () => {
  const m = executionManifest(),
    buy = m.actions[0],
    sell = m.actions[1];
  m.wallets = [];
  m.actions = [];
  m.expiresAt = new Date(t + 600000).toISOString();
  for (let w = 0; w < 3; w++) {
    const wallet = bs58.encode(new Uint8Array(32).fill(10 + w));
    m.wallets.push({
      wallet,
      revision: w + 1,
      maximumBuyLamports: '200',
      maximumFeeRentLamports: '40',
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      const id = `buy:${w}:${cycle}`;
      m.actions.push({ ...buy, side: 'Buy', wallet, id, inputLamports: '100' });
      m.actions.push({
        ...sell,
        side: 'Sell',
        wallet,
        id: `sell:${w}:${cycle}`,
        source: { kind: 'action-buy', actionId: id },
      });
    }
  }
  m.actions.forEach((a, i) => {
    a.scheduledAt = new Date(t + i * 30000).toISOString();
  });
  const f = await fixture(m);
  for (let i = 0; i < m.actions.length; i++) {
    f.time(t + i * 30000);
    f.ready(i + 1);
    f.outcome(i + 1, { inputRaw: m.actions[i].side === 'Buy' ? '100' : '9' });
  }
  const s = f.ledger.snapshot();
  expect(s).toMatchObject({ phase: 'complete', completedActions: 12 });
  for (const w of s.wallets)
    expect(w).toMatchObject({
      spentBuyLamports: '200',
      spentFeeRentLamports: '20',
      heldBuyLamports: '0',
      heldFeeRentLamports: '0',
      remainingBuyLamports: '0',
      remainingFeeRentLamports: '20',
    });
  const detached = f.ledger.outcome(executionId(302))!;
  detached.inputRaw = '999';
  expect(f.ledger.outcome(executionId(302))?.inputRaw).toBe('9');
});
it('rejects duplicate signature, receipt and changed packet identity without consuming holds', async () => {
  const f = await fixture();
  f.ready();
  expect(() => f.dispatch()).toThrow();
  expect(() => f.outcome(2)).toThrow();
  f.outcome();
  f.time(t + 30000);
  f.step('reserve');
  f.qualify();
  f.prepare();
  expect(() => f.authorize(1)).toThrow();
  f.authorize(2);
  expect(() => f.dispatch(1)).toThrow();
  f.dispatch(2);
  expect(() =>
    f.outcome(2, { receiptId: executionId(301), inputRaw: '9' }),
  ).toThrow();
  expect(f.ledger.snapshot().completedActions).toBe(1);
});
it('detaches input and output objects and rejects malformed clocks and unknown fields', async () => {
  const m = executionManifest();
  const ledger = await WarmupExecutionLedger.create(m);
  m.wallets[0].maximumBuyLamports = '0';
  const snapshot = ledger.apply({
    expectedRootSha256: ledger.snapshot().rootSha256,
    operation: 'reserve',
    expectedVersion: 0,
    now: t,
  });
  snapshot.wallets[0].heldBuyLamports = '0';
  snapshot.pending!.inputRaw = '1';
  expect(ledger.snapshot().wallets[0].heldBuyLamports).toBe('100');
  expect(ledger.snapshot().pending?.inputRaw).toBe('100');
  for (const now of [t - 1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.5])
    expect(() =>
      ledger.apply({
        operation: 'stop',
        expectedVersion: 1,
        now,
        expectedRootSha256: ledger.snapshot().rootSha256,
      }),
    ).toThrow();
  expect(() =>
    ledger.apply({
      expectedRootSha256: ledger.snapshot().rootSha256,
      operation: 'stop',
      expectedVersion: 1,
      now: t,
      signingAllowed: true,
    }),
  ).toThrow();
});
