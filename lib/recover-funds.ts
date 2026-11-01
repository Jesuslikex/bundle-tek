import type { VaultSession } from './browser-wallet-vault';
import {
  signNativeWithdrawal,
  validatedNativeWithdrawal,
  type NativeWithdrawal,
} from './native-withdrawal';
import { WITHDRAWAL_OWNER_SCOPE_HEADER } from './native-withdrawal-owner-scope';
import { readBoundedPanelJson } from './read-bounded-panel-json';

// Recover Funds (Proxima "Clean Dust"): find leftover launch assets and,
// on the user's explicit Reclaim, sell each wallet's tokens and withdraw its
// SOL to the default Funder. Every transaction is one the user asked for on
// that row; each wallet signs from the unlocked browser vault.

/** One-signature legacy transfer fee and the 0-byte rent reserve kept behind. */
export const WITHDRAW_FEE_LAMPORTS = 5000n;
export const WITHDRAW_RESERVE_LAMPORTS = 890880n;
/** Proxima hides non-empty launches worth less than this after valuation. */
export const RECOVER_HIDE_BELOW_USD = 0.5;

export function reclaimableLamports(nativeRaw: bigint) {
  const left = nativeRaw - WITHDRAW_FEE_LAMPORTS - WITHDRAW_RESERVE_LAMPORTS;
  return left > 0n ? left : 0n;
}

export type RecoverWalletBalance = {
  address: string;
  revision: number;
  nativeRaw: bigint;
  tokenRaw: bigint;
};
export type RecoverRow = {
  projectId: string;
  symbol: string;
  archived: boolean;
  wallets: RecoverWalletBalance[];
  tokenRaw: bigint;
  supplyPercent: number;
  tokenUsd: number | null;
  nativeLamports: bigint;
  empty: boolean;
};
export type RecoverFilters = {
  maxSupplyPercent?: number;
  minUsd?: number;
  includeEmpty: boolean;
};

export function summarizeRow(
  base: Omit<
    RecoverRow,
    'tokenRaw' | 'supplyPercent' | 'tokenUsd' | 'nativeLamports' | 'empty'
  >,
  decimals: number,
  totalSupplyRaw: bigint,
  priceUsd: number | null,
): RecoverRow {
  const tokenRaw = base.wallets.reduce((t, w) => t + w.tokenRaw, 0n);
  const nativeLamports = base.wallets.reduce(
    (t, w) => t + reclaimableLamports(w.nativeRaw),
    0n,
  );
  const tokens = Number(tokenRaw) / 10 ** decimals;
  return {
    ...base,
    tokenRaw,
    nativeLamports,
    supplyPercent:
      totalSupplyRaw > 0n
        ? (Number(tokenRaw) / Number(totalSupplyRaw)) * 100
        : 0,
    tokenUsd: priceUsd === null ? null : tokens * priceUsd,
    empty: tokenRaw === 0n && nativeLamports === 0n,
  };
}

/** Rows shown by the filters; `solUsd` values reclaimable SOL. */
export function filterRecoverRows(
  rows: RecoverRow[],
  f: RecoverFilters,
  solUsd: number | null,
) {
  return rows.filter((r) => {
    if (r.empty) return f.includeEmpty;
    if (
      f.maxSupplyPercent !== undefined &&
      r.supplyPercent > f.maxSupplyPercent
    )
      return false;
    const usd =
      (r.tokenUsd ?? 0) +
      (solUsd === null ? 0 : (Number(r.nativeLamports) / 1e9) * solUsd);
    if (
      usd < RECOVER_HIDE_BELOW_USD &&
      (r.tokenUsd !== null || solUsd !== null)
    )
      return false;
    if (f.minUsd !== undefined && usd < f.minUsd) return false;
    return true;
  });
}

export class WithdrawUncertainError extends Error {
  readonly uncertain = true;
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
  }
}

async function call(
  fetcher: typeof fetch,
  ownerScope: string,
  body: object,
  signal: AbortSignal,
): Promise<NativeWithdrawal> {
  const response = await fetcher('/api/wallet-workspace/withdrawals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WITHDRAWAL_OWNER_SCOPE_HEADER]: ownerScope,
    },
    credentials: 'same-origin',
    redirect: 'error',
    body: JSON.stringify(body),
    signal,
  });
  if (
    response.headers.get(WITHDRAWAL_OWNER_SCOPE_HEADER) !== ownerScope &&
    response.status === 401
  )
    throw new Error('Signed-in account changed. Sign in again.');
  let value: { withdrawal?: NativeWithdrawal; error?: string } = {};
  try {
    value = (await readBoundedPanelJson(response, signal)) as typeof value;
  } catch {
    /* handled below */
  }
  if (!response.ok || !value.withdrawal)
    throw new Error(
      value.error || `Withdrawal action unavailable (HTTP ${response.status}).`,
    );
  return validatedNativeWithdrawal(value.withdrawal);
}

