import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { PUMP_NATIVE_QUOTE, PUMP_TOKEN_2022 } from './pump-launch-config';
import type { SniperGuardCurveBuy, SniperGuardLaunch } from './sniper-guard';

/** Read-only RPC. The Sniper Guard reader never prepares, signs or sends. */
export type SniperGuardRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export const SNIPER_GUARD_RPC_METHODS = [
  'getSignaturesForAddress',
  'getTransaction',
  'getMultipleAccounts',
] as const;
export const SNIPER_GUARD_PAGE = 100;
export const SNIPER_GUARD_MAX_PAGES = 5;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const fail = (message: string): never => {
  throw new Error(message);
};

type ParsedKey = { pubkey: string; signer: boolean };
type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};
type ParsedTransaction = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ParsedKey[] };
  };
};
const amount = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    fail('Curve balance differs.');
  return BigInt(value as string);
};
/**
 * The curve whose quote reserve is watched. Pump curves hold SOL as lamports
 * or own their quote token account; LaunchLab and Meteora DBC pools keep the
 * quote in a vault owned by a shared authority, so those name `quoteVault`.
 */
export type CurveScope = Pick<
  SniperGuardLaunch,
  'bondingCurve' | 'quoteMint'
> & {
  quoteVault?: string;
};

/**
 * Measures how much quote one successful transaction paid into the bonding
 * curve: lamports for a SOL launch, the curve's quote token account for
 * USDC/stock launches. Sells and unrelated transactions return null.
 */
export function decodeCurveBuy(
  value: unknown,
  scope: CurveScope,
): SniperGuardCurveBuy | null {
  const tx = value as ParsedTransaction;
  if (
    !tx ||
    !tx.meta ||
    !tx.transaction?.message ||
    !Array.isArray(tx.transaction.message.accountKeys) ||
    !Array.isArray(tx.transaction.signatures) ||
    !Number.isSafeInteger(tx.slot)
  )
    return fail('Curve transaction is incomplete.');
  if (tx.meta.err !== null && tx.meta.err !== undefined) return null;
  const keys = tx.transaction.message.accountKeys;
  if (
    keys.some((k) => !k || typeof k.pubkey !== 'string') ||
    tx.meta.preBalances.length !== keys.length ||
    tx.meta.postBalances.length !== keys.length
  )
    return fail('Curve transaction accounts differ.');
  let delta = 0n;
  if (scope.quoteVault) {
    const vault = scope.quoteVault;
    const vaultQuote = (rows: TokenBalance[] | undefined) => {
      if (!Array.isArray(rows))
        return fail('Curve token balances are unavailable.');
      const matches = rows.filter(
        (row) =>
          row.mint === scope.quoteMint &&
          keys[row.accountIndex]?.pubkey === vault,
      );
      if (matches.length > 1) fail('Curve quote account is ambiguous.');
      return matches.length ? amount(matches[0].uiTokenAmount?.amount) : null;
    };
    const before = vaultQuote(tx.meta.preTokenBalances),
      after = vaultQuote(tx.meta.postTokenBalances);
    if (after === null) return null;
    delta = after - (before ?? 0n);
  } else if (scope.quoteMint === PUMP_NATIVE_QUOTE) {
    const index = keys.findIndex((k) => k.pubkey === scope.bondingCurve);
    if (index < 0) return null;
    delta =
      BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
  } else {
    const curveQuote = (rows: TokenBalance[] | undefined) => {
      if (!Array.isArray(rows))
        return fail('Curve token balances are unavailable.');
      const matches = rows.filter(
        (row) =>
          row.mint === scope.quoteMint && row.owner === scope.bondingCurve,
      );
      if (matches.length > 1) fail('Curve quote account is ambiguous.');
      return matches.length ? amount(matches[0].uiTokenAmount?.amount) : null;
    };
    const before = curveQuote(tx.meta.preTokenBalances),
      after = curveQuote(tx.meta.postTokenBalances);
    if (after === null) return null;
    delta = after - (before ?? 0n);
  }
  if (delta <= 0n) return null;
  const signers = keys.filter((k) => k.signer === true).map((k) => k.pubkey);
  if (!signers.length) return fail('Curve transaction has no signer.');
  const signature = tx.transaction.signatures[0];
  if (!SIGNATURE.test(signature)) return fail('Curve signature differs.');
  return {
    signature,
    slot: tx.slot,
    blockTime:
      Number.isSafeInteger(tx.blockTime) && (tx.blockTime as number) >= 0
        ? tx.blockTime
        : null,
    signers,
    quoteInRaw: delta.toString(),
  };
}

