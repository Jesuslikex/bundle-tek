import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  decodeTrackedTransaction,
  observeTrackedTransaction,
  transactionSignature,
} from './tracked-wallet-transaction';
import { signedBalanceAmount } from './wallet-balance-format';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const wallet = address(1),
  account = address(2),
  program = address(3),
  mint = address(4),
  other = address(5);
const signature = bs58.encode(new Uint8Array(64).fill(1));
const balance = (amount: string, owner = wallet, index = '1') => ({
  accountIndex: index,
  mint,
  owner,
  programId: program,
  uiTokenAmount: { amount, decimals: '9', uiAmount: 123 },
});
function transaction() {
  return {
    slot: '300',
    blockTime: null,
    version: '0',
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [wallet, account, program, other].map((pubkey, i) => ({
          pubkey,
          signer: i === 0,
          writable: i < 2,
          source: i === 1 ? 'lookupTable' : 'transaction',
        })),
        instructions: [{ programId: program }],
      },
    },
    meta: {
      err: null,
      fee: '5000',
      preBalances: ['9007199254740993', '100', '0', '0'],
      postBalances: ['9007199254735993', '100', '0', '0'],
      preTokenBalances: [balance('9007199254740993')],
      postTokenBalances: [balance('9007199254740992')],
      innerInstructions: [
        { index: '0', instructions: [{ programId: program }] },
      ],
    },
  };
}
it('preserves exact amounts, lookup account ordering and signed subunit deltas', () => {
  expect(
    decodeTrackedTransaction(transaction(), wallet, signature),
  ).toMatchObject({
    nativeChangeRaw: '-5000',
    feeRaw: '5000',
    feePayer: wallet,
    walletSigner: true,
    programs: [program],
    tokensComplete: true,
    innerInstructionsAvailable: true,
    tokenChanges: [
      {
        beforeRaw: '9007199254740993',
        afterRaw: '9007199254740992',
        changeRaw: '-1',
        accounts: [account],
      },
    ],
  });
  expect(signedBalanceAmount('-1', 9)).toBe('-0.000000001');
  expect(signedBalanceAmount('123', 0)).toBe('+123');
  expect(signedBalanceAmount('0', 9)).toBe('0');
});
it('handles token creation, closure and ownership changes without counting other owners', () => {
  const tx = transaction();
  tx.meta.preTokenBalances = [balance('10'), balance('100', other, '3')];
  tx.meta.postTokenBalances = [balance('12', wallet, '3')];
  expect(
    decodeTrackedTransaction(tx, wallet, signature).tokenChanges[0],
  ).toMatchObject({
    beforeRaw: '10',
    afterRaw: '12',
    changeRaw: '2',
    accounts: [account, other],
  });
});
it('aggregates several owned token accounts without Number rounding', () => {
  const tx = transaction();
  tx.meta.preTokenBalances.push(balance('9007199254740993', wallet, '3'));
  tx.meta.postTokenBalances.push(balance('9007199254740994', wallet, '3'));
  expect(
    decodeTrackedTransaction(tx, wallet, signature).tokenChanges[0],
  ).toMatchObject({
    beforeRaw: '18014398509481986',
    afterRaw: '18014398509481986',
    changeRaw: '0',
    accounts: [account, other],
  });
});
it('attributes token owners absent from the native account list without inventing a native change', () => {
  const tx = transaction();
  tx.meta.preTokenBalances = [balance('2', address(6))];
  tx.meta.postTokenBalances = [balance('3', address(6))];
  expect(decodeTrackedTransaction(tx, address(6), signature)).toMatchObject({
    walletSigner: false,
    nativeChangeRaw: null,
    tokenChanges: [{ changeRaw: '1' }],
  });
});
it('withholds token deltas when metadata or ownership/program attribution is incomplete', () => {
  for (const patch of [
    { preTokenBalances: null },
    { postTokenBalances: null },
    { postTokenBalances: [{ ...balance('2'), owner: undefined }] },
    { preTokenBalances: [{ ...balance('2'), programId: undefined }] },
  ]) {
    const tx = transaction();
    Object.assign(tx.meta, patch);
    expect(decodeTrackedTransaction(tx, wallet, signature)).toMatchObject({
      tokensComplete: false,
      tokenChanges: [],
    });
  }
});
it('distinguishes failed transactions and absent inner records', () => {
  const tx = transaction();
  Object.assign(tx.meta, {
    err: { InstructionError: ['0', 'Custom'] },
    innerInstructions: null,
  });
  expect(decodeTrackedTransaction(tx, wallet, signature)).toMatchObject({
    failed: true,
    innerInstructionsAvailable: false,
  });
});
it('rejects mismatched signatures, unrelated wallets, duplicate accounts and malformed metadata', () => {
  expect(() => transactionSignature('2'.repeat(64))).toThrow();
  expect(() =>
    decodeTrackedTransaction(transaction(), address(6), signature),
  ).toThrow();
  const patches = [
    (tx: ReturnType<typeof transaction>) => {
      tx.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(2));
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.meta.preBalances[0] = '18446744073709551616';
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.meta.postBalances.pop();
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.meta.postTokenBalances[0].accountIndex = '9';
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.meta.postTokenBalances.push(balance('1'));
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.meta.postTokenBalances[0].uiTokenAmount.decimals = '6';
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.transaction.message.accountKeys[1].pubkey = wallet;
    },
    (tx: ReturnType<typeof transaction>) => {
      tx.transaction.message.instructions[0].programId = address(7);
    },
  ];
  for (const patch of patches) {
    const tx = transaction();
    patch(tx);
    expect(() => decodeTrackedTransaction(tx, wallet, signature)).toThrow();
  }
});
it.each(['mainnet', 'devnet'] as const)(
  'checks %s genesis and requests only the selected signature',
  async (network) => {
    const fetcher = vi.fn(
      async (_url: unknown, options: RequestInit | undefined) => {
        const body = JSON.parse(options!.body as string);
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result:
            body.method === 'getGenesisHash'
              ? network === 'mainnet'
                ? SOLANA_MAINNET_GENESIS
                : DEVNET_GENESIS_HASH
              : transaction(),
        });
      },
    );
    expect(
      await observeTrackedTransaction(
        wallet,
        network,
        signature,
        new AbortController().signal,
        fetcher as typeof fetch,
      ),
    ).toMatchObject({ signature, address: wallet, network });
    const bodies = fetcher.mock.calls.map((c) =>
      JSON.parse(c[1]!.body as string),
    );
    expect(bodies.map((b) => b.method)).toEqual([
      'getGenesisHash',
      'getTransaction',
    ]);
    expect(bodies[1].params).toEqual([
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
  },
);
it('rejects wrong genesis before transaction reads and preserves missing history as null', async () => {
  const wrong = vi.fn(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS_HASH }),
  );
  await expect(
    observeTrackedTransaction(
      wallet,
      'mainnet',
      signature,
      new AbortController().signal,
      wrong,
    ),
  ).rejects.toThrow('network');
  expect(wrong).toHaveBeenCalledTimes(1);
  const absent = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS }),
    )
    .mockResolvedValueOnce(
      Response.json({ jsonrpc: '2.0', id: 1, result: null }),
    );
  expect(
    await observeTrackedTransaction(
      wallet,
      'mainnet',
      signature,
      new AbortController().signal,
      absent,
    ),
  ).toBeNull();
});
