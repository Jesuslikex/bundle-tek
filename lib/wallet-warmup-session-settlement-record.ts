import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { parseWalletWarmupSessionSettlement } from './wallet-warmup-session-sequence';
import { parseWarmupSessionSettlementSelection } from './wallet-warmup-session-settlement';
import { warmupSessionSettlementSourceGuard } from './wallet-warmup-session-settlement-source';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const schema = z
  .object({
    format: z.literal('wallet-warmup-session-settlement-v1'),
    id: uuid,
    journalId: uuid,
    actionId: z.string().min(1).max(256),
    receiptId: uuid,
    version: z.number().int().min(0).max(4095),
    headSha256: hash,
    candidate: z.unknown(),
    settlement: z.unknown(),
    sourceSha256: hash,
    scope: z.literal('owned-signature-packet-finalized-balances'),
    mode: z.enum(['applied', 'held']),
    reason: z.literal('sequence-refused').nullable(),
    createdAt: iso,
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
const fail = (): never => {
  throw Error('Retained verified settlement record is unavailable or changed.');
};

/** Historical immutable envelope admission, NOT fresh provider verification or permission. */
export async function parseWalletWarmupSessionSettlementRecord(
  document: string,
  sha256: string,
  source?: { owner: string; document: string },
) {
  try {
    if (
      typeof document !== 'string' ||
      new TextEncoder().encode(document).byteLength > 16384 ||
      !hash.safeParse(sha256).success ||
      (await digest(document)) !== sha256
    )
      return fail();
    const value = schema.parse(JSON.parse(document));
    if (canonical(value) !== document) return fail();
    const settlement = parseWalletWarmupSessionSettlement(value.settlement);
    const selected = parseWarmupSessionSettlementSelection({
      planId: settlement.planId,
      planRevision: settlement.planRevision,
      receiptId: value.receiptId,
      candidate: value.candidate,
    });
    const action = selected.candidate.action;
    if (
      value.actionId !== action.id ||
      value.actionId !== settlement.actionId ||
      value.receiptId !== settlement.receiptId ||
      action.wallet !== settlement.wallet ||
      action.walletRevision !== settlement.walletRevision ||
      action.mint !== settlement.mint ||
      action.side !== settlement.side ||
      (value.mode === 'applied'
        ? value.reason !== null
        : value.reason !== 'sequence-refused')
    )
      return fail();
    if (action.side === 'Buy') {
      if (
        settlement.side !== 'Buy' ||
        action.inputLamports !== settlement.inputLamports ||
        selected.candidate.sellSource !== null
      )
        return fail();
    } else if (
      settlement.side !== 'Sell' ||
      !selected.candidate.sellSource ||
      selected.candidate.sellSource.buyReceiptId !== settlement.buyReceiptId ||
      selected.candidate.sellSource.remainingRaw !== settlement.consumedRaw
    )
      return fail();
    if (source) {
      await warmupSessionSettlementSourceGuard(source.owner, settlement.side, {
        sourceDocument: source.document,
        sourceSha256: value.sourceSha256,
      });
      const [root] = JSON.parse(source.document);
      const receipt = JSON.parse(root.receiptDocument),
        prep = JSON.parse(root.preparationDocument),
        approval = JSON.parse(root.approvalDocument);
      if (
        root.receiptId !== settlement.receiptId ||
        root.planId !== settlement.planId ||
        root.receiptPlanId !== settlement.planId ||
        root.planRevision !== settlement.planRevision ||
        root.walletRevision !== settlement.walletRevision ||
        root.cycle !== action.cycle ||
        root.approvalWallet !== settlement.wallet ||
        receipt.network !== 'mainnet' ||
        receipt.commitment !== 'finalized' ||
        receipt.signatureVerified !== true ||
        receipt.executionAllowed !== false ||
        receipt.instructionsVerified !== false ||
        receipt.signature !== root.receiptSignature ||
        receipt.wallet !== settlement.wallet ||
        receipt.mint !== settlement.mint ||
        receipt.preparationSha256 !== prep.transaction?.sha256 ||
        receipt.preparationSha256 !== approval.sha256 ||
        receipt.networkFeeLamports !== settlement.networkFeeLamports ||
        receipt.rentChangeRaw !== settlement.rentChangeLamports
      )
        return fail();
      if (settlement.side === 'Buy') {
        if (
          (-BigInt(receipt.nativeSettlementRaw)).toString() !==
            settlement.inputLamports ||
          receipt.acquiredRaw !== settlement.acquiredRaw ||
          receipt.decimals !== settlement.decimals
        )
          return fail();
      } else if (
        root.buyReceiptId !== settlement.buyReceiptId ||
        receipt.buyReceiptId !== settlement.buyReceiptId ||
        root.consumedRaw !== settlement.consumedRaw ||
        receipt.consumedRaw !== settlement.consumedRaw
      )
        return fail();
    }
    return { ...value, candidate: selected.candidate, settlement };
  } catch {
    return fail();
  }
}
