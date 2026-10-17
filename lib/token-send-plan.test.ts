import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  formatSendPercent,
  parseSendRows,
  planTokenSend,
  sendPercent,
} from './token-send-plan';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const [A, B, C, R1, R2] = [1, 2, 3, 10, 11].map(key);
const supply = 1_000_000_000_000_000n; // 1B tokens at 6 decimals

describe('sendPercent', () => {
  it('parses supply percentages to ppm', () => {
    expect(sendPercent('1')).toBe(10_000n);
    expect(sendPercent('0.0001')).toBe(1n);
    expect(sendPercent(' 2.5% ')).toBe(25_000n);
    expect(sendPercent('100')).toBe(1_000_000n);
    expect(formatSendPercent(25_000n)).toBe('2.5%');
  });
  it('rejects out of range or over-precise values', () => {
    for (const v of ['0', '100.0001', '1.00001', '-1', 'abc', '', '1e3'])
      expect(() => sendPercent(v)).toThrow();
  });
});

describe('parseSendRows', () => {
  it('accepts comma, colon and tab separated two and three field lines', () => {
    const rows = parseSendRows(`${R1},1\n\n${A}:${R2}:0.5\n${R1}\t2`);
    expect(rows).toEqual([
      { recipient: R1, ppm: 10_000n },
      { sender: A, recipient: R2, ppm: 5_000n },
      { recipient: R1, ppm: 20_000n },
    ]);
  });
  it('names the failing line', () => {
    expect(() => parseSendRows(`${R1},1\nnot-an-address,2`)).toThrow(/Line 2/);
    expect(() => parseSendRows(`${R1}`)).toThrow(/Line 1/);
    expect(() => parseSendRows('  \n')).toThrow(/at least one/);
  });
});

describe('planTokenSend', () => {
  it('splits one recipient across the largest balances first', () => {
    const plan = planTokenSend({
      supplyRaw: supply,
      decimals: 6,
      sources: [
        { address: A, raw: 10_000_000_000_000n }, // 1%
        { address: B, raw: 30_000_000_000_000n }, // 3%
        { address: C, raw: 0n },
      ],
      rows: [{ recipient: R1, ppm: 35_000n }], // 3.5%
    });
    expect(plan.totalRaw).toBe('35000000000000');
    expect(plan.legs).toEqual([
      { sender: B, recipient: R1, raw: '30000000000000', amount: '30000000' },
      { sender: A, recipient: R1, raw: '5000000000000', amount: '5000000' },
    ]);
    expect(plan.usage.find((u) => u.address === C)!.usedRaw).toBe('0');
    expect(plan.usage.find((u) => u.address === A)!.remainingRaw).toBe(
      '5000000000000',
    );
  });
  it('serves explicit senders before pooled rows and merges legs', () => {
    const plan = planTokenSend({
      supplyRaw: supply,
      decimals: 6,
      sources: [
        { address: A, raw: 20_000_000_000_000n },
        { address: B, raw: 5_000_000_000_000n },
      ],
      rows: [
        { recipient: R1, ppm: 15_000n },
        { sender: B, recipient: R2, ppm: 5_000n },
        { sender: A, recipient: R1, ppm: 5_000n },
      ],
    });
    expect(plan.legs).toEqual([
      { sender: B, recipient: R2, raw: '5000000000000', amount: '5000000' },
      { sender: A, recipient: R1, raw: '20000000000000', amount: '20000000' },
    ]);
  });
  it('blocks when selected wallets do not hold enough', () => {
    expect(() =>
      planTokenSend({
        supplyRaw: supply,
        decimals: 6,
        sources: [{ address: A, raw: 1n }],
        rows: [{ recipient: R1, ppm: 1n }],
      }),
    ).toThrow(/do not hold enough/);
    expect(() =>
      planTokenSend({
        supplyRaw: supply,
        decimals: 6,
        sources: [{ address: A, raw: supply }],
        rows: [{ sender: B, recipient: R1, ppm: 1n }],
      }),
    ).toThrow(/not selected/);
  });
  it('refuses recipients that are sources and sub-unit amounts', () => {
    expect(() =>
      planTokenSend({
        supplyRaw: supply,
        decimals: 6,
        sources: [
          { address: A, raw: supply },
          { address: B, raw: 0n },
        ],
        rows: [{ recipient: B, ppm: 1n }],
      }),
    ).toThrow(/also a selected source/);
    expect(() =>
      planTokenSend({
        supplyRaw: 100n,
        decimals: 0,
        sources: [{ address: A, raw: 100n }],
        rows: [{ recipient: R1, ppm: 1n }],
      }),
    ).toThrow(/below one token unit/);
  });
});
