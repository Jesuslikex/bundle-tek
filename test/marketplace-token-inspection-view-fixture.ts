import bs58 from 'bs58';
import { marketplaceOwnedFixture } from './marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import {
  MARKETPLACE_TOKEN_PROGRAMS,
  MARKETPLACE_TOKEN_COVERAGE,
  tokenInspectionSourceHash,
  tokenInspectionCounts,
  type MarketplaceTokenAccount,
  type MarketplaceTokenInspection,
} from '@/lib/marketplace-token-inspection-view';
/** Synthetic informational records only; no provider, key material, signing or persistence. */
export async function marketplaceTokenViewFixture(now = Date.now(), count = 2) {
  const source = marketplaceOwnedFixture(now),
    inventory = buildMarketplaceOwnedInventory(source.sources, now);
  const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const selection = {
    address: source.a,
    walletRevision: 2,
    priceLamports: '50000000',
  };
  const accounts: MarketplaceTokenAccount[] = Array.from(
    { length: count },
    (_, i) => ({
      address: key(i + 3),
      program: MARKETPLACE_TOKEN_PROGRAMS[i % 2],
      walletOwner: source.a,
      mint: key(220 + (i % 10)),
      slot: 101 + (i % 2),
      amountRaw: i === 0 ? '0' : '18446744073709551615',
      lamports: '2039280',
      state: i % 4 === 0 ? 'frozen' : 'initialized',
      delegate: i % 3 === 0 ? key(250) : null,
      delegatedAmountRaw: i % 3 === 0 ? '5' : '0',
      closeAuthority: i % 5 === 0 ? key(249) : null,
      nativeReserveRaw: null,
      extensions: i % 2 === 0 ? [] : ['ImmutableOwner'],
      byteLength: i % 2 === 0 ? 165 : 170,
      encodedDataSha256: 'a'.repeat(64),
    }),
  );
  accounts.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  const inspection: MarketplaceTokenInspection = {
    format: 'bundle-sale-token-inspection-v1',
    chain: 'Solana',
    selection,
    sellerEvidenceSha256: await tokenInspectionSourceHash(inventory.wallets[0]),
    startedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    source: 'rpc.example',
    commitment: 'confirmed',
    floorSlot: 100,
    finalSlot: 103,
    programs: [
      {
        program: MARKETPLACE_TOKEN_PROGRAMS[0],
        slot: 101,
        count: accounts.filter(
          (a) => a.program === MARKETPLACE_TOKEN_PROGRAMS[0],
        ).length,
      },
      {
        program: MARKETPLACE_TOKEN_PROGRAMS[1],
        slot: 102,
        count: accounts.filter(
          (a) => a.program === MARKETPLACE_TOKEN_PROGRAMS[1],
        ).length,
      },
    ],
    accounts,
    ...tokenInspectionCounts(accounts, source.a),
    coverage: MARKETPLACE_TOKEN_COVERAGE,
    currentControlVerified: false,
    allAssetsAndAuthoritiesChecked: false,
    extensionSemanticsChecked: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
  return { source, inventory, selection, inspection };
}
