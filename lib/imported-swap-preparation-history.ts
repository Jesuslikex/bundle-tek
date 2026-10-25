import {
  tradeSessionWriteGuard,
  type TradeSessionGuard,
} from './imported-trade-session-server';
import type { TradeSessionCapture } from './imported-trade-session';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import type { UnsignedSwapSummarySimulation } from './unsigned-swap-summary-simulation';
import type { ImportedSwapBalance } from './imported-swap-balance';
import type { ImportedAcquisitionSelection } from './imported-acquisition';
import {
  conditionalPreparationWriteGuard,
  type ConditionalPreparation,
  type ConditionalPreparationGuard,
} from './conditional-preparation-server';
import { requireConditionalSwapContext } from './conditional-signing';
import {
  autoSellPreparationWriteGuard,
  type AutoSellRunPreparationGuard,
} from './auto-sell-run-storage';
import {
  importedAcquisitionWriteGuard,
  type ImportedAcquisitionGuard,
} from './imported-acquisition-server';
import { prepareAutoSellRunPacketWrite } from './auto-sell-run-packet-storage';
import { readAutoSellRunPacketSummary } from './auto-sell-run-packet';
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid preparation history amount.');
  return value;
};
export function swapPreparationSummary(
  order: SolanaSwapPreparation,
  simulation: ImportedSwapSimulation,
  balance: ImportedSwapBalance,
) {
  const wrapped = 'So11111111111111111111111111111111111111112';
  if (
    balance.executionAllowed !== false ||
    balance.wallet !== simulation.wallet ||
    balance.side !== order.side ||
    balance.requestedRaw !== order.inAmount ||
    !balance.amountCovered ||
    !balance.preparationSupported ||
    order.inputMint !== (order.side === 'Buy' ? wrapped : balance.mint) ||
    order.outputMint !== (order.side === 'Sell' ? wrapped : balance.mint) ||
    !Number.isFinite(Date.parse(balance.observedAt))
  )
    throw new Error('Preparation history context mismatch.');
  return {
    ...unsignedPreparationSummary(order, simulation),
    balance: {
      source: balance.source,
      observedAt: balance.observedAt,
      requestedRaw: balance.requestedRaw,
      amountCovered: balance.amountCovered,
      nativeSlot: balance.nativeSlot,
    },
  };
}
export function unsignedPreparationSummary(
  order: SolanaSwapPreparation,
  simulation: UnsignedSwapSummarySimulation,
) {
  if (
    order.executionAllowed !== false ||
    order.preparation.executionAllowed !== false ||
    order.preparation.instructionsVerified !== false ||
    simulation.executionAllowed !== false ||
    simulation.instructionsVerified !== false ||
    order.preparation.sha256 !== simulation.sha256 ||
    !/^[a-f0-9]{64}$/.test(simulation.sha256) ||
    order.preparation.wallet !== simulation.wallet ||
    typeof simulation.succeeded !== 'boolean'
  )
    throw new Error('Preparation history context mismatch.');
  for (const date of [order.observedAt, order.expiresAt, simulation.observedAt])
    if (!Number.isFinite(Date.parse(date)))
      throw new Error('Invalid preparation observation time.');
  if (
    simulation.nativeChangeRaw !== null &&
    (!/^-?(0|[1-9]\d{0,19})$/.test(simulation.nativeChangeRaw) ||
      BigInt(simulation.nativeChangeRaw).toString() !==
        simulation.nativeChangeRaw ||
      BigInt(simulation.nativeChangeRaw) < -((1n << 64n) - 1n) ||
      BigInt(simulation.nativeChangeRaw) > (1n << 64n) - 1n)
  )
    throw new Error('Invalid simulated native change.');
  return {
    executionAllowed: false as const,
    instructionsVerified: false as const,
    chain: 'Solana' as const,
    side: order.side,
    wallet: simulation.wallet,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    inAmountRaw: uint(order.inAmount),
    quotedOutRaw: uint(order.outAmount),
    minimumOutRaw: uint(order.minimumOutAmount),
    slippageBps: order.slippageBps,
    router: order.router,
    ...(order.platformFee ? { platformFee: order.platformFee } : {}),
    quoteSource: order.source,
    quotedAt: order.observedAt,
    expiresAt: order.expiresAt,
    transaction: {
      sha256: order.preparation.sha256,
      bytes: order.preparation.transactionBytes,
      instructionCount: order.preparation.instructionCount,
      lookupTableCount: order.preparation.lookupTableCount,
      lastValidBlockHeight: uint(order.preparation.lastValidBlockHeight),
      estimatedFeesLamports: uint(order.preparation.estimatedFeesLamports),
    },
    simulation: {
      succeeded: simulation.succeeded,
      source: simulation.source,
      observedAt: simulation.observedAt,
      feeSlot: simulation.feeSlot,
      simulationSlot: simulation.simulationSlot,
      networkFeeLamports: uint(simulation.networkFeeLamports),
      unitsConsumed:
        simulation.unitsConsumed === null
          ? null
          : uint(simulation.unitsConsumed),
      nativeChangeRaw: simulation.nativeChangeRaw,
      tokensComplete: simulation.tokensComplete,
      inputAmountMatches: simulation.inputAmountMatches,
      minimumOutputCovered: simulation.minimumOutputCovered,
      routeStatus: simulation.routeAssessment?.status ?? 'Unavailable',
      bindingStatus: simulation.accountBindings?.status ?? 'Unavailable',
      authorityActionCount: (simulation.instructionReview
        ?.authorityActionCount ?? null) as number | null,
      unrecognizedInstructionCount: (simulation.instructionReview
        ?.unrecognizedInstructionCount ?? null) as number | null,
      unresolvedAccountCount: (simulation.instructionReview
        ?.unresolvedAccountCount ?? null) as number | null,
    },
    limitations:
      'Saved preparation summary only. No transaction was signed or submitted. Simulated changes are not final receipts or profit. Raw transaction bytes are not retained. Signing requires a fresh preparation and complete instruction review.',
  };
}
export type UnsignedSwapPreparationSummary = ReturnType<
  typeof unsignedPreparationSummary
