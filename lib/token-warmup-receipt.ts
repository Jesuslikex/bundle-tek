import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { transactionSignature } from './tracked-wallet-transaction';
import { requireStoredWarmupBuyLink } from './warmup-buy-link';
import type { SavedWarmupBuyReceipt } from './warmup-buy-receipt';
import type { WarmupSigningEvent } from './warmup-signing-events';

const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const maximum = (1n << 64n) - 1n;
const object = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('receipt document is malformed');
  return parsed as Record<string, unknown>;
};
function integer(value: unknown, signed = false) {
  if (
    typeof value !== 'string' ||
    !(signed ? /^(0|-?[1-9]\d{0,19})$/ : /^(0|[1-9]\d{0,19})$/).test(value)
  )
    throw new Error('receipt amount is malformed');
  const result = BigInt(value);
  if (result > maximum || result < -maximum)
    throw new Error('receipt amount exceeds supported bounds');
  return result;
}
function time(value: unknown) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('receipt timestamp is malformed');
  return Date.parse(value);
}
const positiveRevision = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function receiptDocument(value: unknown) {
  const document = object(value);
  if (
    document.executionAllowed !== false ||
    document.instructionsVerified !== false ||
    document.network !== 'mainnet' ||
    document.commitment !== 'finalized' ||
    document.signatureVerified !== true ||
    document.tokenProgram !== tokenProgram ||
    !Number.isSafeInteger(document.slot) ||
    Number(document.slot) < 0 ||
    (document.blockTime !== null &&
      (!Number.isSafeInteger(document.blockTime) ||
        Number(document.blockTime) < 0)) ||
    !Number.isInteger(document.decimals) ||
    Number(document.decimals) < 0 ||
    Number(document.decimals) > 255 ||
    typeof document.preparationSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(document.preparationSha256) ||
    typeof document.source !== 'string' ||
    !/^[A-Za-z0-9.-]{1,253}$/.test(document.source) ||
    !Array.isArray(document.accounts) ||
    !document.accounts.length ||
    document.accounts.length > 256 ||
    new Set(document.accounts).size !== document.accounts.length
  )
    throw new Error('receipt evidence is unsupported or malformed');
  if (
    walletAddress(document.wallet, 'Solana') !== document.wallet ||
    walletAddress(document.mint, 'Solana') !== document.mint
  )
    throw new Error('receipt addresses are noncanonical');
  for (const account of document.accounts)
    if (walletAddress(account, 'Solana') !== account)
      throw new Error('receipt account is noncanonical');
  transactionSignature(document.signature);
  integer(document.networkFeeLamports);
  integer(document.nativeChangeRaw, true);
  integer(document.rentChangeRaw, true);
  integer(document.nativeSettlementRaw, true);
  time(document.observedAt);
  return document;
}

function receiptRow(value: unknown) {
  const row = object(value);
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    typeof row.preparationId !== 'string' ||
    !UUID.test(row.preparationId) ||
    typeof row.planId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(row.planId)
  )
    throw new Error('receipt identity is malformed');
  const document = receiptDocument(row.document);
  if (row.signature !== document.signature)
    throw new Error('receipt signature binding differs');
  if (time(document.observedAt) > time(row.createdAt))
    throw new Error('receipt observation postdates its saved record');
  return { row, document };
}

export type WarmupReceiptProjection = {
  matched: boolean;
  details: string[];
};

