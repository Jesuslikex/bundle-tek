import type { ImportedSwapSimulation } from './imported-swap-simulation';

/**
 * Data consumed by the unsigned history summary, not a signing simulation.
 * Runtime collectors can supply these observations without inventing the
 * legacy collector's settlement, lookup, or signing-review metadata.
 */
export type UnsignedSwapSummarySimulation = Pick<
  ImportedSwapSimulation,
  | 'executionAllowed'
  | 'instructionsVerified'
  | 'sha256'
  | 'wallet'
  | 'succeeded'
  | 'source'
  | 'observedAt'
  | 'feeSlot'
  | 'simulationSlot'
  | 'networkFeeLamports'
  | 'unitsConsumed'
  | 'nativeChangeRaw'
  | 'tokensComplete'
  | 'inputAmountMatches'
  | 'minimumOutputCovered'
> & {
  routeAssessment?: Pick<ImportedSwapSimulation['routeAssessment'], 'status'>;
  accountBindings?: Pick<ImportedSwapSimulation['accountBindings'], 'status'>;
  instructionReview?: Pick<
    ImportedSwapSimulation['instructionReview'],
    | 'authorityActionCount'
    | 'unrecognizedInstructionCount'
    | 'unresolvedAccountCount'
  >;
};

/** Additional deltas consumed by the warmup provider's existing budget checks. */
export type WarmupSessionSimulationObservation = UnsignedSwapSummarySimulation &
  Pick<ImportedSwapSimulation, 'tokenChanges'>;
