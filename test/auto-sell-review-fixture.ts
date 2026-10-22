import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from './auto-sell-outcome-fixture';
import type { AutoSellReviewReference } from '../lib/auto-sell-review-recovery';
export const autoSellReviewReference: AutoSellReviewReference = {
  projectId: ref.projectId,
  projectRevision: ref.projectRevision,
  walletRevision: ref.walletRevision,
  preparationId: ref.preparationId,
  wallet: ref.wallet,
  mint: ref.mint,
  inputRaw: ref.inputRaw,
  preparationSha256: ref.preparationSha256,
};
export function autoSellUnsignedReviewPage() {
  const page = autoSellOutcomePage();
  page.intents[0].state = 'awaiting_signature';
  page.intents[0].signature = null;
  return page;
}
