import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { observeHolderIndexPage } from './holder-index-provider';
import { appendHolderIndexPage, holderIndexSummary } from './holder-index';
import { holderIndexWithheldFees } from './holder-index-withheld';
import { supplyWallet as address } from '../test/supply-history-fixture';

const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
async function page(
  extensions: unknown = [
    { extension: 'transferFeeAmount', state: { withheldAmount: '3' } },
  ],
) {
  env.SOLANA_INDEXER_RPC_URL = 'https://index.test';
  const fetcher: typeof fetch = async (_, init) => {
    if (typeof init?.body !== 'string') throw new Error('RPC JSON required.');
    const { method } = JSON.parse(init.body);
    const result =
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : method === 'getTokenSupply'
          ? { context: { slot: '200' }, value: { amount: '10', decimals: '6' } }
          : method === 'getAccountInfo'
            ? { value: { owner: program, executable: false } }
            : {
                context: { slot: '200' },
                value: {
                  paginationKey: null,
                  accounts: [
                    {
                      pubkey: address(1),
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
                              extensions,
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              };
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  try {
    return await observeHolderIndexPage(
      address(9),
      1,
      new AbortController().signal,
      fetcher,
      null,
      'program-accounts-v2',
    );
  } finally {
    delete env.SOLANA_INDEXER_RPC_URL;
  }
}
it('keeps withheld fees outside owners and preserves them through serialized saved pages', async () => {
  const observed = await page();
  expect(observed.accounts[0].withheldRaw).toBe('3');
  const scan = appendHolderIndexPage(
    null,
    JSON.parse(JSON.stringify(observed)),
    address(9),
    6,
  );
  expect(holderIndexSummary(scan).holders[0].raw).toBe(5n);
  expect(holderIndexSummary(scan).remainderRaw).toBe('5');
  expect(holderIndexWithheldFees(scan)).toEqual({
    raw: '3',
    reportedAccounts: 1,
    remainderAfterObservedFeesRaw: '2',
  });
});
it('does not turn missing fee metadata into a measured zero', async () => {
  const observed = await page([]);
  expect(observed.accounts[0].withheldRaw).toBeUndefined();
  const scan = appendHolderIndexPage(null, observed, address(9), 6);
  expect(holderIndexWithheldFees(scan).reportedAccounts).toBe(0);
});
it('rejects malformed or duplicated fee extensions and contradictory totals', async () => {
  await expect(
    page([{ extension: 'transferFeeAmount', state: { withheldAmount: '-1' } }]),
  ).rejects.toThrow('fees');
  await expect(
    page([
      { extension: 'transferFeeAmount', state: { withheldAmount: '3' } },
      { extension: 'transferFeeAmount', state: { withheldAmount: '3' } },
    ]),
  ).rejects.toThrow('Duplicate');
  const observed = await page([
    { extension: 'transferFeeAmount', state: { withheldAmount: '6' } },
  ]);
  const scan = appendHolderIndexPage(null, observed, address(9), 6);
  expect(() => holderIndexWithheldFees(scan)).toThrow('exceed');
  expect(() =>
    appendHolderIndexPage(
      null,
      { ...observed, enumeration: 'das-cursor' },
      address(9),
      6,
    ),
  ).toThrow('provenance');
});