type SignatureRow = { signature: string; slot: number; err: unknown };

/**
 * Collects curve buys newer than `untilSignature`, oldest first. Stops at the
 * first transaction the RPC cannot return yet, so the next poll resumes there.
 * `complete` is false when more than the bounded page budget arrived at once;
 * the total is then a lower bound.
 */
export async function readCurveBuys(
  rpc: SniperGuardRpc,
  scope: CurveScope,
  untilSignature: string | null,
  signal: AbortSignal,
  maxPages = SNIPER_GUARD_MAX_PAGES,
) {
  const newestFirst: SignatureRow[] = [];
  let before: string | undefined,
    complete = false;
  for (let page = 0; page < maxPages; page++) {
    signal.throwIfAborted();
    const rows = (await rpc(
      'getSignaturesForAddress',
      [
        scope.bondingCurve,
        {
          limit: SNIPER_GUARD_PAGE,
          commitment: 'confirmed',
          ...(before ? { before } : {}),
          ...(untilSignature ? { until: untilSignature } : {}),
        },
      ],
      signal,
    )) as SignatureRow[];
    if (!Array.isArray(rows) || rows.length > SNIPER_GUARD_PAGE)
      fail('Curve signature page differs.');
    for (const row of rows)
      if (
        !row ||
        !SIGNATURE.test(row.signature) ||
        !Number.isSafeInteger(row.slot)
      )
        fail('Curve signature differs.');
    newestFirst.push(...rows);
    if (rows.length < SNIPER_GUARD_PAGE) {
      complete = true;
      break;
    }
    before = rows.at(-1)!.signature;
  }
  if (new Set(newestFirst.map((r) => r.signature)).size !== newestFirst.length)
    fail('Curve signature pages overlap.');
  const ordered = newestFirst.reverse();
  const buys: SniperGuardCurveBuy[] = [];
  let cursor = untilSignature,
    pending = false;
  for (let start = 0; start < ordered.length && !pending; start += 8) {
    const chunk = ordered.slice(start, start + 8);
    const results = await Promise.all(
      chunk.map((row) =>
        row.err !== null && row.err !== undefined
          ? Promise.resolve('failed' as const)
          : rpc(
              'getTransaction',
              [
                row.signature,
                {
                  encoding: 'jsonParsed',
                  commitment: 'confirmed',
                  maxSupportedTransactionVersion: 0,
                },
              ],
              signal,
            ),
      ),
    );
    for (let i = 0; i < chunk.length; i++) {
      const result = results[i];
      if (result === null || result === undefined) {
        pending = true;
        break;
      }
      if (result !== 'failed') {
        const buy = decodeCurveBuy(result, scope);
        if (buy) {
          if (buy.signature !== chunk[i].signature)
            fail('Curve transaction signature differs.');
          buys.push(buy);
        }
      }
      cursor = chunk[i].signature;
    }
  }
  return { buys, cursor, complete: complete && !pending, pending };
}

/** Token balances of the wallets a Nuke would sell, for the review list. */
export async function readLaunchTokenBalances(
  rpc: SniperGuardRpc,
  mint: string,
  wallets: string[],
  signal: AbortSignal,
) {
  if (!wallets.length) return [];
  const accounts = await Promise.all(
    wallets.map(
      async (owner) =>
        (
          await findAssociatedTokenPda({
            owner: address(owner),
            mint: address(mint),
            tokenProgram: address(PUMP_TOKEN_2022),
          })
        )[0],
    ),
  );
  const result = (await rpc(
    'getMultipleAccounts',
    [accounts, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    signal,
  )) as { value?: unknown[] };
  if (!Array.isArray(result?.value) || result.value.length !== wallets.length)
    fail('Launch wallet balances differ.');
  return wallets.map((wallet, index) => {
    const account = result.value![index] as {
      data?: {
        parsed?: {
          info?: {
            mint?: string;
            owner?: string;
            tokenAmount?: { amount?: string; decimals?: number };
          };
        };
      };
    } | null;
    if (!account)
      return { wallet, tokenAccount: String(accounts[index]), amountRaw: '0' };
    const info = account.data?.parsed?.info;
    if (info?.mint !== mint || info?.owner !== wallet)
      fail('Launch wallet token account differs.');
    const decimals = info?.tokenAmount?.decimals;
    return {
      wallet,
      tokenAccount: String(accounts[index]),
      amountRaw: amount(info?.tokenAmount?.amount).toString(),
      ...(Number.isInteger(decimals) && decimals! >= 0 && decimals! <= 18
        ? { decimals: decimals! }
        : {}),
    };
  });
}
