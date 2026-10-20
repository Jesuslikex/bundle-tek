import bs58 from 'bs58';
import { buildWarmupPlan } from '../lib/wallet-warmup';
import { warmupCycleProgress } from '../lib/warmup-cycle-progress';
import { warmupLotPerformance } from '../lib/warmup-lot-performance';
import { reviewWalletWarmupSession } from '../lib/wallet-warmup-session-review';
import type { SavedWarmup } from '../lib/wallet-warmup-storage';
/** Synthetic public plan only. There are no wallet secrets, packets or live provider calls. */
export function warmupSessionReviewFixture(now = Date.now(), cycles = 2) {
  const document = {
    name: 'Synthetic session review',
    chain: 'Solana',
    addresses: [bs58.encode(new Uint8Array(32).fill(1))],
    walletRevisions: [
      { address: bs58.encode(new Uint8Array(32).fill(1)), revision: 1 },
    ],
    tokens: [bs58.encode(new Uint8Array(32).fill(2))],
    amount: '0.001',
    feeReserve: '0.01',
    cycles,
    intervalSeconds: 10,
    startAt: new Date(now).toISOString(),
  };
  const plan: SavedWarmup = {
    id: 'synthetic-session',
    revision: 1,
    archived: false,
    updatedAt: new Date(now).toISOString(),
    document: {
      ...document,
      totalBudget: buildWarmupPlan(document, now).totalBudget,
    },
  };
  const response = (clock = Date.now()) => ({
    review: reviewWalletWarmupSession(
      plan,
      warmupCycleProgress(plan, [], [], [], false),
      warmupLotPerformance([], [], []),
      clock,
    ),
    reviewExpiresAt: new Date(clock + 60000).toISOString(),
  });
  return { plan, response };
}
