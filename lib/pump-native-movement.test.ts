import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { nativePumpFixture } from '../test/pump-native-fixture';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
import { decodeTrackedTransaction } from './tracked-wallet-transaction';
import { supplyWallet as address } from '../test/supply-history-fixture';
for (const name of ['buy', 'buy_exact_sol_in', 'sell'])
  it(`classifies native Pump.fun ${name} from reconciled payments and token legs`, () => {
    const tx = nativePumpFixture(name),
      result = classifyWalletMovement(tx, tx.tokenChanges[0].mint);
    expect(result).toMatchObject({
      kind: name === 'sell' ? 'sell' : 'buy',
      protocol: 'Pump.fun',
      basis: 'pump-native-and-token-transfers',
      quote: {
        raw: name === 'sell' ? '100' : '110',
        asset: 'native-sol',
        decimals: 9,
      },
    });
    expect(() =>
      requireMovementClassification(result, tx.tokenChanges[0].changeRaw),
    ).not.toThrow();
  });
it('rejects missing, excessive or substituted native buy payments and partial-fill mismatches', () => {
  const original = nativePumpFixture();
  for (const mutate of [
    (tx: typeof original) => {
      tx.walletSigner = false;
    },
    (tx: typeof original) => {
      tx.movementInstructions!.pop();
    },
    (tx: typeof original) => {
      tx.movementInstructions![2].info!.destination = address(90);
    },
    (tx: typeof original) => {
      tx.movementInstructions![2].info!.lamports = '111';
    },
    (tx: typeof original) => {
      tx.movementInstructions![1].info!.amount = '999';
    },
    (tx: typeof original) => {
      tx.movementInstructions!.push({ program: address(91), topLevel: true });
    },
  ]) {
    const tx = structuredClone(original);
    mutate(tx);
    expect(classifyWalletMovement(tx, tx.tokenChanges[0].mint).kind).toBe(
      'unknown',
    );
  }
  const partial = structuredClone(original);
  partial.tokenChanges[0].afterRaw = '500';
  partial.tokenChanges[0].changeRaw = '500';
  partial.movementInstructions![1].info!.amount = '500';
  expect(
    classifyWalletMovement(partial, partial.tokenChanges[0].mint).kind,
  ).toBe('unknown');
  partial.movementInstructions![0].dataHex =
    partial.movementInstructions![0].dataHex!.slice(0, -2) + '01';
  expect(
    classifyWalletMovement(partial, partial.tokenChanges[0].mint).kind,
  ).toBe('buy');
});
it('withholds native sell labels for missing settlement, extra lamport movements or rent operations', () => {
  const original = nativePumpFixture('sell');
  for (const mutate of [
    (tx: typeof original) => {
      delete tx.nativeAccountChanges;
    },
    (tx: typeof original) => {
      tx.nativeAccountChanges![1].changeRaw = '-100';
    },
    (tx: typeof original) => {
      tx.nativeChangeRaw = '100';
    },
    (tx: typeof original) => {
      tx.nativeAccountChanges!.push({
        address: address(90),
        beforeRaw: '0',
        afterRaw: '1',
        changeRaw: '1',
      });
    },
    (tx: typeof original) => {
      tx.movementInstructions!.push({
        program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        type: 'closeAccount',
        topLevel: true,
      });
    },
  ]) {
    const tx = structuredClone(original);
    mutate(tx);
    expect(classifyWalletMovement(tx, tx.tokenChanges[0].mint).kind).toBe(
      'unknown',
    );
  }
});
it('retains native balance changes and parsed lamports through the real RPC decoder', () => {
  for (const name of ['buy', 'sell']) {
    const f = nativePumpFixture(name),
      signature = bs58.encode(new Uint8Array(64).fill(1));
    const accounts = [
      ...new Set([
        f.address,
        ...f.movementInstructions!.flatMap((i) => [
          i.program,
          ...(i.accounts ?? []),
          ...Object.entries(i.info ?? {})
            .filter(([k]) => ['source', 'destination'].includes(k))
            .map(([, v]) => v),
        ]),
      ]),
    ];
    const rawInstruction = (
      i: NonNullable<typeof f.movementInstructions>[number],
    ) =>
      i.dataHex
        ? {
            programId: i.program,
            accounts: i.accounts,
            data: bs58.encode(
              Uint8Array.from(i.dataHex.match(/../g)!, (h) => parseInt(h, 16)),
            ),
          }
        : { programId: i.program, parsed: { type: i.type, info: i.info } };
    const native = (a: string, side: 'beforeRaw' | 'afterRaw') =>
      f.nativeAccountChanges!.find((b) => b.address === a)?.[side] ?? '1';
    const token = (amount: string) => [
      {
        accountIndex: String(accounts.indexOf(f.tokenChanges[0].accounts[0])),
        mint: f.tokenChanges[0].mint,
        owner: f.address,
        programId: f.tokenChanges[0].program,
        uiTokenAmount: { amount, decimals: '6' },
      },
    ];
    const decoded = decodeTrackedTransaction(
      {
        slot: '100',
        blockTime: null,
        version: 'legacy',
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts.map((pubkey) => ({
              pubkey,
              signer: pubkey === f.address,
              writable: true,
            })),
            instructions: f
              .movementInstructions!.filter((i) => i.topLevel)
              .map(rawInstruction),
          },
        },
        meta: {
          err: null,
          fee: '5',
          preBalances: accounts.map((a) => native(a, 'beforeRaw')),
          postBalances: accounts.map((a) => native(a, 'afterRaw')),
          preTokenBalances: token(f.tokenChanges[0].beforeRaw),
          postTokenBalances: token(f.tokenChanges[0].afterRaw),
          innerInstructions: [
            {
              index: '0',
              instructions: f
                .movementInstructions!.filter((i) => !i.topLevel)
                .map(rawInstruction),
            },
          ],
        },
      },
      f.address,
      signature,
    );
    expect(
      classifyWalletMovement({ ...f, ...decoded }, f.tokenChanges[0].mint).kind,
    ).toBe(name === 'sell' ? 'sell' : 'buy');
  }
});
