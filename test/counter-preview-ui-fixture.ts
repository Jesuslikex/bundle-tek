import { counterBuyFixture } from './counter-buy-fixture';
import { routeWallet } from './jupiter-route-fixture';
import { initialCounterLedger } from '../lib/counter-trade';
import type { CounterPreviewView } from '../lib/counter-preview-view';
export function counterPreviewUiFixture() {
  const { plan, identity } = counterBuyFixture();
  plan.rules.ignoredWallets = [routeWallet];
  plan.ledger.rulesKey = initialCounterLedger(
    plan.rules,
    plan.ledger.scope,
  ).rulesKey;
  const request = {
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    wallet: routeWallet,
    walletRevision: 1,
    maximumSolInputRaw: '1005',
    maximumFeeAndRentRaw: '5000',
  };
  const preview: CounterPreviewView = {
    ...request,
    format: 'owned-counter-buy-preview-v1',
    mint: plan.ledger.scope.mint,
    tokenDecimals: plan.ledger.scope.decimals,
    packetSha256: 'a'.repeat(64),
    outputTargetRaw: plan.ledger.decisions[0].proposalTokenRaw!,
    requiredSolInputRaw: '1000',
    maximumQuoteInputRaw: '1005',
    actualSimulatedInputRaw: '999',
    networkFeeLamports: '5000',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    ownershipContextRechecked: true,
    grossSettlementReviewed: true,
    sourceRevalidated: false,
    programCodeAttested: false,
    reservationCreated: false,
    approvalAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
    limitations: 'Synthetic read-only UI fixture.',
  };
  const workspace = {
    wallets: [
      {
        chain: 'Solana',
        address: routeWallet,
        revision: 1,
        label: 'Synthetic preview wallet',
        role: 'Recipient',
        archived: false,
      },
      {
        chain: 'Solana',
        address: 'So11111111111111111111111111111111111111112',
        revision: 1,
        label: 'Watch-only wallet',
        role: 'Recipient',
        archived: false,
      },
    ],
    proofs: [
      {
        chain: 'Solana',
        address: routeWallet,
        verifiedAt: new Date().toISOString(),
      },
    ],
  };
  return { plan, identity, request, preview, workspace };
}
