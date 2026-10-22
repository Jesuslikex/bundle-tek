import { expect, it } from 'vitest';
import bs58 from 'bs58';
const signature = (n: number) => {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, n);
  return bs58.encode(bytes);
};
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
    signatures: [signature(9)],
    message: {
      instructions: [
        {
          program: 'system',
          programId: '11111111111111111111111111111111',
          parsed: {
            type: 'transfer',
            info: { source, destination, lamports: 1000 },
          },
        },
      ],
    },
  },
  meta: { err, innerInstructions: [] },
});

it('reads the first SOL sender from transfers and created accounts', () => {
  expect(funderInTransaction(transfer(F, A), A)).toEqual({
    funder: F,
    signature: signature(9),
    slot: 9,
  });
  expect(funderInTransaction(transfer(F, B), A)).toBeNull();
  expect(funderInTransaction(transfer(F, A, { x: 1 }), A)).toBeNull();
  const created = transfer(F, A);
  created.transaction.message.instructions[0].parsed = {
    type: 'createAccount',
    info: { source: F, newAccount: A, lamports: 1000 },
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

it('walks bounded history without guessing beyond the lookup cap', async () => {
  let page = 0;
  const calls: string[] = [];
  const short = await findFirstFunder(A, async <T>(method: string) => {
    calls.push(method);
    return (
      method === 'getSignaturesForAddress'
        ? page++ === 0
          ? [{ signature: signature(9), slot: 9, err: null }]
          : []
        : transfer(F, A)
    ) as T;
  });
  expect(short.funder?.funder).toBe(F);
  expect(calls).toEqual([
    'getSignaturesForAddress',
    'getSignaturesForAddress',
    'getTransaction',
  ]);
  page = 0;
  const long = await findFirstFunder(
    A,
    async <T>() =>
      Array.from({ length: 1000 }, (_, i) => {
        const n = 4000 - page * 1000 - i;
        return { signature: signature(n), slot: n, err: null };
      }).map((row, i, rows) => {
        if (i === rows.length - 1) page++;
        return row;
      }) as T,
  );
  expect(long).toEqual({ funder: null, reason: 'history-too-long' });
});
