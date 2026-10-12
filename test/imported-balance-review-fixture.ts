import type { ImportedSwapBalance } from '../lib/imported-swap-balance';
import type { ImportedBalanceContext } from '../lib/imported-balance-review';
import {
  acquisitionWallet,
  acquisitionMint,
} from './imported-sell-acquisition-fixture';
export function importedBalanceReviewFixture(now = Date.now()) {
  const context: ImportedBalanceContext = {
    wallet: acquisitionWallet,
    mint: acquisitionMint,
    tokenDecimals: 6,
    side: 'Sell',
    requestedRaw: '3000',
  };
  const report: ImportedSwapBalance = {
    executionAllowed: false,
    wallet: context.wallet,
    mint: context.mint,
    side: 'Sell',
    decimals: 6,
    requestedRaw: '3000',
    nativeRaw: '1000000000',
    tokenRaw: '4003',
    frozenRaw: '1000',
    unfrozenRaw: '3003',
    shortfallRaw: '0',
    amountCovered: true,
    preparationSupported: true,
    token2022: false,
    mintExtensions: null,
    blockedExtensions: [],
    mintSlot: null,
    minSlot: 100,
    maxSlot: 101,
    nativeSlot: 102,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    source: 'fixture.test',
    limitations: 'Synthetic observation only. No execution clearance.',
  };
  return { report, context };
}
