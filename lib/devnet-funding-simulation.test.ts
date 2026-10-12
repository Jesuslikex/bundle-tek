import { afterEach, expect, it, vi } from 'vitest';
import {
  blockhash,
  getBase64Encoder,
  getTransactionDecoder,
} from '@solana/kit';
import { simulateDevnetFunding } from './devnet-funding-simulation';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
import { inspectVaultDevnetTransaction } from './vault-devnet-signing';
import { operationDocument, type WalletOperation } from './wallet-operation';
import type { AppClient } from './solana-client';
import {
  receiptWallet,
  receiptRecipient,
  receiptMint,
  nativeFundingInput,
} from '../test/devnet-receipt-fixture';
afterEach(() => vi.useRealTimers());
const input = {
  wallet: receiptWallet,
  recipient: receiptRecipient,
  amount: '0.300000001',
  minimumSlot: 100n,
};
function fixture() {
  const response = (value: unknown) => ({
    send: vi.fn().mockResolvedValue(value),
  });
  const latest = response({
    context: { slot: 100n },
    value: {
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 200n,
    },
  });
  const fee = response({ context: { slot: 101n }, value: 6400n });
  const simulation = response({
    context: { slot: 101n },
    value: { err: null, unitsConsumed: 1000n, fee: 6400n },
  });
  const valid = response({ context: { slot: 102n }, value: true });
  const height = response(150n);
  const rpc = {
    getGenesisHash: vi.fn(() => response(DEVNET_GENESIS_HASH)),
    getLatestBlockhash: vi.fn(() => latest),
    getFeeForMessage: vi.fn(() => fee),
    simulateTransaction: vi.fn((_wire: string, _config: unknown) => simulation),
    isBlockhashValid: vi.fn(() => valid),
    getBlockHeight: vi.fn(() => height),
    sendTransaction: vi.fn(),
  };
  const client = { rpc, rpcSubscriptions: {} } as unknown as Pick<
    AppClient,
    'rpc' | 'rpcSubscriptions'
  >;
  return { client, rpc, latest, fee, simulation, valid, height };
}
async function inspect(wire: string, document: unknown) {
  const intent = await operationDocument(document);
  const now = new Date().toISOString();
  const op: WalletOperation = {
    id: crypto.randomUUID(),
    walletAddress: receiptWallet,
    kind: intent.kind,
    document: JSON.stringify(intent),
    state: 'awaiting_signature',
    signature: null,
    createdAt: now,
    expiresAt: now,
    armedAt: now,
    minimumSlot: 90,
    updatedAt: now,
  };
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  for (const signature of Object.values(tx.signatures))
    expect(
      signature === null ||
        new Uint8Array(signature).every((byte) => byte === 0),
    ).toBe(true);
  const reviewed = {
    ...tx,
    lifetimeConstraint: {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 200n,
    },
  };
  return inspectVaultDevnetTransaction(reviewed, op, receiptWallet);
}
it('simulates the installed SDK native funding bytes without signing or broadcasting', async () => {
  const { client, rpc } = fixture();
  expect(await simulateDevnetFunding(client, input, () => {})).toEqual({
    feeLamports: '6400',
    slot: '101',
    unitsConsumed: '1000',
  });
  expect(rpc.sendTransaction).not.toHaveBeenCalled();
  expect(rpc.simulateTransaction.mock.calls[0][1]).toMatchObject({
    sigVerify: false,
    replaceRecentBlockhash: false,
    minContextSlot: 100n,
  });
  expect(
    await inspect(rpc.simulateTransaction.mock.calls[0][0], nativeFundingInput),
  ).toMatchObject({
    kind: 'sol',
    amount: '0.300000001',
    recipient: receiptRecipient,
  });
});
it('simulates the exact saved SPL checked transfer and canonical ATA creation', async () => {
  const { client, rpc } = fixture();
  await simulateDevnetFunding(
    client,
    { ...input, amount: '0.300001', mint: receiptMint, decimals: 6 },
    () => {},
  );
  expect(
    await inspect(rpc.simulateTransaction.mock.calls[0][0], {
      kind: 'spl',
      wallet: receiptWallet,
      recipient: receiptRecipient,
      distribution: {
        wallet: receiptWallet,
        mint: receiptMint,
        recipients: [{ address: receiptRecipient, amount: '0.300001' }],
      },
      funding: { id: 'funding-test', revision: 1 },
    }),
  ).toMatchObject({
    kind: 'spl',
    amount: '0.300001',
    mint: receiptMint,
    createsAccount: true,
  });
  expect(rpc.sendTransaction).not.toHaveBeenCalled();
});
it('holds simulation failures, excessive fees, stale snapshots and expired blockhashes', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) =>
      f.fee.send.mockResolvedValue({ context: { slot: 101n }, value: null }),
    (f: ReturnType<typeof fixture>) =>
      f.fee.send.mockResolvedValue({ context: { slot: 101n }, value: 6401n }),
    (f: ReturnType<typeof fixture>) =>
      f.fee.send.mockResolvedValue({ context: { slot: 99n }, value: 6400n }),
    (f: ReturnType<typeof fixture>) =>
      f.simulation.send.mockResolvedValue({
        context: { slot: 101n },
        value: {
          err: { InstructionError: [0, { Custom: 1 }] },
          unitsConsumed: 1000n,
        },
      }),
    (f: ReturnType<typeof fixture>) =>
      f.simulation.send.mockResolvedValue({
        context: { slot: 101n },
        value: { err: null, unitsConsumed: 0n },
      }),
    (f: ReturnType<typeof fixture>) =>
      f.simulation.send.mockResolvedValue({
        context: { slot: 251n },
        value: { err: null, unitsConsumed: 1000n },
      }),
    (f: ReturnType<typeof fixture>) =>
      f.valid.send.mockResolvedValue({ context: { slot: 102n }, value: false }),
    (f: ReturnType<typeof fixture>) => f.height.send.mockResolvedValue(201n),
  ]) {
    const f = fixture();
    change(f);
    await expect(
      simulateDevnetFunding(f.client, input, () => {}),
    ).rejects.toThrow();
    expect(f.rpc.sendTransaction).not.toHaveBeenCalled();
  }
});
it('stops wrong-network and changed-review work before simulation', async () => {
  const wrong = fixture();
  wrong.rpc.getGenesisHash.mockReturnValue({
    send: vi.fn().mockResolvedValue('mainnet'),
  });
  await expect(
    simulateDevnetFunding(wrong.client, input, () => {}),
  ).rejects.toThrow('not Solana devnet');
  expect(wrong.rpc.simulateTransaction).not.toHaveBeenCalled();
  const stale = fixture();
  await expect(
    simulateDevnetFunding(stale.client, input, () => {
      throw new Error('Changed review');
    }),
  ).rejects.toThrow('Changed review');
  expect(stale.rpc.getLatestBlockhash).not.toHaveBeenCalled();
});
it('aborts a stalled provider without publishing prepared state', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.latest.send.mockImplementation(
    ({ abortSignal }) =>
      new Promise((_, reject) =>
        abortSignal.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  const result = simulateDevnetFunding(f.client, input, () => {}).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(20000);
  expect((await result).message).toContain('timed out');
  expect(f.rpc.simulateTransaction).not.toHaveBeenCalled();
});
