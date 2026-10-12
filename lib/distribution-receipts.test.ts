import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  buildDistributionPlan,
  sumDistributionAmounts,
  toBaseUnits,
} from './distribution-plan';
import {
  readDistributionReceipts,
  remainingDistributionRecipients,
} from './distribution-receipts';

const A = '11111111111111111111111111111111';
const B = 'So11111111111111111111111111111111111111112';
const receipt = {
  address: A,
  amount: '0.3',
  signature: bs58.encode(new Uint8Array(64).fill(1)),
  confirmedAt: '2026-10-10T04:00:00.000Z',
};

describe('exact distribution receipts', () => {
  it('retains legacy numeric receipts without repeating completed recipients', () => {
    const plan = buildDistributionPlan({
      manifest: `${A}, 0.1\n${A}, 0.2\n${B}, 0.4`,
      tokenSupply: '1',
      reservePercent: '0',
      batchSize: 1,
    });
    const receipts = readDistributionReceipts(
      JSON.stringify([{ ...receipt, amount: 0.3 }]),
    );
    expect(receipts[0].amount).toBe('0.3');
    const remaining = remainingDistributionRecipients(
      plan.recipients,
      receipts,
    );
    expect(remaining.map((recipient) => recipient.address)).toEqual([B]);
    expect(
      sumDistributionAmounts(remaining.map((recipient) => recipient.amount)),
    ).toBe('0.4');
    expect(toBaseUnits(remaining[0].amount, 9)).toBe(400_000_000n);
  });

  it('round trips exact receipt amounts beyond Number precision', () => {
    const stored = JSON.stringify([{ ...receipt, amount: '9007199254740993' }]);
    expect(readDistributionReceipts(stored)[0].amount).toBe('9007199254740993');
    expect(readDistributionReceipts(null)).toEqual([]);
    expect(readDistributionReceipts('[]')).toEqual([]);
    expect(
      readDistributionReceipts(
        JSON.stringify([{ ...receipt, amount: 900719925474099.1 }]),
      )[0].amount,
    ).toBe('900719925474099.1');
  });

  it('matches the reviewed address and amount together', () => {
    const plan = buildDistributionPlan({
      manifest: `${A}, 0.4\n${B}, 0.3`,
      tokenSupply: '1',
      reservePercent: '0',
      batchSize: 1,
    });
    expect(remainingDistributionRecipients(plan.recipients, [receipt])).toEqual(
      plan.recipients,
    );
    const completed = [
      { ...receipt, amount: '0.4' },
      { ...receipt, address: B },
    ];
    expect(remainingDistributionRecipients(plan.recipients, completed)).toEqual(
      [],
    );
  });

  it('fails closed rather than discarding unreadable or malformed receipts', () => {
    for (const stored of [
      '{',
      '{}',
      '[null]',
      ' '.repeat(512_001),
      JSON.stringify(Array(1001).fill(receipt)),
    ]) {
      expect(() => readDistributionReceipts(stored)).toThrow();
    }
    for (const changed of [
      { amount: 9007199254740992 },
      { amount: '0' },
      { amount: '1e3' },
      { signature: 'not a signature' },
      { signature: bs58.encode(new Uint8Array(32)) },
      { address: 'not a wallet' },
      { confirmedAt: 'unknown' },
    ]) {
      expect(() =>
        readDistributionReceipts(JSON.stringify([{ ...receipt, ...changed }])),
      ).toThrow();
    }
  });
});
