import { pumpAccountBytes, pumpRpcAccount } from './pump-launch-simulation';
import {
  pairReviewDiagnostic,
  pairDiagnosticComparisons,
  type PairDiagnosticDetails,
} from './pair-review-diagnostic';
const UNSUPPORTED_WRITABLE_OWNERS = new Set([
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
]);
/** Trading runtime profile only; apply to both observed and simulated writable state. */
export function assertPairRuntimeWritableAccount(
  raw: unknown,
  observation?: {
    address: string;
    phase: 'before-inventory' | 'after-inventory' | 'simulation-post-state';
    slot: number;
    before?: unknown;
    packetScope?: () => PairDiagnosticDetails;
    rpcAccountPosition?: number;
    rpcAccountCount?: number;
  },
) {
  const a = pumpRpcAccount(raw);
  if (
    a &&
    (a.executable ||
      UNSUPPORTED_WRITABLE_OWNERS.has(a.owner) ||
      (a.owner === '11111111111111111111111111111111' &&
        pumpAccountBytes(a).length))
  ) {
    // Diagnostic metadata only. Keep the rejection condition above unchanged.
    const dataBytes = pumpAccountBytes(a).length;
    let before: ReturnType<typeof pumpRpcAccount> | undefined;
    try {
      if (observation?.before !== undefined)
        before = pumpRpcAccount(observation.before);
    } catch {
      /* Unavailable historical evidence is never reconstructed. */
    }
    let packetScope: PairDiagnosticDetails = {};
    try {
      packetScope = observation?.packetScope?.() ?? {};
    } catch {
      packetScope = { packetScopeEvidence: 'unavailable' };
    }
    throw pairReviewDiagnostic(
      Error(
        'Pair runtime exposes unsupported writable custody or executable state.',
      ),
      'writable-runtime-state',
      {
        ...packetScope,
        ...(observation
          ? {
              accountAddress: observation.address,
              observationPhase: observation.phase,
              contextSlot: observation.slot,
              ...(observation.rpcAccountPosition === undefined
                ? {}
                : { rpcAccountPosition: observation.rpcAccountPosition }),
              ...(observation.rpcAccountCount === undefined
                ? {}
                : { rpcAccountCount: observation.rpcAccountCount }),
            }
          : {}),
        accountOwner: a.owner,
        accountDataBytes: dataBytes,
        comparisons: pairDiagnosticComparisons(
          {
            executable: false,
            blockedOwner: false,
            systemDataBytes: 0,
            priorOwner:
              before === undefined
                ? '<unavailable>'
                : (before?.owner ?? '<absent>'),
            priorExecutable:
              before === undefined
                ? '<unavailable>'
                : (before?.executable ?? '<absent>'),
            priorLamports:
              before === undefined
                ? '<unavailable>'
                : (before?.lamports ?? '<absent>'),
          },
          {
            executable: a.executable,
            blockedOwner: UNSUPPORTED_WRITABLE_OWNERS.has(a.owner),
            systemDataBytes:
              a.owner === '11111111111111111111111111111111' ? dataBytes : 0,
            priorOwner: a.owner,
            priorExecutable: a.executable,
            priorLamports: a.lamports,
          },
        ),
      },
    );
  }
}
