import { expect, it } from 'vitest';
import capture from './proxima-wrapped-pump-transactions.json';
import type { TrackedTransaction } from '../lib/tracked-wallet-transaction';
import { classifyWalletMovement } from '../lib/wallet-movement-classification';

it('proves venue sells from actual GMGN CPI evidence without claiming final settlement', () => {
  for (const value of capture.transactions) {
    const tx = value as TrackedTransaction;
    const target = tx.tokenChanges.find((t) => t.mint === capture.mint)!;
    const pump = tx.movementInstructions!.find((i) =>
      i.dataHex?.startsWith('5df6823ce7e940b2'),
    )!;
    expect(pump).toMatchObject({
      topLevel: false,
      outerInstructionIndex: 5,
      innerInstructionIndex: 0,
      stackHeight: 2,
    });
    const caller = tx.movementInstructions!.find(
      (i) =>
        i.topLevel && i.outerInstructionIndex === pump.outerInstructionIndex,
    )!;
    expect(caller.program).toBe('GMGNreQcJFufBiCTLDBgKhYEfEe9B454UjpDr5CaSLA1');
    expect(pump.accounts).toHaveLength(26);
    expect(pump.accounts![1]).toBe(capture.mint);
    expect(pump.accounts![13]).toBe(tx.address);
    expect(target.accounts).toContain(pump.accounts![14]);
    const amount = Buffer.from(pump.dataHex!, 'hex').readBigUInt64LE(8);
    expect(BigInt(target.changeRaw)).toBe(-amount);
    expect(
      tx.tokenChanges.find((t) => t.mint === pump.accounts![2])?.changeRaw,
    ).toBe('0');
    expect(classifyWalletMovement(tx, capture.mint)).toMatchObject({
      kind: 'sell',
      basis: 'pump-quote-and-token-transfers',
      protocol: 'Pump.fun',
      quote: { mint: pump.accounts![2], scope: 'venue-transfer' },
    });
  }
});
