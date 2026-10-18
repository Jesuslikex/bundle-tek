import { importedTradeReceipt } from './imported-trade-ledger';
import { decodeWarmupReceipt } from './warmup-buy-receipt';
import { verifyExactSwapSignature } from './exact-swap-signature';
import type { WarmupSigningReview } from './warmup-signing';
import type { UnsignedSwapPreparationSummary } from './imported-swap-preparation-history';
import {
  canonicalPumpHolderJson as canonical,
  pumpHolderDigest as digest,
} from './pump-holder-review';
import { UUID } from './wallet-operation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

export type ImportedSaleParent = {
  ownerId: string;
  receiptId: string;
  projectId: string;
  preparationId: string;
  intentId: string;
  projectRevision: number;
  walletRevision: number;
  signature: string;
  wallet: string;
  state: string;
  receiptDocument: string;
  preparationDocument: string;
  approvalDocument: string;
};
export type ImportedSaleEvidenceRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
type Report = Awaited<ReturnType<typeof decodeWarmupReceipt>>;
export type ImportedSaleEvidence = {
  format: 'imported-sale-receipt-evidence-v1';
  receiptId: string;
  parentSha256: string;
  raw: Record<string, unknown>;
  report: Report;
  observedAt: string;
  signingAllowed: false;
  executionAllowed: false;
  profitCalculated: false;
  acquisitionLinksChanged: false;
  economicSettlementVerified: false;
  sha256: string;
};
const fail = (): never => {
  throw new Error(
    'Retained sale receipt evidence differs. No acquisition or profit result is qualified.',
  );
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function selected(raw: unknown) {
  if (!record(raw) || !record(raw.meta)) return fail();
  const fields = ['version', 'slot', 'blockTime', 'transaction'],
    metaFields = [
      'err',
      'fee',
      'loadedAddresses',
      'preBalances',
      'postBalances',
      'preTokenBalances',
      'postTokenBalances',
    ];
  const text = JSON.stringify({
    ...Object.fromEntries(fields.map((k) => [k, raw[k]])),
    meta: Object.fromEntries(
      metaFields.map((k) => [
        k,
        raw.meta && (raw.meta as Record<string, unknown>)[k],
      ]),
    ),
  });
  if (new TextEncoder().encode(text).byteLength > 1048576)
    throw Error('Sale receipt metadata exceeds the storage limit.');
  return JSON.parse(text) as Record<string, unknown>;
}
function parent(value: ImportedSaleParent) {
  const p = structuredClone(value);
  if (
    !p ||
    Object.keys(p).sort().join(',') !==
      'approvalDocument,intentId,ownerId,preparationDocument,preparationId,projectId,projectRevision,receiptDocument,receiptId,signature,state,wallet,walletRevision' ||
    typeof p.ownerId !== 'string' ||
    !p.ownerId ||
    p.ownerId.length > 256 ||
    ![p.receiptId, p.projectId, p.preparationId, p.intentId].every(
      (id) => typeof id === 'string' && UUID.test(id),
    ) ||
    p.state !== 'finalized' ||
    ![p.projectRevision, p.walletRevision].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    ![p.receiptDocument, p.preparationDocument, p.approvalDocument].every(
      (s) =>
        typeof s === 'string' &&
        new TextEncoder().encode(s).byteLength <= 65536,
    )
  )
    return fail();
  const raw = JSON.parse(p.receiptDocument) as Record<string, unknown>,
    preparation = JSON.parse(
      p.preparationDocument,
    ) as UnsignedSwapPreparationSummary,
    approval = JSON.parse(p.approvalDocument) as WarmupSigningReview;
  const receipt = importedTradeReceipt(
    {
      id: p.receiptId,
      projectId: p.projectId,
      preparationId: p.preparationId,
      projectRevision: p.projectRevision,
      walletRevision: p.walletRevision,
      createdAt: raw.observedAt,
      document: raw,
    },
    p.projectId,
    String(raw.mint),
    Number(raw.decimals),
  );
  if (
    receipt.document.side !== 'Sell' ||
    receipt.document.signature !== p.signature ||
    receipt.document.wallet !== p.wallet ||
    preparation.side !== 'Sell' ||
    preparation.chain !== 'Solana' ||
    preparation.executionAllowed !== false ||
    preparation.instructionsVerified !== false ||
    preparation.wallet !== p.wallet ||
    preparation.outputMint !== 'So11111111111111111111111111111111111111112' ||
    preparation.inputMint !== receipt.document.mint ||
    preparation.inAmountRaw !== receipt.document.tokenUnitsRaw ||
    preparation.transaction.sha256 !== receipt.document.preparationSha256 ||
    approval.id !== p.intentId ||
    approval.preparationId !== p.preparationId ||
    approval.wallet !== p.wallet ||
    approval.network !== 'mainnet' ||
    approval.sha256 !== preparation.transaction.sha256 ||
    approval.inputRaw !== preparation.inAmountRaw ||
    approval.minimumOutputRaw !== preparation.minimumOutRaw ||
    approval.inputMint !== preparation.inputMint ||
    approval.outputMint !== preparation.outputMint ||
    approval.lastValidBlockHeight !==
      preparation.transaction.lastValidBlockHeight ||
    (Object.hasOwn(raw, 'executionAllowed') &&
      raw.executionAllowed !== false) ||
    (Object.hasOwn(raw, 'instructionsVerified') &&
      raw.instructionsVerified !== false)
  )
    return fail();
  if (new TextEncoder().encode(canonical(p)).byteLength > 524288) return fail();
  return { p, receipt, preparation, approval };
}
/** Validate the original finalized Sell binding before any gate or empty read. */
export function requireImportedSaleParent(
  value: ImportedSaleParent,
): ImportedSaleParent {
  return parent(value).p;
}
async function replay(
  raw: Record<string, unknown>,
  scope: ReturnType<typeof parent>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const tx = raw.transaction;
  if (
    !Array.isArray(tx) ||
    typeof tx[0] !== 'string' ||
    verifyExactSwapSignature(scope.approval, tx[0]) !== scope.p.signature
  )
    return fail();
  const report = await decodeWarmupReceipt(
      raw,
      { document: scope.preparation },
      scope.p.signature,
      'Sell',
      scope.approval,
    ),
    doc = scope.receipt.document;
  for (const field of [
    'network',
    'commitment',
    'signature',
    'signatureVerified',
    'wallet',
    'mint',
    'preparationSha256',
    'slot',
    'blockTime',
    'decimals',
    'networkFeeLamports',
    'nativeChangeRaw',
    'rentChangeRaw',
    'nativeSettlementRaw',
  ] as const)
    if (report[field] !== doc[field]) return fail();
  if (report.acquiredRaw !== doc.tokenUnitsRaw) return fail();
  const original = JSON.parse(scope.p.receiptDocument) as Record<
    string,
    unknown
  >;
  for (const field of ['tokenProgram', 'accounts'] as const)
    if (
      Object.hasOwn(original, field) &&
      canonical(original[field]) !== canonical(report[field])
    )
      return fail();
  signal.throwIfAborted();
  return report;
}
/** Explicit finalized read only. Caller supplies identity, never receipt data.
 * Provider finality is trusted as in the original parser; no venue/code audit,
 * fresh signing approval, acquisition consumption or profit is established. */
export async function collectImportedSaleEvidence(
  supplied: ImportedSaleParent,
  signal: AbortSignal,
  rpc: ImportedSaleEvidenceRpc,
): Promise<ImportedSaleEvidence> {
  signal.throwIfAborted();
  const scope = parent(supplied);
  if ((await rpc('getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS)
    throw Error('The sale receipt provider is not on Solana mainnet.');
  signal.throwIfAborted();
  const raw = selected(
    await rpc(
      'getTransaction',
      [
        scope.p.signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    ),
  );
  signal.throwIfAborted();
  const report = await replay(raw, scope, signal);
  const value = {
    format: 'imported-sale-receipt-evidence-v1' as const,
    receiptId: scope.p.receiptId,
    parentSha256: await digest(scope.p),
    raw,
    report,
    observedAt: new Date().toISOString(),
    signingAllowed: false as const,
    executionAllowed: false as const,
    profitCalculated: false as const,
    acquisitionLinksChanged: false as const,
    economicSettlementVerified: false as const,
  };
  const sha256 = await digest(value);
  signal.throwIfAborted();
  return { ...value, sha256 };
}
/** Replays retained normalized metadata with the original signature and receipt
 * parsers, without any provider access or mutation. */
export async function parseImportedSaleEvidence(
  supplied: unknown,
  suppliedParent: ImportedSaleParent,
  signal: AbortSignal,
): Promise<ImportedSaleEvidence> {
  signal.throwIfAborted();
  const text = JSON.stringify(supplied);
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).byteLength > 1310720
  )
    return fail();
  const v = JSON.parse(text) as ImportedSaleEvidence,
    scope = parent(suppliedParent);
  if (
    !record(v) ||
    Object.keys(v).sort().join(',') !==
      'acquisitionLinksChanged,economicSettlementVerified,executionAllowed,format,observedAt,parentSha256,profitCalculated,raw,receiptId,report,sha256,signingAllowed' ||
    v.format !== 'imported-sale-receipt-evidence-v1' ||
    v.receiptId !== scope.p.receiptId ||
    v.parentSha256 !== (await digest(scope.p)) ||
    ![
      v.signingAllowed,
      v.executionAllowed,
      v.profitCalculated,
      v.acquisitionLinksChanged,
      v.economicSettlementVerified,
    ].every((flag) => flag === false) ||
    typeof v.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    new Date(v.observedAt).toISOString() !== v.observedAt ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256)
  )
    return fail();
  const { sha256, ...core } = v;
  if (
    (await digest(core)) !== sha256 ||
    canonical(selected(v.raw)) !== canonical(v.raw)
  )
    return fail();
  const report = await replay(v.raw, scope, signal);
  if (canonical(report) !== canonical(v.report)) return fail();
  signal.throwIfAborted();
  return v;
}
