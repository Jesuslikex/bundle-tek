import { expect, it } from 'vitest';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
import type {
  TrackedTransaction,
  MovementInstruction,
} from './tracked-wallet-transaction';
import {
  routeReview,
  routeOrder,
  routeWallet,
} from '../test/jupiter-route-fixture';
import { supplyWallet as address } from '../test/supply-history-fixture';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const transfer = (
  source: string,
  destination: string,
  mint: string,
  raw: string,
  topLevel = false,
): MovementInstruction => ({
  program: TOKEN,
  topLevel,
  type: 'transferChecked',
  info: { source, destination, mint, amount: raw },
});
function swap(shared = false, v2 = false): TrackedTransaction {
  const review = routeReview({ shared, v2 });
  const r = review.instructions[0];
  const source = r.accounts[v2 ? (shared ? 2 : 1) : shared ? 3 : 2].address,
    destination = r.accounts[v2 ? (shared ? 5 : 2) : shared ? 6 : 3].address;
  return {
    address: routeWallet,
    network: 'mainnet',
    signature: 'fixture',
    slot: 100,
    blockTime: null,
    failed: false,
    feeRaw: '5000',
    feePayer: routeWallet,
    walletSigner: true,
    nativeChangeRaw: '-2000000',
    tokensComplete: true,
    programs: [r.program.address, TOKEN],
    innerInstructionsAvailable: true,
    observedAt: new Date().toISOString(),
    source: 'fixture.test',
    commitment: 'confirmed',
    tokenChanges: [
      {
        mint: routeOrder.inputMint,
        program: TOKEN,
        decimals: 9,
        beforeRaw: '1000000',
        afterRaw: '0',
        changeRaw: '-1000000',
        accounts: [source],
      },
      {
        mint: routeOrder.outputMint,
        program: TOKEN,
        decimals: 6,
        beforeRaw: '0',
        afterRaw: '1000',
        changeRaw: '1000',
        accounts: [destination],
      },
    ],
    movementInstructions: [
      {
        program: r.program.address,
        topLevel: true,
        dataHex: r.dataHex,
        accounts: r.accounts.map((a) => a.address),
      },
      transfer(source, address(20), routeOrder.inputMint, '1000000'),
      transfer(address(21), destination, routeOrder.outputMint, '1000'),
    ],
  };
}
it('classifies buys and sells from reconciled wallet-authorized route legs across all supported Jupiter account layouts', () => {
  for (const shared of [false, true])
    for (const v2 of [false, true]) {
      const tx = swap(shared, v2);
      expect(classifyWalletMovement(tx, routeOrder.outputMint).kind).toBe(
        'buy',
      );
      expect(classifyWalletMovement(tx, routeOrder.inputMint).kind).toBe(
        'sell',
      );
    }
});
it('does not label balance direction alone, a failed trade, another authority, or mismatched transfer amounts as buys/sells', () => {
  const tx = swap();
  expect(
    classifyWalletMovement(
      { ...tx, movementInstructions: undefined },
      routeOrder.outputMint,
    ).kind,
  ).toBe('unknown');
  expect(
    classifyWalletMovement({ ...tx, failed: true }, routeOrder.outputMint).kind,
  ).toBe('unknown');
  expect(
    classifyWalletMovement(
      { ...tx, walletSigner: false },
      routeOrder.outputMint,
    ).kind,
  ).toBe('unknown');
  const changed = structuredClone(tx);
  changed.movementInstructions![1].info!.amount = '999999';
  expect(classifyWalletMovement(changed, routeOrder.outputMint).kind).toBe(
    'unknown',
  );
  const foreign = structuredClone(tx);
  foreign.movementInstructions![0].accounts![1] = address(22);
  expect(classifyWalletMovement(foreign, routeOrder.outputMint).kind).toBe(
    'unknown',
  );
});
it('classifies a decoded SPL transfer but refuses an accompanying native payment or unknown swap program', () => {
  const tx = swap(),
    token = tx.tokenChanges[1],
    own = token.accounts[0];
  const standalone = {
    ...tx,
    tokenChanges: [token],
    movementInstructions: [
      transfer(address(23), own, token.mint, '1000', true),
    ],
  };
  expect(classifyWalletMovement(standalone, token.mint)).toMatchObject({
    kind: 'transfer',
    counterpartyAccounts: [address(23)],
  });
  expect(
    classifyWalletMovement(
      {
        ...standalone,
        movementInstructions: [
          ...standalone.movementInstructions,
          {
            program: '11111111111111111111111111111111',
            topLevel: true,
            type: 'transfer',
            info: { source: tx.address, destination: address(24) },
          },
        ],
      },
      token.mint,
    ).kind,
  ).toBe('unknown');
  expect(
    classifyWalletMovement(
      {
        ...standalone,
        movementInstructions: [
          ...standalone.movementInstructions,
          { program: address(25), topLevel: true },
        ],
      },
      token.mint,
    ).kind,
  ).toBe('unknown');
});
it('handles wrapped SOL accounts created and closed in the same swap without using fee/rent-contaminated native deltas', () => {
  const tx = swap();
  const quote = tx.tokenChanges[0];
  quote.beforeRaw = '0';
  quote.afterRaw = '0';
  quote.changeRaw = '0';
  expect(classifyWalletMovement(tx, routeOrder.outputMint)).toMatchObject({
    kind: 'buy',
    quote: { mint: routeOrder.inputMint, raw: '1000000', decimals: 9 },
  });
});
it('rejects stored labels inconsistent with the signed target delta while preserving legacy unknown evidence', () => {
  const result = classifyWalletMovement(swap(), routeOrder.outputMint);
  expect(() => requireMovementClassification(result, '1000')).not.toThrow();
  expect(() => requireMovementClassification(result, '-1000')).toThrow();
  expect(() => requireMovementClassification(undefined, '1000')).not.toThrow();
});
