import { buildWarmupPlan } from '../lib/wallet-warmup';
import type { SavedWarmup } from '../lib/wallet-warmup-storage';

/** Public addresses and historical configuration only; no provider or wallet access. */
export function warmupSavedDisplayFixture(): SavedWarmup {
  const document = {
    name: 'Historical warmup fixture',
    chain: 'Solana',
    addresses: ['11111111111111111111111111111111'],
    tokens: ['So11111111111111111111111111111111111111112'],
    walletRevisions: [
      { address: '11111111111111111111111111111111', revision: 3 },
    ],
    amount: '0.001',
    feeReserve: '0.002',
    cycles: 2,
    intervalMinutes: 15,
    startAt: '2026-01-01T12:00:00.000Z',
    totalBudget: '',
  };
  document.totalBudget = buildWarmupPlan(
    document,
    Date.parse(document.startAt),
  ).totalBudget;
  return {
    id: '6ef53658-0746-4567-9e63-af3d4428d144',
    revision: 4,
    archived: true,
    updatedAt: '2026-01-02T12:00:00.000Z',
    document,
  };
}
