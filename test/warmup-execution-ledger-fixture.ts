import bs58 from 'bs58';
import { WarmupExecutionLedger } from '../lib/wallet-warmup-execution-ledger';
import {
  parseWarmupExecutionManifest,
  WARMUP_EXECUTION_POLICY,
} from '../lib/wallet-warmup-execution-manifest';
import { SWAP_TOKEN } from '../lib/swap-token-program-evidence';

export const executionId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const executionHash = (n: number) => n.toString(16).padStart(64, '0');
export const executionSignature = (n = 1) =>
  bs58.encode(new Uint8Array(64).fill(n));
export const executionNow = Date.UTC(2026, 9, 22);
export function executionManifest() {
  const wallet = bs58.encode(new Uint8Array(32).fill(5));
  const mint = bs58.encode(new Uint8Array(32).fill(6));
  const common = {
    wallet,
    mint,
    tokenProgram: SWAP_TOKEN,
    decimals: 6,
    scheduledAt: new Date(executionNow).toISOString(),
    maximumFeeRentLamports: '10',
  };
  return parseWarmupExecutionManifest({
    format: 'wallet-warmup-execution-manifest-v1',
    id: executionId(1),
    ownerId: 'synthetic-owner',
    consentId: executionId(2),
    policy: WARMUP_EXECUTION_POLICY,
    planId: 'synthetic-plan',
    planRevision: 1,
    sourceSha256: executionHash(1),
    consentSha256: executionHash(2),
    createdAt: new Date(executionNow).toISOString(),
    expiresAt: new Date(executionNow + 180000).toISOString(),
    wallets: [
      {
        wallet,
        revision: 1,
        maximumBuyLamports: '100',
        maximumFeeRentLamports: '20',
      },
    ],
    savedLots: [],
    actions: [
      { ...common, id: 'buy', side: 'Buy', inputLamports: '100' },
      {
        ...common,
        id: 'sell',
        side: 'Sell',
        source: { kind: 'action-buy', actionId: 'buy' },
      },
    ],
  });
}
/** Only synthetic opaque evidence references. No signatures are produced,
 * no receipt is verified and no provider, signer, storage or API is involved. */
export async function executionLedgerFixture(manifest = executionManifest()) {
  const ledger = await WarmupExecutionLedger.create(manifest);
  let now = executionNow;
  const step = (operation: string, fields: Record<string, unknown> = {}) =>
    ledger.apply({
      expectedRootSha256: ledger.snapshot().rootSha256,
      expectedVersion: ledger.snapshot().version,
      now,
      operation,
      ...fields,
    });
  const qualify = () => step('qualify', { evidenceSha256: executionHash(3) });
  const packetHash = () =>
    executionHash(4 + ledger.snapshot().completedActions * 1000);
  const signedPacketHash = () =>
    executionHash(6 + ledger.snapshot().completedActions * 1000);
  const prepare = () =>
    step('prepare', {
      packetSha256: packetHash(),
      minimumOutputRaw: '1',
      qualificationEvidenceSha256:
        ledger.snapshot().pending!.qualification!.evidenceSha256,
    });
  const authorize = (n = 1) =>
    step('authorize', {
      id: executionId(100 + n),
      packetSha256: packetHash(),
      recheckSha256: executionHash(5),
    });
  const dispatch = (n = 1) =>
    step('dispatch-intent', {
      id: executionId(200 + n),
      authorizationId: ledger.snapshot().pending!.authorization!.id,
      packetSha256: packetHash(),
      signedPacketSha256: signedPacketHash(),
      signature: executionSignature(n),
    });
  const ready = (n = 1) => {
    step('reserve');
    qualify();
    prepare();
    authorize(n);
    dispatch(n);
  };
  const outcome = (n = 1, fields: Record<string, unknown> = {}) =>
    step('settle', {
      packetSha256: packetHash(),
      signedPacketSha256: signedPacketHash(),
      receiptId: executionId(300 + n),
      sourceSha256: executionHash(7),
      signature: executionSignature(n),
      inputRaw: '100',
      outputRaw: '9',
      networkFeeLamports: '3',
      rentDebitLamports: '2',
      rentRefundLamports: '50',
      landedFailure: false,
      ...fields,
    });
  return {
    manifest,
    ledger,
    step,
    ready,
    qualify,
    prepare,
    authorize,
    dispatch,
    outcome,
    packetHash,
    signedPacketHash,
    time: (at: number) => {
      now = at;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
