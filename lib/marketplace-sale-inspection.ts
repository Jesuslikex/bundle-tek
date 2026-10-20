import { z } from 'zod';
import {
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
  type MarketplaceOwnedWallet,
} from './marketplace-owned-inventory';
import { operatorListingSelection } from './marketplace-operator-review';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const slot = uint.refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
const lamports = uint.refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const systemProgram = '11111111111111111111111111111111';
const accountResult = z.object({
  context: z.object({ slot }),
  value: z
    .object({
      lamports,
      owner: z.string().min(32).max(44),
      executable: z.boolean(),
      space: slot,
      data: z.tuple([z.literal(''), z.literal('base64')]),
    })
    .nullable(),
});

/** Server-internal inspection only. Callers must authorize the seller before invoking it.
 * No listing, payment or key-delivery authority can be derived from this snapshot. */
export async function inspectMarketplaceSaleWallet(
  readInventory: () => Promise<MarketplaceOwnedInventory>,
  input: unknown,
  options: {
    signal: AbortSignal;
    fetcher?: typeof fetch;
    now?: () => number;
  },
) {
  const { fetcher = fetch, now = Date.now } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60000)]);
  const selection = operatorListingSelection.parse(input);
  signal.throwIfAborted();
  const startedAt = now();
  const before = admitMarketplaceOwnedInventory(await readInventory(), now());
  const wallet = before.wallets.find(
    (w) =>
      w.address === selection.address &&
      w.revision === selection.walletRevision,
  );
  if (!wallet) throw Error('Seller wallet changed. Reload inventory.');
  signal.throwIfAborted();
  const endpoint = getSolanaRpcEndpoint('mainnet');
  const rpc = async (method: string, params: unknown[]) => {
    signal.throwIfAborted();
    const value = await balanceRpc(
      endpoint,
      method,
      params,
      signal,
      fetcher,
      16384,
    );
    signal.throwIfAborted();
    return value;
  };
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw Error('Sale inspection provider network differs.');
  const floor = Number(
    slot.parse(await rpc('getSlot', [{ commitment: 'confirmed' }])),
  );
  const observed = accountResult.parse(
    await rpc('getAccountInfo', [
      selection.address,
      {
        commitment: 'confirmed',
        encoding: 'base64',
        dataSlice: { offset: 0, length: 0 },
        minContextSlot: floor,
      },
    ]),
  );
  const accountSlot = Number(observed.context.slot);
  if (accountSlot < floor)
    throw Error('Sale inspection account predates its floor.');
  const finalSlot = Number(
    slot.parse(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: accountSlot },
      ]),
    ),
  );
  if (finalSlot < accountSlot)
    throw Error('Sale inspection final slot predates the account.');
  requireConsistentSolanaSlots([floor, accountSlot, finalSlot]);
  const after = admitMarketplaceOwnedInventory(await readInventory(), now());
  signal.throwIfAborted();
  const current = after.wallets.find((w) => w.address === selection.address);
  // Age is derived at read time. Compare original retained sources, not this advancing counter.
  const binding = (value: MarketplaceOwnedWallet | undefined) =>
    value && { ...value, observedActivityAgeSeconds: null };
  if (JSON.stringify(binding(current)) !== JSON.stringify(binding(wallet)))
    throw Error(
      'Seller wallet evidence changed during inspection. Reload inventory.',
    );
  const completedAt = now();
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - startedAt >= 60000
  )
    throw Error('Sale inspection expired. Request a new inspection.');
  const account = observed.value;
  const kind =
    account === null
      ? 'absent'
      : account.owner === systemProgram &&
          !account.executable &&
          account.space === '0'
        ? 'system-wallet'
        : 'unsupported-account';
  return {
    format: 'bundle-sale-account-inspection-v1' as const,
    chain: 'Solana' as const,
    selection,
    startedAt: new Date(startedAt).toISOString(),
    observedAt: new Date(completedAt).toISOString(),
    expiresAt: new Date(startedAt + 60000).toISOString(),
    source: new URL(endpoint).hostname,
    commitment: 'confirmed' as const,
    floorSlot: floor,
    accountSlot,
    finalSlot,
    account: {
      kind,
      balanceLamports: account?.lamports ?? '0',
      owner: account?.owner ?? null,
      executable: account?.executable ?? null,
      space: account?.space ?? null,
    },
    historicalControlProofAt: wallet.ownershipProofAt,
    historicalBalanceLamports: wallet.latestHistory?.balanceLamports ?? null,
    balanceDifferenceLamports:
      wallet.latestHistory === null
        ? null
        : (
            BigInt(account?.lamports ?? '0') -
            BigInt(wallet.latestHistory.balanceLamports)
          ).toString(),
    // A fresh account read says nothing about retained keys, token holdings, provenance or payment entitlement.
    currentControlVerified: false as const,
    tokenInventoryChecked: false as const,
    provenanceVerified: false as const,
    saleQualified: false as const,
    paymentAllowed: false as const,
    deliveryAllowed: false as const,
    signingAllowed: false as const,
  };
}
