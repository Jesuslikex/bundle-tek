import { expect, it, vi } from 'vitest';
import {
  appendHolderIndexPage,
  decodeHolderIndexPage,
  holderIndexSummary,
} from './holder-index';
import { observeHolderIndexPage } from './holder-index-provider';
import { supplyWallet as address } from '../test/supply-history-fixture';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { env } from 'cloudflare:workers';
const mint = address(9);
const supply = {
  context: { slot: '200' },
  value: { amount: '18446744073709551615', decimals: '6' },
};
const account = (n: number, owner: number, raw: string) => ({
  address: address(n),
  owner: address(owner),
  mint,
  amount: raw,
  frozen: false,
});
const page = (n: number, accounts: ReturnType<typeof account>[]) =>
  decodeHolderIndexPage(
    { last_indexed_slot: '190', token_accounts: accounts },
    supply,
    mint,
    n,
    'index.test',
  );

it('merges multiple token accounts by owner with exact u64 balances and only exhausts on an empty page', () => {
  const first = appendHolderIndexPage(
    null,
    page(1, [account(1, 7, '9007199254740992')]),
    mint,
    6,
  );
  const second = appendHolderIndexPage(
    first,
    page(2, [account(2, 7, '1'), account(3, 8, '9007199254740992')]),
    mint,
    6,
  );
  expect(first.accounts.size).toBe(1);
  expect(second.status).toBe('partial');
  const complete = appendHolderIndexPage(second, page(3, []), mint, 6);
  expect(complete.status).toBe('enumerated');
  const result = holderIndexSummary(complete);
  expect(result.holders[0]).toMatchObject({
    owner: address(7),
    raw: 9007199254740993n,
    accountCount: 2,
  });
  expect(result.remainderRaw).toBe('18428729675200069630');
  expect(result.coveredPercent).toBeLessThan(100);
});

it('rejects overlapping pages without mutating prior accumulation', () => {
  const first = appendHolderIndexPage(
    null,
    page(1, [account(1, 7, '20')]),
    mint,
    6,
  );
  expect(() =>
    appendHolderIndexPage(first, page(2, [account(1, 7, '21')]), mint, 6),
  ).toThrow('overlap');
  expect(first.indexedRaw).toBe(20n);
  expect(first.pages).toBe(1);
});

it('rejects foreign mints, invalid precision, missing indexed slots and mixed supply revisions', () => {
  expect(() =>
    decodeHolderIndexPage(
      {
        last_indexed_slot: '1',
        token_accounts: [{ ...account(1, 7, '1'), mint: address(8) }],
      },
      supply,
      mint,
      1,
      'index.test',
    ),
  ).toThrow();
  expect(() =>
    decodeHolderIndexPage(
      { token_accounts: [] },
      supply,
      mint,
      1,
      'index.test',
    ),
  ).toThrow();
  expect(() => page(1, [account(1, 7, '18446744073709551616')])).toThrow();
  const first = appendHolderIndexPage(
    null,
    page(1, [account(1, 7, '20')]),
    mint,
    6,
  );
  expect(() =>
    appendHolderIndexPage(
      first,
      { ...page(2, []), totalSupplyRaw: '21' },
      mint,
      6,
    ),
  ).toThrow('context changed');
  expect(() => appendHolderIndexPage(first, page(3, []), mint, 6)).toThrow(
    'context changed',
  );
  expect(() => appendHolderIndexPage(null, page(1, []), mint, 9)).toThrow();
});

it('fails reconciliation when accumulated balances exceed mint supply', () => {
  expect(() =>
    appendHolderIndexPage(
      null,
      page(1, [account(1, 7, supply.value.amount), account(2, 8, '1')]),
      mint,
      6,
    ),
  ).toThrow('exceed supply');
});

it('requests finalized mint-filtered cursor accounts and preserves numeric amount spelling', async () => {
  env.SOLANA_INDEXER_RPC_URL = 'https://index.test';
  const calls: Array<{ method: string; params: unknown }> = [];
  const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('RPC JSON required.');
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'getGenesisHash')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: SOLANA_MAINNET_GENESIS,
      });
    if (body.method === 'getTokenSupply')
      return Response.json({ jsonrpc: '2.0', id: 1, result: supply });
    const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    if (body.method === 'getAccountInfo')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { owner: program, executable: false } },
      });
    return new Response(
      '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":200},"value":{"paginationKey":null,"accounts":[{"pubkey":"' +
        address(1) +
        '","account":{"owner":"' +
        program +
        '","executable":false,"data":{"parsed":{"type":"account","info":{"owner":"' +
        address(7) +
        '","mint":"' +
        mint +
        '","state":"initialized","tokenAmount":{"amount":9007199254740993,"decimals":6}}}}}}]}}}',
    );
  });
  try {
    const result = await observeHolderIndexPage(
      mint,
      1,
      new AbortController().signal,
      fetcher,
      null,
      'program-accounts-v2',
    );
    expect(result.accounts[0].raw).toBe('9007199254740993');
    expect(calls.at(-1)).toMatchObject({
      method: 'getProgramAccountsV2',
      params: [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        {
          commitment: 'finalized',
          filters: [{ memcmp: { offset: 0, bytes: mint } }],
        },
      ],
    });
    expect(result.nextCursor).toBeNull();
  } finally {
    delete env.SOLANA_INDEXER_RPC_URL;
  }
});
