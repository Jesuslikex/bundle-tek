import {
  collectPumpGroupChainEffects,
  parsePumpGroupChainEffects,
  type PumpGroupChainEffects,
} from './pump-group-chain-effects';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

type Group = Parameters<typeof parsePumpGroupChainEffects>[1];
export const PUMP_RECEIPT_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
export type PumpGroupReceiptEvidence = {
  format: 'pump-group-receipt-evidence-v1';
  report: PumpGroupChainEffects;
  receipts: (Record<string, unknown> | null)[];
  acquisitionBasisVerified: false;
  signingAllowed: false;
  executionAllowed: false;
  reservationsChanged: false;
  sha256: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === expected.sort().join(',');

function bounded(value: unknown) {
  const text = canonicalPumpHolderJson(value);
  if (new TextEncoder().encode(text).length > PUMP_RECEIPT_EVIDENCE_MAX_BYTES)
    throw new Error('Finalized receipt evidence exceeds its storage limit.');
  return text;
}

/** Keep only transaction execution metadata, never logs, rewards or provider extras. */
function receipt(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!record(value) || !record(value.meta))
    throw new Error('Finalized receipt metadata is unavailable.');
  const meta: Record<string, unknown> = {};
  for (const key of [
    'err',
    'fee',
    'preBalances',
    'postBalances',
    'preTokenBalances',
    'postTokenBalances',
    'loadedAddresses',
    'innerInstructions',
  ])
    if (Object.hasOwn(value.meta, key)) meta[key] = value.meta[key];
  // Detach from a provider callback before verification; the verifier receives
  // exactly the bytes represented by this retained JSON document.
  return JSON.parse(
    bounded({ slot: value.slot, transaction: value.transaction, meta }),
  ) as Record<string, unknown>;
}

export async function collectPumpGroupReceiptEvidence(
  group: Group,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<PumpGroupReceiptEvidence> {
  if (!group.signedEvidence)
    throw new Error('Complete signed launch group required.');
  const receipts: PumpGroupReceiptEvidence['receipts'] = [];
  const report = await collectPumpGroupChainEffects(
    group.review,
    group.signedEvidence,
    signal,
    async (method, params, deadline) => {
      if (!['getGenesisHash', 'getTransaction'].includes(method))
        throw new Error('Receipt history has no execution transport.');
      const value = await rpc(method, params, deadline);
      deadline.throwIfAborted();
      if (method !== 'getTransaction') return value;
      const next = receipt(value);
      receipts.push(next);
      bounded(receipts);
      return next;
    },
  );
  signal.throwIfAborted();
  if (!report.packets.some((packet) => packet.outcome !== 'not-observed'))
    throw new Error('No finalized launch receipt is available to save yet.');
  const body = {
    format: 'pump-group-receipt-evidence-v1' as const,
    report,
    receipts,
    acquisitionBasisVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    reservationsChanged: false as const,
  };
  const result = { ...body, sha256: await pumpHolderDigest(body) };
  bounded(result);
  return result;
}

/** Recompute from exact retained receipts, using no external provider. */
export async function parsePumpGroupReceiptEvidence(
  value: unknown,
  group: Group,
  signal: AbortSignal,
): Promise<PumpGroupReceiptEvidence> {
  signal.throwIfAborted();
  if (
    !record(value) ||
    !exactKeys(value, [
      'format',
      'report',
      'receipts',
      'acquisitionBasisVerified',
      'signingAllowed',
      'executionAllowed',
      'reservationsChanged',
      'sha256',
    ]) ||
    value.format !== 'pump-group-receipt-evidence-v1' ||
    !group.signedEvidence ||
    !Array.isArray(value.receipts) ||
    value.receipts.length !== group.signedEvidence.packets.length ||
    value.acquisitionBasisVerified !== false ||
    value.signingAllowed !== false ||
    value.executionAllowed !== false ||
    value.reservationsChanged !== false
  )
    throw new Error('Saved launch receipt evidence differs.');
  const { sha256, ...body } = value;
  bounded(value);
  if (
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    (await pumpHolderDigest(body)) !== sha256
  )
    throw new Error('Saved launch receipt evidence hash differs.');
  const report = await parsePumpGroupChainEffects(value.report, group);
  const receipts = value.receipts;
  let cursor = 0;
  const replay = await collectPumpGroupReceiptEvidence(
    group,
    signal,
    async (method, params) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      const packet = group.signedEvidence!.packets[cursor];
      if (
        method !== 'getTransaction' ||
        !packet ||
        params[0] !== packet.signature
      )
        throw new Error('Saved launch receipt replay scope differs.');
      const retained: unknown = receipts[cursor++];
      if (
        canonicalPumpHolderJson(receipt(retained)) !==
        canonicalPumpHolderJson(retained)
      )
        throw new Error('Saved launch receipt contains unexpected fields.');
      return retained;
    },
  );
  const comparable = (r: PumpGroupChainEffects) => {
    const { observedAt: _observedAt, sha256: _sha256, ...rest } = r;
    return canonicalPumpHolderJson(rest);
  };
  if (
    cursor !== value.receipts.length ||
    comparable(report) !== comparable(replay.report)
  )
    throw new Error('Saved launch report differs from its receipt metadata.');
  signal.throwIfAborted();
  return value as unknown as PumpGroupReceiptEvidence;
}