>;
export type SwapPreparationSummary = ReturnType<
  typeof swapPreparationSummary
> & {
  acquisition?: ImportedAcquisitionSelection;
  conditional?: ConditionalPreparation;
  session?: TradeSessionCapture;
};
export type SavedSwapPreparation = {
  id: string;
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  createdAt: string;
  document: SwapPreparationSummary;
};
export async function saveSwapPreparation(
  db: D1Database,
  owner: string,
  context: {
    projectId: string;
    projectRevision: number;
    wallet: string;
    walletRevision: number;
  },
  document: SwapPreparationSummary,
  acquisitionGuard?: ImportedAcquisitionGuard,
  conditionalGuard?: ConditionalPreparationGuard,
  sessionGuard?: TradeSessionGuard,
  autoSellRunGuard?: AutoSellRunPreparationGuard,
  autoSellRunTransaction?: string,
) {
  // Journal recovery must return exactly the same detached summary that is
  // hashed and stored, even if an internal caller mutates its original object.
  if (autoSellRunGuard) document = readAutoSellRunPacketSummary(document);
  if (document.conditional)
    requireConditionalSwapContext(document.conditional, {
      side: document.side,
      inputMint: document.inputMint,
      outputMint: document.outputMint,
      inputRaw: document.inAmountRaw,
    });
  if (!autoSellRunGuard && autoSellRunTransaction !== undefined)
    throw new Error(
      'Only an original journal guard can retain an Auto Sell packet.',
    );
  const text = JSON.stringify(document);
  if (
    text.length > 8192 ||
    document.wallet !== context.wallet ||
    document.executionAllowed !== false ||
    JSON.stringify(document.session) !==
      JSON.stringify(sessionGuard?.selection) ||
    (document.session !== undefined &&
      document.session.unitsRaw !== document.inAmountRaw) ||
    JSON.stringify(document.acquisition) !==
      JSON.stringify(acquisitionGuard?.selection) ||
    JSON.stringify(document.conditional) !==
      JSON.stringify(conditionalGuard?.selection) ||
    (document.conditional !== undefined &&
      document.inAmountRaw !== document.conditional.unitsRaw)
  )
    throw new Error('Invalid saved preparation.');
  const journalGuard = autoSellRunGuard
    ? autoSellPreparationWriteGuard(owner, autoSellRunGuard, context, document)
    : undefined;
  const savedContext = autoSellRunGuard
    ? {
        projectId: autoSellRunGuard.projectId,
        projectRevision: autoSellRunGuard.projectRevision,
        walletRevision: autoSellRunGuard.walletRevision,
      }
    : context;
  const id = journalGuard?.preparationId ?? crypto.randomUUID(),
    createdAt = new Date().toISOString();
  const sourceGuard = importedAcquisitionWriteGuard(owner, acquisitionGuard);
  const conditionGuard = conditionalPreparationWriteGuard(
    owner,
    context.projectId,
    conditionalGuard,
  );
  const sessionWrite = tradeSessionWriteGuard(owner, sessionGuard);
  const preparationStatement = db
    .prepare(`INSERT INTO imported_swap_preparations
    (id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE
    EXISTS (SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND chain='Solana' AND revision=? AND address=? AND archived=0)
    AND EXISTS (SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0)
    AND (SELECT COUNT(*) FROM imported_swap_preparations WHERE owner_id=? AND project_id=?)<200
    AND ?>?${sourceGuard.sql}${conditionGuard.sql}${sessionWrite.sql}${journalGuard?.sql ?? ''}`)
    .bind(
      id,
      owner,
      context.projectId,
      context.projectRevision,
      context.wallet,
      context.walletRevision,
      text,
      createdAt,
      owner,
      context.projectId,
      context.projectRevision,
      document.side === 'Buy' ? document.outputMint : document.inputMint,
      owner,
      context.wallet,
      context.walletRevision,
      owner,
      context.projectId,
      Date.parse(document.expiresAt),
      Date.now(),
      ...sourceGuard.bindings,
      ...conditionGuard.bindings,
      ...sessionWrite.bindings,
      ...(journalGuard?.bindings ?? []),
    );
  const write = autoSellRunGuard
    ? await (
        await prepareAutoSellRunPacketWrite(
          db,
          preparationStatement,
          owner,
          id,
          text,
          autoSellRunTransaction,
          document,
          autoSellRunGuard,
        )
      )()
    : await preparationStatement.run();
  if (!write.meta.changes) return null;
  return {
    id,
    projectId: savedContext.projectId,
    projectRevision: savedContext.projectRevision,
    walletRevision: savedContext.walletRevision,
    document,
    createdAt,
  } satisfies SavedSwapPreparation;
}
