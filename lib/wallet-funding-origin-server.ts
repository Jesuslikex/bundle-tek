import bs58 from 'bs58';
import { SOLANA_MAINNET_GENESIS, WalletRpcError } from './wallet-balances';
import { env } from '@/lib/server-env';
import { fundingOriginRpc } from './wallet-funding-origin-rpc';
import { validSolanaSigningKey } from './solana-signature';
import {
  decodeFullWalletFundingOrigin,
  inspectFullFundingOriginHistory,
} from './wallet-funding-origin';
import {
  fundingOriginBatchSelection,
  fundingOriginBatch,
  type FundingOriginBatch,
} from './wallet-funding-origin-view';
export class FundingOriginReadError extends Error {
  constructor(readonly status: number) {
    super('Provider funding history unavailable.');
  }
}
type Rpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
/** Server-only dependencies. No endpoint or RPC implementation is accepted from request JSON. */
export async function readOwnedFundingOrigins(
  db: D1Database,
  owner: string,
  value: unknown,
  requestSignal: AbortSignal,
  options: { endpoint?: string; rpc?: Rpc; now?: () => number } = {},
) {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(45000)]);
  const { wallets, context } = fundingOriginBatchSelection.parse(value);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    throw new FundingOriginReadError(400);
  const now = options.now ?? Date.now;
  const addresses = JSON.stringify(context.map((w) => w.address));
  async function owned() {
    signal.throwIfAborted();
    const rows = await db
      .prepare(
        "SELECT address,revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (SELECT value FROM json_each(?))",
      )
      .bind(owner, addresses)
      .all<{ address: string; revision: number }>();
    signal.throwIfAborted();
    if (
      rows.results.length !== context.length ||
      context.some(
        (w) =>
          !rows.results.some(
            (r) => r.address === w.address && r.revision === w.revision,
          ),
      )
    )
      throw new FundingOriginReadError(409);
  }
  await owned();
  let endpoint: string;
  try {
    const configured = options.endpoint ?? env.SOLANA_HOLDER_RPC_URL;
    if (!configured) throw Error();
    endpoint = configured;
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      ![
        'solana-mainnet.g.alchemy.com',
        'solana-mainnet.g.alchemyapi.io',
      ].includes(url.hostname)
    )
      throw Error();
  } catch {
    throw new FundingOriginReadError(503);
  }
  const at = now();
  const gate = await db
    .prepare(
      'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
    )
    .bind(JSON.stringify(['wallet-funding-origins-v1', owner]), at + 60000, at)
    .run();
  if (!gate.meta.changes) throw new FundingOriginReadError(429);
  try {
    signal.throwIfAborted();
    const rpc: Rpc = async (method, params, currentSignal) => {
      currentSignal.throwIfAborted();
      try {
        const result = options.rpc
          ? await options.rpc(method, params, currentSignal)
          : await fundingOriginRpc(endpoint, method, params, currentSignal);
        currentSignal.throwIfAborted();
        return result;
      } catch (error) {
        if (currentSignal.aborted) throw currentSignal.reason;
        throw new FundingOriginReadError(
          error instanceof WalletRpcError && error.status === 429 ? 429 : 502,
        );
      }
    };
    if ((await rpc('getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS)
      throw new FundingOriginReadError(502);
    await owned();
    const rows: FundingOriginBatch['wallets'] = [];
    const pending: {
      wallet: (typeof wallets)[number];
      history: unknown;
      signature: string;
    }[] = [];
    for (const wallet of wallets) {
      signal.throwIfAborted();
      if (!validSolanaSigningKey(bs58.decode(wallet.address))) {
        rows.push({ ...wallet, funding: null, reason: 'unsupported-address' });
        continue;
      }
      const history = await rpc(
        'getTransactionsForAddress',
        [
          wallet.address,
          {
            transactionDetails: 'full',
            sortOrder: 'asc',
            limit: 1,
            commitment: 'finalized',
            encoding: 'base64',
            maxSupportedTransactionVersion: 0,
          },
        ],
        signal,
      );
      const candidate = inspectFullFundingOriginHistory(history, now());
      if (!candidate.record)
        rows.push({ ...wallet, funding: null, reason: candidate.reason });
      else
        pending.push({
          wallet,
          history,
          signature: candidate.record.signature,
        });
      await owned();
    }
    if (pending.length) {
      const raw = (await rpc(
        'getSignatureStatuses',
        [pending.map((p) => p.signature), { searchTransactionHistory: true }],
        signal,
      )) as { context?: { slot?: unknown }; value?: unknown[] } | null;
      if (
        !raw ||
        !Array.isArray(raw.value) ||
        raw.value.length !== pending.length ||
        !raw.context
      )
        throw new FundingOriginReadError(502);
      await owned();
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        const decoded = decodeFullWalletFundingOrigin(
          item.wallet.address,
          item.history,
          raw.value[i],
          raw.context.slot,
          now(),
        );
        rows.push({
          ...item.wallet,
          funding: decoded.funding,
          reason: decoded.reason,
        });
      }
    }
    await owned();
    rows.sort(
      (a, b) =>
        wallets.findIndex((w) => w.address === a.address) -
        wallets.findIndex((w) => w.address === b.address),
    );
    const result = fundingOriginBatch.parse({
      context,
      format: 'wallet-funding-origins-v1',
      network: 'mainnet',
      scope: 'oldest-provider-reported-transaction',
      ledgerMetadata: 'provider-reported',
      historyComplete: false,
      signingAllowed: false,
      executionAllowed: false,
      capturedAt: new Date(now()).toISOString(),
      wallets: rows,
    });
    signal.throwIfAborted();
    return result;
  } finally {
    // Exact lease CAS: a late request cannot release a newer owner's gate.
    try {
      await db
        .prepare(
          'UPDATE imported_token_project_gates SET next_allowed_at=? WHERE owner_id=? AND next_allowed_at=?',
        )
        .bind(
          Math.max(now(), at) + 15000,
          JSON.stringify(['wallet-funding-origins-v1', owner]),
          at + 60000,
        )
        .run();
    } catch {
      /* Failed cleanup leaves the conservative lease expiry intact. */
    }
  }
}
