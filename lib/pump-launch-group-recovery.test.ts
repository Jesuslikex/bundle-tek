import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { signSyntheticPumpGroup } from '../test/pump-group-synthetic-signatures';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import { observePumpLaunchGroupRecovery } from './pump-launch-group-recovery';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

let f: Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>,
  signed: Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>;
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
  const keys = [
    f.fixture.f.f.payerSigner,
    f.fixture.f.f.mintSigner,
    ...f.fixture.holderSigners,
  ];
  signed = await verifyPumpLaunchGroupSignatures(
    f.review,
    await signSyntheticPumpGroup(f.review.packets, keys),
  );
}, 20000);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const last = BigInt(f.review.input.create.lastValidBlockHeight),
    floor = Math.max(
      f.review.simulation.maximumSlot,
      f.review.simulation.bankSlot,
      f.review.simulation.sourceRecheckSlot,
    );
  const receipts = signed.packets.map((p, i) => ({
    slot: (floor + 10 + i).toString(),
    transaction: [p.transaction, 'base64'],
    meta: { err: null as unknown, fee: '5000' },
  }));
  const state = {
    packets: receipts.map(() => null as unknown),
    genesis: SOLANA_MAINNET_GENESIS,
    height: (last + 33n).toString(),
    slot: (last + 2000n).toString(),
    mintSlot: (last + 2001n).toString(),
    mint: null as unknown,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getTransaction') {
      const index = signed.packets.findIndex((p) => p.signature === params[0]);
      if (index === -1) throw new Error('Unexpected transaction ID');
      return structuredClone(state.packets[index]);
    }
    if (method === 'getEpochInfo')
      return { absoluteSlot: state.slot, blockHeight: state.height };
    if (method === 'getAccountInfo')
      return { context: { slot: state.mintSlot }, value: state.mint };
    throw new Error('Unexpected group recovery RPC');
  };
  const run = (
    provider = rpc,
    evidence: typeof signed | null = signed,
    signal = new AbortController().signal,
  ) => observePumpLaunchGroupRecovery(f.review, evidence, signal, provider);
  return { state, calls, rpc, run, receipts, floor, last };
}
it('collects every exact finalized success and known fee without claiming atomicity, settlement or release', async () => {
  const t = fixture();
  t.state.packets = t.receipts;
  const result = await t.run();
  expect(result).toMatchObject({
    state: 'complete',
    receipt: {
      reviewId: f.review.id,
      contextSha256: f.review.contextSha256,
      manifestSha256: f.review.manifestSha256,
      signedGroupSha256: signed.signedGroupSha256,
      allPacketsFinalized: true,
      allPacketsSucceeded: true,
      knownNetworkFeeRaw: (5000n * BigInt(signed.packets.length)).toString(),
      networkFeeUnresolved: false,
      atomicityProven: false,
      settlementVerificationRequired: true,
      durableTransitionRequired: true,
      reservationsMustRemainHeld: true,
      executionAllowed: false,
      completeLaunch: false,
      expiry: null,
    },
  });
  expect(result.receipt.packets.map((p) => p.signature)).toEqual(
    signed.packets.map((p) => p.signature),
  );
  expect(result.receipt.packets.map((p) => p.unsignedPacketSha256)).toEqual(
    f.review.packets.map((p) => p.sha256),
  );
  expect(
    t.calls.filter((c) => c.method === 'getTransaction').map((c) => c.params),
  ).toEqual(
    signed.packets.map((p) => [
      p.signature,
      {
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 1,
      },
    ]),
  );
  expect(t.calls.filter((c) => c.method === 'getGenesisHash')).toHaveLength(2);
  expect(
    t.calls.some(
      (c) =>
        ![
          'getGenesisHash',
          'getTransaction',
          'getEpochInfo',
          'getAccountInfo',
        ].includes(c.method),
    ),
  ).toBe(false);
});
it('reports fully finalized failures with their exact fees and never treats them as completed buys', async () => {
  const t = fixture();
  t.state.packets = t.receipts.map((r) => ({
    ...r,
    meta: { err: { InstructionError: [0, 'Custom'] }, fee: '7000' },
  }));
  expect(await t.run()).toMatchObject({
    state: 'failed',
    receipt: {
      allPacketsFinalized: true,
      allPacketsSucceeded: false,
      successfulPacketCount: 0,
      knownNetworkFeeRaw: (7000n * BigInt(signed.packets.length)).toString(),
      reservationsMustRemainHeld: true,
    },
  });
});
it('retains mixed finalized successes/failures as partial and never drops a packet', async () => {
  const t = fixture();
  t.state.packets = t.receipts;
  t.receipts.at(-1)!.meta.err = 'Instruction failed';
  const r = await t.run();
  expect(r.state).toBe('partial');
  expect(r.receipt.allPacketsFinalized).toBe(true);
  expect(r.receipt.packets.at(-1)).toMatchObject({
    finalized: true,
    succeeded: false,
    networkFeeRaw: '5000',
  });
  expect(r.receipt.packets).toHaveLength(signed.packets.length);
  expect(r.receipt.reservationsMustRemainHeld).toBe(true);
});
it('preserves a non-prefix observed packet and all unknown fees/signatures without resending', async () => {
  const t = fixture();
  t.state.packets[1] = t.receipts[1];
  const r = await t.run();
  expect(r.state).toBe('partial');
  expect(r.receipt.observedPacketCount).toBe(1);
  expect(r.receipt.packets[0]).toMatchObject({
    signature: signed.packets[0].signature,
    finalized: false,
    succeeded: null,
    networkFeeRaw: null,
  });
  expect(r.receipt.packets[1]).toMatchObject({
    finalized: true,
    succeeded: true,
  });
  expect(r.receipt).toMatchObject({
    networkFeeUnresolved: true,
    knownNetworkFeeRaw: '5000',
    reservationsMustRemainHeld: true,
  });
  expect(r.receipt.reads).toBe(signed.packets.length + 4);
});
it('holds a wholly unobserved live group and does not use wall-clock review expiry as chain expiry', async () => {
  const t = fixture();
  t.state.height = t.last.toString();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.review.expiresAt) + 1);
  const r = await t.run();
  expect(r.state).toBe('pending');
  expect(r.receipt.expiry).toMatchObject({
    pastExpiryMargin: false,
    mintAbsent: null,
  });
  expect(t.calls.some((c) => c.method === 'getAccountInfo')).toBe(false);
});
it('records finalized linked expiry and absent mint while keeping all missing execution costs unresolved', async () => {
  const t = fixture(),
    r = await t.run();
  expect(r.state).toBe('expired-unobserved');
  expect(r.receipt).toMatchObject({
    networkFeeUnresolved: true,
    knownNetworkFeeRaw: '0',
    signatureKnown: true,
    reservationsMustRemainHeld: true,
    expiry: {
      lastValidBlockHeight: t.last.toString(),
      finalizedBlockHeight: (t.last + 33n).toString(),
      expiryBankSlot: t.state.slot,
      mintObservedSlot: t.state.mintSlot,
      mintAbsent: true,
      pastExpiryMargin: true,
      marginBlocks: 32,
    },
  });
  expect(t.calls.find((c) => c.method === 'getEpochInfo')?.params).toEqual([
    { commitment: 'finalized', minContextSlot: t.floor },
  ]);
  expect(t.calls.find((c) => c.method === 'getAccountInfo')?.params).toEqual([
    f.review.input.create.mint,
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: Number(t.state.slot),
    },
  ]);
});
it('uses a strict block-height margin, not elapsed time or the bank slot alone', async () => {
  const t = fixture();
  t.state.height = (t.last + 32n).toString();
  expect((await t.run()).state).toBe('pending');
  expect(t.calls.some((c) => c.method === 'getAccountInfo')).toBe(false);
});
it('keeps an expired group with a present mint unknown rather than inventing finalized creation', async () => {
  const t = fixture();
  t.state.mint = {
    owner: '11111111111111111111111111111111',
    executable: false,
    lamports: '1000000',
    data: ['', 'base64'],
  };
  const r = await t.run();
  expect(r.state).toBe('unknown');
  expect(r.receipt.expiry?.mintAbsent).toBe(false);
  expect(r.receipt.allPacketsSucceeded).toBe(false);
  expect(r.receipt.reservationsMustRemainHeld).toBe(true);
});
it('can inspect approved unregistered expiry without fabricating packet signatures or transactions', async () => {
  const t = fixture(),
    r = await t.run(t.rpc, null);
  expect(r.state).toBe('expired-unobserved');
  expect(r.receipt.signatureKnown).toBe(false);
  expect(r.receipt.signedGroupSha256).toBeNull();
  expect(
    r.receipt.packets.every(
      (p) => p.signature === null && p.signedPacketSha256 === null,
    ),
  ).toBe(true);
  expect(t.calls.some((c) => c.method === 'getTransaction')).toBe(false);
  expect(r.receipt.reads).toBe(4);
});
it('does not reinterpret partially observed expired failure and mint absence as cancellation', async () => {
  const t = fixture();
  t.receipts[0].meta.err = { InstructionError: [0, 'Custom'] };
  t.state.packets[0] = t.receipts[0];
  const r = await t.run();
  expect(r.state).toBe('partial');
  expect(r.receipt.expiry?.mintAbsent).toBe(true);
  expect(r.receipt.successfulPacketCount).toBe(0);
  expect(r.receipt.networkFeeUnresolved).toBe(true);
});
it('marks omitted finalized fee data unresolved rather than zero or an estimated simulation fee', async () => {
  const t = fixture();
  t.state.packets = t.receipts.map((r) => ({ ...r, meta: { err: null } }));
  const r = await t.run();
  expect(r.state).toBe('complete');
  expect(r.receipt.networkFeeUnresolved).toBe(true);
  expect(r.receipt.knownNetworkFeeRaw).toBe('0');
  expect(r.receipt.packets.every((p) => p.networkFeeRaw === null)).toBe(true);
});
it('rejects changed signed evidence, incomplete groups and spoofed flags before any RPC', async () => {
  const t = fixture();
  for (const kind of [
    'context',
    'digest',
    'packet',
    'missing',
    'order',
    'permission',
  ]) {
    const changed = structuredClone(signed);
    if (kind === 'context') changed.contextSha256 = '0'.repeat(64);
    if (kind === 'digest') changed.signedGroupSha256 = '0'.repeat(64);
    if (kind === 'packet')
      changed.packets[0].signedPacketSha256 = '0'.repeat(64);
    if (kind === 'missing') changed.packets.pop();
    if (kind === 'order') changed.packets.reverse();
    if (kind === 'permission')
      Object.assign(changed, { executionAllowed: true });
    await expect(t.run(t.rpc, changed)).rejects.toThrow();
  }
  expect(t.calls).toHaveLength(0);
});
it('rejects changed finalized packet bytes, encoding, slot, errors, fees and missing metadata', async () => {
  const t = fixture();
  for (const receipt of [
    undefined,
    {},
    {
      ...t.receipts[0],
      transaction: [signed.packets[1].transaction, 'base64'],
    },
    { ...t.receipts[0], transaction: [signed.packets[0].transaction, 'json'] },
    { ...t.receipts[0], slot: (t.floor - 1).toString() },
    { ...t.receipts[0], meta: {} },
    { ...t.receipts[0], meta: { err: false, fee: '1' } },
    { ...t.receipts[0], meta: { err: [], fee: '1' } },
    { ...t.receipts[0], meta: { err: null, fee: -1 } },
    { ...t.receipts[0], meta: { err: null, fee: '-1' } },
  ]) {
    t.state.packets[0] = receipt;
    await expect(t.run()).rejects.toThrow();
  }
});
it('rejects wrong or changed networks and sanitizes provider errors without a recovery fallback', async () => {
  const t = fixture();
  t.state.genesis = 'wrong';
  await expect(t.run()).rejects.toThrow('mainnet');
  t.state.genesis = SOLANA_MAINNET_GENESIS;
  await expect(
    t.run(async (method, params, signal) => {
      const r = await t.rpc(method, params, signal);
      if (method === 'getEpochInfo') t.state.genesis = 'changed';
      return r;
    }),
  ).rejects.toThrow('mainnet');
  t.state.genesis = SOLANA_MAINNET_GENESIS;
  await expect(
    t.run(async (method, params, signal) => {
      if (method === 'getTransaction')
        throw new Error('secret provider detail');
      return t.rpc(method, params, signal);
    }),
  ).rejects.toThrow('read unavailable');
});
it('requires an expiry bank at least as new as every known packet, with valid linked height and mint context', async () => {
  for (const kind of [
    'bank',
    'height',
    'mint',
    'drift',
    'missing',
    'malformed',
  ]) {
    const t = fixture();
    if (kind === 'bank') {
      t.state.packets[0] = {
        ...t.receipts[0],
        slot: (Number(t.state.slot) + 1).toString(),
      };
    }
    if (kind === 'height')
      t.state.height = (BigInt(t.state.slot) + 1n).toString();
    if (kind === 'mint')
      t.state.mintSlot = (BigInt(t.state.slot) - 1n).toString();
    if (kind === 'drift')
      t.state.mintSlot = (BigInt(t.state.slot) + 33n).toString();
    if (kind === 'missing') t.state.mint = undefined;
    if (kind === 'malformed') t.state.mint = {};
    await expect(t.run()).rejects.toThrow();
  }
});
it('holds distinct finalized slots as packet facts, without claiming a one-slot or atomic bundle', async () => {
  const t = fixture();
  t.state.packets = t.receipts.map((r, i) => ({
    ...r,
    slot: (t.floor + 10 + i * 100).toString(),
  }));
  const r = await t.run();
  expect(r.state).toBe('complete');
  expect(r.receipt.atomicityProven).toBe(false);
  expect(new Set(r.receipt.packets.map((p) => p.slot)).size).toBe(
    signed.packets.length,
  );
});
it('honors cancellation before or during reads and never returns a partially collected result', async () => {
  const t = fixture(),
    control = new AbortController();
  control.abort(new Error('Cancelled first'));
  await expect(t.run(t.rpc, signed, control.signal)).rejects.toThrow(
    'Cancelled first',
  );
  expect(t.calls).toHaveLength(0);
  const second = new AbortController();
  await expect(
    t.run(
      async (method, params, signal) => {
        const result = await t.rpc(method, params, signal);
        if (method === 'getTransaction') second.abort();
        return result;
      },
      signed,
      second.signal,
    ),
  ).rejects.toThrow();
  expect(t.calls.filter((c) => c.method === 'getTransaction')).toHaveLength(1);
});
it('terminates a non-cooperative provider at the fixed deadline without starting another observation', async () => {
  const t = fixture(),
    deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(deadline.signal);
  const provider = vi.fn<PumpLaunchRpc>(async () => new Promise(() => {}));
  const pending = t.run(provider);
  const assertion = expect(pending).rejects.toThrow('cancelled or timed out');
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1), {
    timeout: 10000,
  });
  expect(timeout).toHaveBeenCalledWith(20000);
  deadline.abort();
  await assertion;
  expect(provider).toHaveBeenCalledTimes(1);
});
