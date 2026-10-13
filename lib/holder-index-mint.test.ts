import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { observeHolderIndexPage } from './holder-index-provider';
import { appendHolderIndexPage, holderIndexSummary } from './holder-index';
import { holderIndexWithheldFees } from './holder-index-withheld';
import {
  decodeHolderMintObservation,
  validateHolderMintObservation,
} from './holder-index-mint';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { supplyWallet as address } from '../test/supply-history-fixture';

const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const supply = {
  context: { slot: '200' },
  value: { amount: '10', decimals: '6' },
};
const mint = (
  raw: unknown = '2',
  slot: unknown = '201',
  extensions?: unknown,
) => ({
  context: { slot },
  value: {
    owner: program,
    executable: false,
    data: {
      parsed: {
        type: 'mint',
        info: {
          supply: '10',
          decimals: '6',
          isInitialized: true,
          extensions: extensions ?? [
            { extension: 'transferFeeConfig', state: { withheldAmount: raw } },
          ],
        },
      },
    },
  },
});
async function observe(
  mintResult: unknown = mint(),
  previous: Awaited<ReturnType<typeof observeHolderIndexPage>> | null = null,
) {
  env.SOLANA_INDEXER_RPC_URL = 'https://mint-fixture.test';
  const fetcher = vi.fn<typeof fetch>(async (_, init) => {
    if (typeof init?.body !== 'string') throw new Error('RPC JSON required.');
    const query = JSON.parse(init.body);
    const result =
      query.method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : query.method === 'getTokenSupply'
          ? supply
          : query.method === 'getAccountInfo'
            ? mintResult
            : {
                context: { slot: 202 },
                value: {
                  paginationKey: 'next-page',
                  accounts: [
                    {
                      pubkey: address(previous ? 2 : 1),
                      account: {
                        owner: program,
                        executable: false,
                        data: {
                          parsed: {
                            type: 'account',
                            info: {
                              mint: address(9),
                              owner: address(7),
                              state: 'initialized',
                              tokenAmount: { amount: '5', decimals: '6' },
                              extensions: [
                                {
                                  extension: 'transferFeeAmount',
                                  state: { withheldAmount: '3' },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              };
    // Exercise the real lossless RPC reader with numeric wire fees, not just strings.
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result })
        .replaceAll('"withheldAmount":"2"', '"withheldAmount":2')
        .replaceAll('"withheldAmount":"3"', '"withheldAmount":3'),
    );
  });
  try {
    const page = await observeHolderIndexPage(
      address(9),
      previous ? 2 : 1,
      new AbortController().signal,
      fetcher,
      previous,
      'program-accounts-v2',
    );
    return { page, calls: fetcher.mock.calls };
  } finally {
    delete env.SOLANA_INDEXER_RPC_URL;
  }
}

it('reads mint fees in the existing RPC call, preserving owner balances and exact fee reconciliation', async () => {
  const { page, calls } = await observe();
  expect(calls).toHaveLength(4);
  const requestBody = calls[2][1]?.body;
  if (typeof requestBody !== 'string') throw new Error('RPC JSON required.');
  const request = JSON.parse(requestBody);
  expect(request.params[1]).toEqual({
    commitment: 'finalized',
    encoding: 'jsonParsed',
    minContextSlot: 200,
  });
  expect(page.mintObservation).toEqual({
    slot: 201,
    withheldRaw: '2',
    extensions: ['transferFeeConfig'],
  });
  const scan = appendHolderIndexPage(
    null,
    JSON.parse(JSON.stringify(page)),
    address(9),
    6,
  );
  expect(holderIndexSummary(scan).holders[0].raw).toBe(5n);
  expect(holderIndexSummary(scan).coveredPercent).toBe(50);
  expect(holderIndexWithheldFees(scan)).toMatchObject({
    raw: '3',
    mintRaw: '2',
    remainderAfterObservedFeesRaw: '0',
  });
});

it('keeps unavailable and unparsed mint metadata distinct from verified absence of ordinary fees', () => {
  expect(
    decodeHolderMintObservation(
      { value: { data: ['AA==', 'base64'] } },
      supply,
    ),
  ).toBeUndefined();
  expect(
    decodeHolderMintObservation(mint('0', '200', []), supply)?.withheldRaw,
  ).toBe('0');
  expect(
    decodeHolderMintObservation(
      mint('0', '200', [{ extension: 'unparseableExtension' }]),
      supply,
    )?.withheldRaw,
  ).toBeNull();
});

it('rejects stale, contradictory, malformed, duplicate and oversized mint observations', () => {
  expect(() => decodeHolderMintObservation(mint('2', '199'), supply)).toThrow(
    'slot',
  );
  expect(() => decodeHolderMintObservation(mint('11'), supply)).toThrow(
    'exceed',
  );
  for (const raw of ['-1', '01', '1.5', '18446744073709551616', undefined])
    expect(() =>
      decodeHolderMintObservation(mint(raw === undefined ? null : raw), supply),
    ).toThrow('fee');
  const changed = mint();
  changed.value.data.parsed.info.supply = '11';
  expect(() => decodeHolderMintObservation(changed, supply)).toThrow('supply');
  expect(() =>
    decodeHolderMintObservation(
      mint('2', '201', [
        { extension: 'transferFeeConfig', state: { withheldAmount: '2' } },
        { extension: 'transferFeeConfig', state: { withheldAmount: '2' } },
      ]),
      supply,
    ),
  ).toThrow('Duplicate');
  expect(() =>
    validateHolderMintObservation({
      slot: 200,
      extensions: [],
      withheldRaw: '1',
    }),
  ).toThrow('config');
});

it('rejects changed or disappearing mint fees between pages before combining live observations', async () => {
  const { page } = await observe();
  await expect(observe(mint('3'), page)).rejects.toThrow('changed');
  await expect(
    observe({ value: { owner: program, executable: false } }, page),
  ).rejects.toThrow('changed');
  const first = appendHolderIndexPage(null, page, address(9), 6);
  expect(() =>
    appendHolderIndexPage(
      first,
      {
        ...page,
        page: 2,
        requestedCursor: 'next-page',
        nextCursor: null,
        accounts: [],
        mintObservation: { ...page.mintObservation!, withheldRaw: '3' },
      },
      address(9),
      6,
    ),
  ).toThrow('changed');
  const next = appendHolderIndexPage(
    first,
    {
      ...page,
      page: 2,
      requestedCursor: 'next-page',
      nextCursor: null,
      accounts: [],
      mintObservation: { ...page.mintObservation!, slot: 203 },
    },
    address(9),
    6,
  );
  expect([next.minMintSlot, next.maxMintSlot]).toEqual([201, 203]);
  expect(holderIndexWithheldFees(next).remainderAfterObservedFeesRaw).toBe('0');
});
