import { afterEach, expect, it, vi } from 'vitest';
import { observePumpLaunchRecovery } from './pump-launch-recovery';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

afterEach(() => {
  vi.restoreAllMocks();
});
function fixture() {
  const verifySigned = vi.fn(async (packet: string) =>
    packet === 'exact-signed-packet' ? 'signature' : 'wrong',
  );
  const input = {
    minimumSlot: 100,
    mint: 'So11111111111111111111111111111111111111112',
    lastValidBlockHeight: '1000',
    signed: 'exact-signed-packet' as string | null,
    signature: 'signature' as string | null,
    verifySigned,
  };
  const state = {
    receipt: null as unknown,
    height: '1033',
    slot: '2000',
    mintSlot: '2001',
    mint: null as unknown,
    genesis: SOLANA_MAINNET_GENESIS,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getTransaction') return state.receipt;
    if (method === 'getEpochInfo')
      return { absoluteSlot: state.slot, blockHeight: state.height };
    if (method === 'getAccountInfo')
      return { context: { slot: state.mintSlot }, value: state.mint };
    throw new Error('Unexpected recovery RPC');
  };
  const run = (provider = rpc, signal = new AbortController().signal) =>
    observePumpLaunchRecovery(input, signal, provider);
  const receipt = () => ({
    slot: '2000',
    transaction: [input.signed, 'base64'],
    meta: { err: null, fee: '20000' },
  });
  return { input, state, calls, rpc, run, receipt };
}
it('links finalized expiry to a subsequent bounded mint absence read and retains unresolved fees', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    state: 'cancelled',
    receipt: {
      kind: 'expired-unobserved',
      signatureKnown: true,
      networkFeeUnresolved: true,
      finalizedBlockHeight: '1033',
      expiryBankSlot: '2000',
      mintObservedSlot: '2001',
      mintAbsent: true,
      mint: f.input.mint,
    },
  });
  expect(f.calls.map((c) => c.method)).toEqual([
    'getGenesisHash',
    'getTransaction',
    'getEpochInfo',
    'getAccountInfo',
    'getGenesisHash',
  ]);
  expect(f.calls.find((c) => c.method === 'getEpochInfo')?.params).toEqual([
    { commitment: 'finalized', minContextSlot: 100 },
  ]);
  expect(f.calls.find((c) => c.method === 'getAccountInfo')?.params).toEqual([
    f.input.mint,
    { encoding: 'base64', commitment: 'finalized', minContextSlot: 2000 },
  ]);
});
it('holds before the strict expiry margin and while the mint remains present', async () => {
  const f = fixture();
  f.state.height = '1032';
  expect(await f.run()).toEqual({ state: 'pending', receipt: null });
  expect(f.calls.some((c) => c.method === 'getAccountInfo')).toBe(false);
  f.state.height = '1033';
  f.state.mint = {};
  expect(await f.run()).toEqual({ state: 'pending', receipt: null });
});
it('can recover an approved unregistered packet without inventing a signature', async () => {
  const f = fixture();
  f.input.signed = null;
  f.input.signature = null;
  expect(await f.run()).toMatchObject({
    state: 'cancelled',
    receipt: {
      signature: null,
      signatureKnown: false,
      networkFeeUnresolved: true,
    },
  });
  expect(f.input.verifySigned).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.method === 'getTransaction')).toBe(false);
});
it('requires the exact saved finalized packet and revalidates its signature', async () => {
  const f = fixture();
  f.state.receipt = f.receipt();
  expect(await f.run()).toMatchObject({
    state: 'finalized',
    receipt: {
      kind: 'finalized',
      succeeded: true,
      networkFeeUnresolved: false,
      networkFeeRaw: '20000',
    },
  });
  expect(f.input.verifySigned).toHaveBeenCalledTimes(2);
  expect(f.calls.map((c) => c.method)).toEqual([
    'getGenesisHash',
    'getTransaction',
    'getGenesisHash',
  ]);
});
it('records a matching finalized failure without assuming a missing network fee is zero', async () => {
  const f = fixture();
  f.state.receipt = {
    ...f.receipt(),
    meta: { err: { InstructionError: ['1', 'Custom'] } },
  };
  const result = await f.run();
  expect(result).toMatchObject({
    state: 'failed',
    receipt: { succeeded: false, networkFeeUnresolved: true },
  });
  expect(result.receipt).not.toHaveProperty('networkFeeRaw');
});
it('rejects missing or mismatched saved signatures before provider access', async () => {
  for (const patch of [
    { signed: null },
    { signature: null },
    { signed: 'different' },
  ]) {
    const f = fixture();
    Object.assign(f.input, patch);
    await expect(f.run()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});
it('rejects malformed or mismatched finalized receipts without falling through to cancellation', async () => {
  for (const patch of [
    { transaction: ['wrong', 'base64'] },
    { transaction: ['exact-signed-packet', 'json'] },
    { transaction: ['exact-signed-packet', 'base64', 'extra'] },
    { meta: {} },
    { meta: { err: false } },
    { meta: { err: [] } },
    { meta: { err: null, fee: '-1' } },
    { slot: '99' },
    { slot: '9007199254740992' },
    { slot: 2000 },
  ]) {
    const f = fixture();
    f.state.receipt = { ...f.receipt(), ...patch };
    await expect(f.run()).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'getEpochInfo')).toBe(false);
  }
});
it('rejects stale, impossible or excessively separated finalized expiry observations', async () => {
  for (const patch of [
    { slot: '99' },
    { height: '2001' },
    { mintSlot: '1999' },
    { mintSlot: '2033' },
    { mintSlot: '9007199254740992' },
  ]) {
    const f = fixture();
    Object.assign(f.state, patch);
    await expect(f.run()).rejects.toThrow();
  }
});
it('keeps malformed provider observations unresolved', async () => {
  for (const [method, value] of [
    ['getTransaction', undefined],
    ['getEpochInfo', { absoluteSlot: '2000' }],
    ['getAccountInfo', { context: { slot: '2001' } }],
    ['getAccountInfo', { value: null }],
  ] as const) {
    const f = fixture();
    await expect(
      f.run((m, p, a) =>
        m === method ? Promise.resolve(value) : f.rpc(m, p, a),
      ),
    ).rejects.toThrow();
  }
});
it('requires mainnet again after receipt, expiry and pending observations', async () => {
  for (const kind of ['receipt', 'expired', 'pending']) {
    const f = fixture();
    if (kind === 'receipt') f.state.receipt = f.receipt();
    if (kind === 'pending') f.state.height = '1032';
    let genesis = 0;
    await expect(
      f.run((m, p, a) =>
        m === 'getGenesisHash'
          ? Promise.resolve(++genesis === 1 ? SOLANA_MAINNET_GENESIS : 'wrong')
          : f.rpc(m, p, a),
      ),
    ).rejects.toThrow('not Solana mainnet');
  }
});
it('honors cancellation even when an injected provider ignores the abort signal', async () => {
  const f = fixture(),
    controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = f.run(async () => {
    entered();
    return new Promise(() => {});
  }, controller.signal);
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled or timed out');
});
it('applies its 20-second deadline even to a non-cooperative provider', async () => {
  const f = fixture(),
    controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = f.run(async () => {
    entered();
    return new Promise(() => {});
  });
  await ready;
  expect(timeout).toHaveBeenCalledWith(20000);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled or timed out');
});
it('does not reflect provider secrets in read failures', async () => {
  const f = fixture();
  await expect(
    f.run(async () => {
      throw new Error('SECRET_URL');
    }),
  ).rejects.toThrow('Launch recovery read unavailable.');
});
