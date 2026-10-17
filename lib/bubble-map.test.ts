import { expect, it } from 'vitest';
import { buildBubbleMap, funderInTransaction } from './bubble-map';
import { findFirstFunder } from './bubble-map-funders';

const A = 'Vote111111111111111111111111111111111111111';
const B = 'Stake11111111111111111111111111111111111111';
const C = 'Config1111111111111111111111111111111111111';
const D = 'BPFLoaderUpgradeab1e11111111111111111111111';
const F = 'SysvarRent111111111111111111111111111111111';
const funded = (funder: string) => ({ funder, signature: 's', slot: 1 });

const transfer = (
  source: string,
  destination: string,
  err: unknown = null,
) => ({
  slot: 9,
  transaction: {
    signatures: ['sig'],
    message: {
      instructions: [
        {
          program: 'system',
          parsed: { type: 'transfer', info: { source, destination } },
        },
      ],
    },
  },
  meta: { err, innerInstructions: [] },
});

it('reads the first SOL sender from transfers and created accounts', () => {
  expect(funderInTransaction(transfer(F, A), A)).toEqual({
    funder: F,
    signature: 'sig',
    slot: 9,
  });
  expect(funderInTransaction(transfer(F, B), A)).toBeNull();
  expect(funderInTransaction(transfer(F, A, { x: 1 }), A)).toBeNull();
  const created = transfer(F, A);
  created.transaction.message.instructions[0].parsed = {
    type: 'createAccount',
    info: { source: F, newAccount: A },
  } as never;
  expect(funderInTransaction(created, A)?.funder).toBe(F);
});

it('clusters holders by shared funders and direct funding, with exact supply shares', () => {
  const map = buildBubbleMap(
    [
      { owner: A, raw: '300' },
      { owner: B, raw: '200' },
      { owner: C, raw: '100' },
      { owner: D, raw: '50' },
    ],
    { A: null, [A]: funded(F), [B]: funded(F), [C]: funded(A), [D]: null },
    '1000',
    [B],
  );
  expect(map.clusters).toEqual([
    {
      id: 1,
      owners: [A, B, C],
      raw: '600',
      supplyBasisPoints: 6000,
      sharedFunders: [F],
      ownedWallets: [B],
    },
  ]);
  expect(map.clusteredBasisPoints).toBe(6000);
  expect(map.ownedClusteredBasisPoints).toBe(6000);
  expect(map.nodes.find((n) => n.owner === D)?.cluster).toBeNull();
  expect(map.links).toContainEqual({ from: A, to: C });
  expect(() =>
    buildBubbleMap(
      [
        { owner: A, raw: '1' },
        { owner: A, raw: '1' },
      ],
      {},
      '10',
    ),
  ).toThrow('once');
});

it('walks history to the oldest signatures and gives up on very long histories', async () => {
  const calls: string[] = [];
  const short = await findFirstFunder(A, async <T>(method: string) => {
    calls.push(method);
    return (
      method === 'getSignaturesForAddress'
        ? [
            { signature: 'new', slot: 2, err: null },
            { signature: 'old', slot: 1, err: null },
          ]
        : transfer(F, A)
    ) as T;
  });
  expect(short.funder?.funder).toBe(F);
  expect(calls).toEqual(['getSignaturesForAddress', 'getTransaction']);
  const full = Array.from({ length: 1000 }, (_, i) => ({
    signature: 's' + i,
    slot: 1,
    err: null,
  }));
  const long = await findFirstFunder(A, async <T>() => full as T);
  expect(long).toEqual({ funder: null, reason: 'history-too-long' });
});