const lamportsText = (raw: bigint) => {
  const padded = raw.toString().padStart(10, '0');
  const fraction = padded.slice(-9).replace(/0+$/, '');
  return padded.slice(0, -9) + (fraction ? `.${fraction}` : '');
};

/**
 * Withdraws `lamports` of SOL from one wallet to the Funder through the
 * existing guarded withdrawal pipeline: prepare -> begin_signing -> local vault
 * signature -> register -> one submit. A signed withdrawal is never resent.
 */
export async function withdrawSolToFunder(input: {
  wallet: { address: string; revision: number };
  funder: string;
  lamports: bigint;
  ownerScope: string;
  session: VaultSession;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  sign?: typeof signNativeWithdrawal;
}) {
  const fetcher = input.fetcher ?? fetch;
  const sign = input.sign ?? signNativeWithdrawal;
  if (input.lamports <= 0n) throw new Error('Nothing to withdraw.');
  const prepared = await call(
    fetcher,
    input.ownerScope,
    {
      action: 'prepare',
      wallet: input.wallet.address,
      walletRevision: input.wallet.revision,
      recipient: input.funder,
      amount: lamportsText(input.lamports),
    },
    input.signal,
  );
  const doc = prepared.document;
  if (
    prepared.state !== 'awaiting_signature' ||
    doc.wallet !== input.wallet.address ||
    doc.recipient !== input.funder ||
    doc.amountRaw !== input.lamports.toString() ||
    doc.token !== undefined
  )
    throw new Error('Prepared withdrawal does not match this reclaim.');
  const begun = await call(
    fetcher,
    input.ownerScope,
    { action: 'begin_signing', id: prepared.id },
    input.signal,
  );
  if (begun.state !== 'signing')
    throw new Error('Signing reservation unavailable.');
  let signed: { signature: string; transaction: string };
  try {
    signed = await sign(input.session, doc, () =>
      input.signal.throwIfAborted(),
    );
  } catch (error) {
    // Nothing was signed: release the reservation.
    await call(
      fetcher,
      input.ownerScope,
      { action: 'reject_signing', id: prepared.id, noSignatureVerified: true },
      AbortSignal.timeout(15000),
    ).catch(() => {});
    throw error;
  }
  try {
    const registered = await call(
      fetcher,
      input.ownerScope,
      { action: 'register', id: prepared.id, transaction: signed.transaction },
      AbortSignal.timeout(15000),
    );
    if (
      registered.signature !== signed.signature ||
      registered.state !== 'signed'
    )
      throw new Error('Signature registration did not match.');
    const submitted = await call(
      fetcher,
      input.ownerScope,
      { action: 'submit', id: prepared.id, transaction: signed.transaction },
      AbortSignal.timeout(35000),
    );
    if (
      submitted.signature !== signed.signature ||
      !['submitted', 'finalized'].includes(submitted.state)
    )
      throw new Error('Submission acknowledgement differs.');
  } catch (error) {
    throw new WithdrawUncertainError(
      `${error instanceof Error ? error.message : 'Submission unknown'}. Check signature ${signed.signature} in withdrawal history; it will not be resent.`,
      signed.signature,
    );
  }
  return { id: prepared.id, signature: signed.signature };
}

/** Native SOL balances for up to 100 wallets per gated read, waiting out 429s. */
export async function readNativeBalances(
  addresses: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, s) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      s.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('Stopped.'));
        },
        { once: true },
      );
    }),
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher('/api/wallet-workspace/balances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain: 'Solana', addresses: chunk }),
        signal,
      });
      if (response.status === 429 && attempt < 4) {
        await sleep(15250, signal);
        continue;
      }
      const data = (await response.json().catch(() => ({}))) as {
        snapshot?: { items?: { address?: string; raw?: string }[] };
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.snapshot?.items))
        throw new Error(data.error || 'Native balances unavailable.');
      for (const item of data.snapshot.items) {
        if (
          typeof item.address === 'string' &&
          chunk.includes(item.address) &&
          typeof item.raw === 'string' &&
          /^(0|[1-9]\d{0,19})$/.test(item.raw)
        )
          out[item.address] = BigInt(item.raw);
      }
      if (chunk.some((a) => out[a] === undefined))
        throw new Error('Native balances incomplete.');
      break;
    }
  }
  return out;
}
