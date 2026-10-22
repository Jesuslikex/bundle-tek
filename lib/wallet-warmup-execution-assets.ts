import { address } from '@solana/kit';
import { readWarmupExecutionSource } from './wallet-warmup-execution-source';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
  SWAP_TOKEN_2022_ACCOUNT_SIZE,
} from './swap-token-program-evidence';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

export class WarmupExecutionAssetsError extends Error {
  constructor() {
    super(
      'Current warmup asset evidence is unavailable or changed. Request a fresh review.',
    );
    this.name = 'WarmupExecutionAssetsError';
  }
}
const fail = (): never => {
  throw new WarmupExecutionAssetsError();
};
function slot(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail();
  return Number(value);
}
function decoderAccountProjection(value: unknown, rent: boolean) {
  const a = value as {
    owner: string;
    executable: false;
    data: [string, string];
    lamports?: string;
    space?: string;
  };
  return {
    owner: a.owner,
    executable: a.executable,
    data: [...a.data],
    ...(rent ? { lamports: a.lamports } : {}),
    ...(rent && a.space !== undefined ? { space: a.space } : {}),
  };
}

/** Server-internal read only. No HTTP/body-supplied mint policy, provider URL,
 * approval or fee formula. Token-account rent is not total setup/gross spending. */
export async function inspectWarmupExecutionAssets(
  db: D1Database,
  owner: string,
  selection: unknown,
  parentSignal: AbortSignal,
  dependencies: { fetcher?: typeof fetch; now?: () => number } = {},
) {
  try {
    parentSignal.throwIfAborted();
    const now = dependencies.now ?? Date.now;
    const fetcher = dependencies.fetcher ?? fetch;
    const source = await readWarmupExecutionSource(
      db,
      owner,
      selection,
      parentSignal,
      now,
    );
    const capturedSelection = {
      reviewId: source.retainedReview.id,
      reviewSha256: source.retainedReview.reviewSha256,
    };
    const started = now();
    const deadline = Math.min(
      started + 25000,
      Date.parse(source.retainedReview.reviewExpiresAt),
    );
    if (!Number.isSafeInteger(started) || deadline <= started) return fail();
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(deadline - started),
    ]);
    const fresh = () => {
      signal.throwIfAborted();
      const at = now();
      if (!Number.isSafeInteger(at) || at < started || at >= deadline) fail();
      return at;
    };
    const mints = [
      ...new Set(
        source.retainedReview.document.actions.map((action) => action.mint),
      ),
    ];
    if (!mints.length || mints.length > 10 || mints.includes(SWAP_WRAPPED_SOL))
      return fail();
    mints.forEach((mint) => address(mint));
    const captured = getSolanaIndexerRpcEndpoint();
    const url = new URL(captured);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return fail();
    const rpc = async (method: string, params: unknown[]) => {
      fresh();
      const result = await balanceRpc(
        captured,
        method,
        params,
        signal,
        async (input, init) => {
          const response = await fetcher(input, init);
          if (!response.ok) await response.body?.cancel().catch(() => {});
          return response;
        },
        524288,
      );
      fresh();
      return result;
    };
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    const floor = slot(await rpc('getSlot', [{ commitment: 'confirmed' }]));
    const accounts = [SWAP_WRAPPED_SOL, ...mints, PAIR_CLOCK, PAIR_RENT];
    const observe = async (minimum: number) => {
      const raw = (await rpc('getMultipleAccounts', [
        accounts,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: minimum,
        },
      ])) as { context?: { slot?: unknown }; value?: unknown[] };
      const at = slot(raw?.context?.slot);
      if (
        at < minimum ||
        !Array.isArray(raw.value) ||
        raw.value.length !== accounts.length
      )
        return fail();
      requireConsistentSolanaSlots([floor, at]);
      const clockAccount = raw.value.at(-2);
      const evaluatedServerAt = fresh();
      const unixTimestamp = pairClockUnixTimestamp(
        clockAccount,
        at,
        evaluatedServerAt,
      );
      const rent = inspectPairRentAccount(raw.value.at(-1));
      const facts = await Promise.all(
        raw.value
          .slice(0, -2)
          .map((account, index) =>
            inspectSwapMintAccount(account, accounts[index]),
          ),
      );
      fresh();
      return {
        slot: at,
        unixTimestamp,
        evaluatedServerAt: new Date(evaluatedServerAt).toISOString(),
        rent,
        mints: facts,
        accounts: raw.value.map((account, index) => ({
          address: accounts[index],
          account: decoderAccountProjection(
            account,
            accounts[index] === PAIR_RENT,
          ),
        })),
      };
    };
    const before = await observe(floor);
    const after = await observe(before.slot);
    assertSameSwapMintEvidence(before, after);
    if (canonical(before.rent) !== canonical(after.rent)) return fail();
    const savedSource = JSON.parse(source.sourceDocument) as {
      buys: { id: string; document: string }[];
    };
    for (const action of source.retainedReview.document.actions) {
      if (action.side !== 'Sell' || action.source.kind !== 'saved-buy')
        continue;
      const receiptId = action.source.buyReceiptId;
      const row = savedSource.buys.find((buy) => buy.id === receiptId);
      if (!row || typeof row.document !== 'string') return fail();
      const lot = JSON.parse(row.document) as {
        tokenProgram?: unknown;
        decimals?: unknown;
        mint?: unknown;
        wallet?: unknown;
      };
      const mint = after.mints.find((mint) => mint.address === action.mint);
      if (
        !mint ||
        ![SWAP_TOKEN, SWAP_TOKEN_2022].includes(String(lot.tokenProgram)) ||
        lot.tokenProgram !== mint.program ||
        lot.decimals !== mint.decimals ||
        lot.decimals !== action.source.decimals ||
        lot.mint !== action.mint ||
        lot.wallet !== action.wallet
      )
        return fail();
    }
    const current = await readWarmupExecutionSource(
      db,
      owner,
      capturedSelection,
      signal,
      now,
    );
    const checkedAt = new Date(fresh()).toISOString();
    if (current.sourceSnapshotSha256 !== source.sourceSnapshotSha256)
      return fail();
    const evidence = {
      format: 'wallet-warmup-execution-assets-v1' as const,
      ownerId: owner,
      reviewId: source.retainedReview.id,
      reviewSha256: source.retainedReview.reviewSha256,
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      provider: url.hostname,
      network: 'mainnet' as const,
      commitment: 'confirmed' as const,
      floorSlot: floor,
      before,
      after,
      tokenAccountRents: after.mints.map((mint) => {
        const accountSize =
          mint.program === SWAP_TOKEN ? 165 : SWAP_TOKEN_2022_ACCOUNT_SIZE;
        return {
          ...mint,
          accountSize,
          minimumRentLamports: pairRentMinimumRaw(after.rent, accountSize),
        };
      }),
      checkedAt,
      expiresAt: new Date(deadline).toISOString(),
      scope: 'mint-policy-and-token-account-rent-only' as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
    const evidenceSha256 = await digest(canonical(evidence));
    fresh();
    return { evidence, evidenceSha256 };
  } catch {
    parentSignal.throwIfAborted();
    return fail();
  }
}
