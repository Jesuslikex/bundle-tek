import type { CounterBuyPreparation } from './counter-buy-preparation';
import type { simulateCounterBuyPreparation } from './counter-buy-simulation';
import { reviewExactOutputNativeSettlement } from './warmup-native-settlement';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { reviewSwapInstructions } from './swap-instruction-review';
export type CounterBuySimulation = Awaited<
  ReturnType<typeof simulateCounterBuyPreparation>
>;

/** Join fresh collected evidence to the explicit ExactOut gross debit policy. */
export async function reviewCounterBuySettlement(
  value: CounterBuyPreparation,
  evidence: CounterBuySimulation,
  reviewedFeeAndRentLimitRaw: string,
) {
  const order = structuredClone(value),
    simulation = structuredClone(evidence),
    observed = Date.parse(simulation.observedAt),
    expires = Date.parse(order.expiresAt);
  if (
    order.executionAllowed !== false ||
    order.format !== 'counter-buy-preparation-v1' ||
    order.instructionsVerified !== false ||
    simulation.format !== 'counter-buy-simulation-v1' ||
    simulation.executionAllowed !== false ||
    simulation.instructionsVerified !== false ||
    simulation.network !== 'Solana mainnet' ||
    simulation.originalBlockhashRetained !== true ||
    simulation.sha256 !== order.preparation.sha256 ||
    simulation.balanceAssessment.sha256 !== simulation.sha256 ||
    simulation.balanceAssessment.wallet !== order.preparation.wallet ||
    simulation.balanceAssessment.status !== 'Matched balances' ||
    Object.values(simulation.balanceAssessment.checks).some(
      (value) => value !== true,
    ) ||
    simulation.balanceAssessment.reviewedFeeAndRentLimitRaw !==
      reviewedFeeAndRentLimitRaw ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    order.quote.expiresAt !== order.expiresAt ||
    order.review.expiresAt !== order.expiresAt ||
    observed > Date.now() ||
    Date.now() - observed > 30000 ||
    simulation.expiresAt !== order.expiresAt ||
    Date.parse(order.expiresAt) <= Date.now()
  )
    throw new Error(
      'Counter settlement simulation changed, failed or expired.',
    );
  const packet = await reviewUnsignedSwapEnvelope(
    order.preparation.transaction,
    order.preparation.wallet,
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(packet.transaction),
    ).messageBytes,
  );
  const actual = reviewSwapInstructions(
    message,
    order.preparation.lookupAccounts ?? undefined,
  );
  const keys = [
    ...message.staticAccounts.map(String),
    ...(order.preparation.lookupAccounts?.writable ?? []),
    ...(order.preparation.lookupAccounts?.readonly ?? []),
  ];
  if (
    packet.sha256 !== simulation.sha256 ||
    packet.accountCount !== order.preparation.accountCount ||
    JSON.stringify(keys) !==
      JSON.stringify(simulation.settlementEvidence?.keys) ||
    JSON.stringify(actual) !== JSON.stringify(simulation.instructionReview)
  )
    throw new Error(
      'Counter settlement instructions do not belong to the reviewed packet.',
    );
  const proof = await reviewExactOutputNativeSettlement(
    {
      swapMode: 'ExactOut',
      wallet: order.preparation.wallet,
      inputMint: order.quote.inputMint,
      outputMint: order.quote.outputMint,
      quotedInputRaw: order.quote.requiredSolInputRaw,
      outputTargetRaw: order.quote.outputTargetRaw,
      maximumInputRaw: order.quote.maximumSolInputRaw,
      reviewedInputBudgetRaw: order.quote.reviewedSolBudgetRaw,
      slippageBps: order.quote.slippageBps,
      accountCount: order.preparation.accountCount,
      lookupTableCount: order.preparation.lookupTableCount,
    },
    { ...simulation, routeAssessment: { decoded: null } },
    reviewedFeeAndRentLimitRaw,
  );
  if (Date.parse(order.expiresAt) <= Date.now())
    throw new Error('Counter settlement expired during instruction review.');
  return {
    ...proof,
    sha256: simulation.sha256,
    wallet: order.preparation.wallet,
    expiresAt: order.expiresAt,
    projectId: order.quote.projectId,
    projectRevision: order.quote.projectRevision,
    planId: order.quote.planId,
    planRevision: order.quote.planRevision,
    decisionIdentity: order.quote.decisionIdentity,
    reviewedFeeAndRentLimitRaw,
    limitations:
      'Explicit ExactOut setup, wrapping, cleanup and gross debit comparisons with collected simulation evidence. Current project/source admission, durable proposal reservation and persisted review budgets must still be bound to explicit user approval. This proof does not authorize signing or submission.',
  };
}