/** A presently retained summary may enrich only a finalized historical state. */
export function projectWarmupReceipt(
  event: WarmupSigningEvent,
  payload: Record<string, unknown>,
): WarmupReceiptProjection {
  if (event.state !== 'finalized') return { matched: false, details: [] };
  const missing = (detail: string) => ({ matched: false, details: [detail] });
  if (
    payload.successfulReceipt === null ||
    payload.successfulReceipt === undefined
  )
    return missing(
      'Matching successful receipt evidence is unavailable for this finalized approval; its recorded state is retained.',
    );
  try {
    const { row, document } = receiptRow(payload.successfulReceipt);
    const terms = event.document;
    const mint = terms.side === 'Buy' ? terms.outputMint : terms.inputMint;
    if (
      row.preparationId !== event.preparationId ||
      row.planId !== event.planId ||
      row.signature !== event.signature ||
      document.wallet !== event.wallet ||
      document.mint !== mint ||
      document.preparationSha256 !== terms.sha256 ||
      time(row.createdAt) > time(event.createdAt)
    )
      throw new Error('receipt does not match the retained approval context');
    if (payload.preparation !== null && payload.preparation !== undefined) {
      const preparation = object(payload.preparation);
      if (time(document.observedAt) < time(preparation.createdAt))
        throw new Error(
          'receipt observation predates the retained preparation',
        );
    }
    if (payload.intent !== null && payload.intent !== undefined) {
      const intent = object(payload.intent);
      if (
        integer(document.networkFeeLamports) >
        integer(intent.maximumFeeLamports)
      )
        throw new Error(
          'receipt network fee exceeds the retained approval limit',
        );
    }
    let units: bigint;
    const settlement = integer(document.nativeSettlementRaw, true);
    if (terms.side === 'Buy') {
      units = integer(document.acquiredRaw);
      if (
        row.planRevision !== event.planRevision ||
        row.cycle !== event.cycle ||
        row.wallet !== event.wallet ||
        !positiveRevision(row.walletRevision) ||
        units === 0n ||
        units < integer(terms.minimumOutputRaw) ||
        settlement !== -integer(terms.inputRaw)
      )
        throw new Error(
          'buy receipt acquisition or exact input settlement differs',
        );
      if (payload.preparation !== null && payload.preparation !== undefined) {
        const preparation = object(payload.preparation);
        if (row.walletRevision !== preparation.walletRevision)
          throw new Error('buy receipt wallet revision differs');
      }
    } else {
      units = integer(document.consumedRaw);
      if (
        units === 0n ||
        document.consumedRaw !== row.consumedRaw ||
        document.consumedRaw !== terms.inputRaw ||
        settlement < integer(terms.minimumOutputRaw) ||
        row.buyReceiptId !== document.buyReceiptId
      )
        throw new Error(
          'sell receipt consumption or minimum settlement differs',
        );
      if (
        payload.linkedBuyReceipt === null ||
        payload.linkedBuyReceipt === undefined
      )
        return missing(
          'Successful sell receipt summary is retained, but its matching buy provenance is unavailable; successful receipt evidence is not established by this view.',
        );
      if (payload.preparation === null || payload.preparation === undefined)
        return missing(
          'Successful sell receipt summary is retained, but its original preparation buy link is unavailable; successful receipt evidence is not established by this view.',
        );
      const linked = receiptRow(payload.linkedBuyReceipt);
      const buy = linked.document;
      const preparation = object(payload.preparation);
      const preparationDocument = object(preparation.document);
      if (
        linked.row.id !== row.buyReceiptId ||
        linked.row.planId !== event.planId ||
        linked.row.cycle !== event.cycle ||
        linked.row.wallet !== event.wallet ||
        buy.wallet !== event.wallet ||
        buy.mint !== mint ||
        buy.decimals !== document.decimals ||
        buy.tokenProgram !== document.tokenProgram ||
        Number(document.slot) <= Number(buy.slot) ||
        units > integer(buy.acquiredRaw) ||
        integer(buy.acquiredRaw) === 0n ||
        integer(buy.nativeSettlementRaw, true) >= 0n ||
        time(linked.row.createdAt) > time(row.createdAt) ||
        time(linked.row.createdAt) > time(preparation.createdAt) ||
        linked.row.signature === row.signature ||
        !positiveRevision(linked.row.planRevision) ||
        !positiveRevision(linked.row.walletRevision)
      )
        throw new Error('sell receipt linked buy context differs');
      // The mutable present-day remaining_raw is deliberately absent. Only original
      // acquisition/provenance is checked here; this is not a lot-balance view.
      const retainedBuy = {
        id: linked.row.id,
        preparationId: linked.row.preparationId,
        planId: linked.row.planId,
        planRevision: linked.row.planRevision,
        cycle: linked.row.cycle,
        walletRevision: linked.row.walletRevision,
        createdAt: linked.row.createdAt,
        document: buy,
      } as unknown as SavedWarmupBuyReceipt;
      requireStoredWarmupBuyLink(
        retainedBuy,
        {
          planId: event.planId,
          planRevision: event.planRevision,
          cycle: event.cycle,
          wallet: event.wallet,
          walletRevision: Number(preparation.walletRevision),
          mint,
        },
        preparationDocument.buyReceipt as Parameters<
          typeof requireStoredWarmupBuyLink
        >[2],
      );
    }
    return {
      matched: true,
      details: [
        `Presently retained matching finalized ${terms.side.toLowerCase()} receipt ${String(row.id)}; slot ${Number(document.slot)}; observed ${String(document.observedAt)} via ${String(document.source)}`,
        `${terms.side === 'Buy' ? 'Acquired' : 'Consumed'} ${units} atomic token units; ${Number(document.decimals)} decimals; recorded SOL settlement ${settlement} lamports`,
        `Network fee ${String(document.networkFeeLamports)} lamports; account rent change ${String(document.rentChangeRaw)} lamports. Fees and rent are separate from the recorded swap settlement.`,
        ...(terms.side === 'Sell'
          ? [
              `Linked buy receipt ${String(row.buyReceiptId)}; original acquired units and retained buy provenance matched.`,
            ]
          : []),
        'The current receipt summary matches this finalized event. Receipt records can change independently of the immutable approval event. This view does not independently reconstruct raw balances or wrapped SOL changes, report historical remaining units, or compute P&L.',
      ],
    };
  } catch {
    return missing(
      'Presently retained successful receipt evidence is malformed or contradicts the finalized approval terms; its recorded state is retained without a successful receipt claim.',
    );
  }
}
