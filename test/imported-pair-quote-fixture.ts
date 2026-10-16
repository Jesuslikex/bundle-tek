import { PAIR_CLOCK } from '../lib/pair-mint-evidence';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { chainQuoteAssets } from '../lib/quote-catalog';
import { importedTokenDocument } from '../lib/imported-token-project';
import { SWAP_TOKEN_2022 } from '../lib/swap-token-program-evidence';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { quoteSolanaPair } from '../lib/warmup-swap-quote';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import { PAIR_SYSVAR_OWNER } from '../lib/pair-mint-evidence';
import type {
  ImportedPairQuoteDependencies,
  ImportedPairQuoteRequest,
} from '../lib/imported-pair-quote-service';
import type { ImportedPairQuoteSelection } from '../lib/imported-trade-pair';
const baseMint = 'CktRuQ2mttgRGs5rGzYfih6myG3u5ksHhwRPPsRF2fAM';
export function pairQuoteMint(
  decimals: number,
  owner: string,
  extensions: ExtensionArgs[] = [],
) {
  const encoded = extensions.map((e) => getExtensionEncoder().encode(e));
  const bytes = new Uint8Array(
    encoded.length ? 166 + encoded.reduce((n, e) => n + e.length, 0) : 82,
  );
  bytes[44] = decimals;
  bytes[45] = 1;
  if (encoded.length) {
    bytes[165] = 1;
    let offset = 166;
    for (const e of encoded) {
      bytes.set(e, offset);
      offset += e.length;
    }
  }
  return {
    owner,
    executable: false,
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
export function pairQuoteClock(slot: number, unixTimestamp: string) {
  const bytes = new Uint8Array(40),
    view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(slot), true);
  view.setBigInt64(32, BigInt(unixTimestamp), true);
  return {
    owner: PAIR_SYSVAR_OWNER,
    executable: false,
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
export function importedPairQuoteFixture(
  side: 'Buy' | 'Sell' = 'Buy',
  quoteProgram = SWAP_TOKEN_2022,
) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('drizzle/0024_imported_token_projects.sql', 'utf8'));
  const id = crypto.randomUUID();
  const asset = chainQuoteAssets('Solana').find((a) => a.symbol === 'TSLAX')!;
  if (!asset) throw new Error('Captured stock quote fixture missing');
  const document = importedTokenDocument(
    { chain: 'Solana', address: baseMint },
    {
      chain: 'Solana',
      address: baseMint,
      name: 'Synthetic pair token',
      symbol: 'PAIR',
      decimals: 6,
      totalSupplyRaw: '1000000000',
      metadataUri: 'https://fixture.example/metadata.json',
      observedAt: new Date().toISOString(),
      source: 'https://fixture.example',
      contextSlot: 100,
      tokenProgram: SWAP_TOKEN_2022,
    },
  );
  sqlite
    .prepare(
      'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'alice',
      id,
      'Solana',
      baseMint,
      JSON.stringify(document),
      crypto.randomUUID(),
      new Date().toISOString(),
    );
  const adapter = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async run() {
          return {
            meta: {
              changes: Number(sqlite.prepare(sql).run(...values).changes),
            },
          };
        },
      };
    },
  };
  const db = adapter as unknown as D1Database;
  const mints = [
    pairQuoteMint(6, SWAP_TOKEN_2022),
    pairQuoteMint(asset.decimals, quoteProgram),
  ];
  const clockState = { unixTimestamp: null as string | null };
  const rpc = vi.fn(
    async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getSlot') return '100';
      if (method === 'getMultipleAccounts') {
        const options = params[1] as { minContextSlot: number };
        return {
          context: { slot: String(options.minContextSlot + 1) },
          value: (params[0] as string[]).map((key, i) =>
            key === PAIR_CLOCK
              ? pairQuoteClock(
                  options.minContextSlot + 1,
                  clockState.unixTimestamp ??
                    Math.floor(
                      (dependencies.now?.() ?? Date.now()) / 1000,
                    ).toString(),
                )
              : structuredClone(mints[i]),
          ),
        };
      }
      throw new Error('Unexpected quote-only RPC ' + method);
    },
  );
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      const parsed = new URL(
        typeof url === 'string' || url instanceof URL ? url : url.url,
      );
      return Response.json({
        inputMint: parsed.searchParams.get('inputMint'),
        outputMint: parsed.searchParams.get('outputMint'),
        inAmount: parsed.searchParams.get('amount'),
        outAmount: '1000000',
        otherAmountThreshold: '995000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        router: 'metis',
        transaction: 'provider-material-must-be-discarded',
        requestId: 'synthetic-quote-only',
      });
    },
  );
  const quote = vi.fn(
    (input: Parameters<typeof quoteSolanaPair>[0], signal: AbortSignal) =>
      quoteSolanaPair(
        input,
        'isolated-test-only',
        signal,
        fetcher as typeof fetch,
      ),
  );
  const dependencies: ImportedPairQuoteDependencies = { rpc, quote };
  const request: ImportedPairQuoteRequest = {
    id,
    revision: 1,
    quoteMint: asset.address,
    side,
    amount: side === 'Buy' ? '0.00000001' : '0.000001',
  };
  const selection: ImportedPairQuoteSelection = {
    projectId: id,
    projectRevision: 1,
    baseMint,
    baseDecimals: 6,
    baseSymbol: 'PAIR',
    quoteMint: asset.address,
    quoteDecimals: asset.decimals,
    quoteSymbol: asset.symbol,
    side,
    amount: request.amount,
  };
  return {
    db,
    sqlite,
    id,
    asset,
    document,
    mints,
    clockState,
    rpc,
    fetcher,
    quote,
    dependencies,
    request,
    selection,
    baseMint,
    close: () => sqlite.close(),
  };
}
