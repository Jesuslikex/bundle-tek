import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { solanaTokenBalanceChanges } from './solana-token-balance-changes';
import { WRAPPED_SOL } from './warmup-swap-quote';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid Counter simulation integer.');
  return BigInt(value);
};
export type CounterSimulationBalanceEvidence = {
  sha256: string;
  observedAt: string;
  simulationSlot: string;
  feeSlot: string;
  networkFeeLamports: string;
  err: unknown;
  unitsConsumed: string;
  replacementBlockhash?: unknown;
  loadedAddresses?: unknown;
  preBalances?: unknown;
  postBalances?: unknown;
  preTokenBalances?: unknown;
  postTokenBalances?: unknown;
};
/** Assess complete simulation balances, with an independent fee/rent allowance. */
export async function assessCounterBuySimulationBalances(
  order: CounterBuyPreparation,
  evidence: CounterSimulationBalanceEvidence,
  reviewedFeeAndRentLimitRaw: string,
  now = Date.now(),
) {
  order = structuredClone(order);
  evidence = structuredClone(evidence);
  const packet = order.preparation;
  const envelope = await reviewUnsignedSwapEnvelope(
    packet.transaction,
    packet.wallet,
  );
  const observed = Date.parse(evidence.observedAt),
    expires = Date.parse(order.expiresAt),
    preparedAt = Date.parse(order.observedAt);
  const feeLimit = uint(reviewedFeeAndRentLimitRaw),
    fee = uint(evidence.networkFeeLamports),
    maximumInput = uint(order.quote.maximumSolInputRaw),
    reviewedInput = uint(order.quote.reviewedSolBudgetRaw),
    target = uint(order.quote.outputTargetRaw);
  const simulationSlot = Number(uint(evidence.simulationSlot)),
    feeSlot = Number(uint(evidence.feeSlot));
  if (
    order.format !== 'counter-buy-preparation-v1' ||
    order.executionAllowed !== false ||
    order.instructionsVerified !== false ||
    order.review.executionAllowed !== false ||
    order.review.assessment.status !== 'Matched fields' ||
    order.review.wallet !== packet.wallet ||
    packet.sha256 !== envelope.sha256 ||
    evidence.sha256 !== envelope.sha256 ||
    packet.accountCount !== envelope.accountCount ||
    packet.executionAllowed !== false ||
    packet.instructionsVerified !== false ||
    order.quote.executionAllowed !== false ||
    order.quote.swapMode !== 'ExactOut' ||
    order.quote.inputMint !== WRAPPED_SOL ||
    order.quote.outputMint === WRAPPED_SOL ||
    target === 0n ||
    maximumInput === 0n ||
    maximumInput > reviewedInput ||
    order.expiresAt !== order.quote.expiresAt ||
    order.expiresAt !== order.review.expiresAt ||
    order.quote.planId !== order.review.planId ||
    order.quote.planRevision !== order.review.planRevision ||
    order.quote.projectId !== order.review.projectId ||
    order.quote.projectRevision !== order.review.projectRevision ||
    order.quote.decisionIdentity !== order.review.decisionIdentity ||
    !Number.isInteger(order.tokenDecimals) ||
    order.tokenDecimals < 0 ||
    order.tokenDecimals > 255 ||
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(preparedAt) ||
    expires <= now ||
    observed > now ||
    now - observed > 30000 ||
    observed < preparedAt ||
    !Number.isSafeInteger(order.quote.contextSlot) ||
    order.quote.contextSlot < 0 ||
    !Number.isSafeInteger(simulationSlot) ||
    !Number.isSafeInteger(feeSlot) ||
    simulationSlot < feeSlot ||
    feeSlot < order.quote.contextSlot ||
    simulationSlot - Math.min(feeSlot, order.quote.contextSlot) > 32 ||
    evidence.replacementBlockhash != null
  )
    throw new Error('Counter simulation packet, timing or context differs.');
  if (evidence.err === undefined)
    throw new Error('Missing Counter simulation result.');
  const units = uint(evidence.unitsConsumed);
  if (units > 1400000n || (evidence.err === null && units === 0n))
    throw new Error('Invalid Counter simulation compute usage.');
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(packet.transaction),
    ).messageBytes,
  );
  if (message.version !== 0)
    throw new Error('Unsupported Counter simulation version.');
  const loaded = evidence.loadedAddresses as
    | { writable?: unknown; readonly?: unknown }
    | undefined;
  const lookup = packet.lookupAccounts;
  const keys = message.staticAccounts.map(String);
  if (envelope.lookupTableCount) {
    if (
      !lookup ||
      simulationSlot < lookup.observedSlot ||
      simulationSlot - lookup.observedSlot > 32 ||
      JSON.stringify(loaded?.writable) !== JSON.stringify(lookup.writable) ||
      JSON.stringify(loaded?.readonly) !== JSON.stringify(lookup.readonly)
    )
      throw new Error('Counter simulation lookup addresses differ.');
    keys.push(...lookup.writable, ...lookup.readonly);
  } else if (
    (loaded?.writable != null && JSON.stringify(loaded.writable) !== '[]') ||
    (loaded?.readonly != null && JSON.stringify(loaded.readonly) !== '[]')
  )
    throw new Error('Unexpected Counter simulation lookup addresses.');
  if (keys.length !== packet.accountCount || new Set(keys).size !== keys.length)
    throw new Error('Counter simulation account keys differ.');
  const issues: string[] = [];
  let checks: Record<string, boolean | null> = {
    simulationSucceeded: evidence.err === null,
  };
  let nativeWalletChangeRaw: string | null = null,
    netWalletDebitRaw: string | null = null;
  let tokens: ReturnType<typeof solanaTokenBalanceChanges> | null = null;
  if (evidence.err === null) {
    if (
      !Array.isArray(evidence.preBalances) ||
      !Array.isArray(evidence.postBalances) ||
      evidence.preBalances.length !== keys.length ||
      evidence.postBalances.length !== keys.length
    )
      throw new Error('Missing Counter simulated wallet balances.');
    const before = evidence.preBalances.map(uint),
      after = evidence.postBalances.map(uint);
    const change = after[0] - before[0],
      debit = change < 0n ? -change : 0n;
    nativeWalletChangeRaw = change.toString();
    netWalletDebitRaw = debit.toString();
    tokens = solanaTokenBalanceChanges(
      keys,
      packet.wallet,
      evidence.preTokenBalances,
      evidence.postTokenBalances,
    );
    const output = tokens.changes.filter(
      (c) => c.mint === order.quote.outputMint,
    );
    checks = {
      ...checks,
      networkFeeWithinAllowance: fee > 0n && fee <= feeLimit,
      netWalletDebitWithinLimit: debit <= maximumInput + feeLimit,
      tokenMetadataComplete: tokens.complete ? true : null,
      exactOutput: tokens.complete
        ? output.length === 1 && BigInt(output[0].changeRaw) === target
        : null,
      outputPrecision: tokens.complete
        ? output.length === 1 && output[0].decimals === order.tokenDecimals
        : null,
      standardTokenPrograms: tokens.complete
        ? tokens.changes.every((c) => c.program === TOKEN)
        : null,
      unrelatedTokenDebitsAbsent: tokens.complete
        ? tokens.changes.every(
            (c) =>
              c.mint === order.quote.outputMint ||
              c.mint === WRAPPED_SOL ||
              BigInt(c.changeRaw) >= 0n,
          )
        : null,
      wrappedSolUnchanged: tokens.complete
        ? tokens.changes
            .filter((c) => c.mint === WRAPPED_SOL)
            .every((c) => c.changeRaw === '0')
        : null,
    };
  }
  for (const [name, matches] of Object.entries(checks))
    if (matches !== true)
      issues.push(
        `Counter simulation ${name} ${matches === null ? 'is unavailable' : 'does not match'}.`,
      );
  const status = Object.values(checks).some((c) => c === false)
    ? 'Mismatch'
    : Object.values(checks).some((c) => c === null)
      ? 'Unavailable'
      : 'Matched balances';
  return {
    format: 'counter-buy-simulation-balances-v1' as const,
    executionAllowed: false as const,
    instructionsVerified: false as const,
    status,
    checks,
    issues,
    sha256: envelope.sha256,
    wallet: packet.wallet,
    observedAt: evidence.observedAt,
    simulationSlot,
    feeSlot,
    reviewedFeeAndRentLimitRaw: feeLimit.toString(),
    maximumTotalNetDebitRaw: (maximumInput + feeLimit).toString(),
    nativeWalletChangeRaw,
    netWalletDebitRaw,
    tokenChanges: tokens?.changes ?? [],
    limitations:
      'Simulation balance comparisons only. Net wallet debit can hide gross spending offset by refunds. Account ownership/extension and wrapping instruction checks, all gross debits and fee sources, fresh database context, original blockhash, immutable lookup rechecks and durable proposal reservation remain required. Matching balances do not authorize signing.',
  };
}
