import bs58 from 'bs58';
import type { SupplyMovementEvidence } from './supply-movement-evidence';
import { requireMovementClassification } from './wallet-movement-classification';
import { walletAddress } from './wallet-workspace';

export type MovementSummaryScope = {
  observationId: string;
  wallet: string;
  mint: string;
  decimals: number;
  toSlot: number;
  previousRaw: string;
  currentRaw: string;
};
const units = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid movement units.');
  return BigInt(value);
};
export function summarizeSupplyMovements(
  records: SupplyMovementEvidence[],
  scope: MovementSummaryScope,
) {
  try {
    walletAddress(scope.wallet, 'Solana');
    walletAddress(scope.mint, 'Solana');
    if (
      !Array.isArray(records) ||
      records.length > 20 ||
      !Number.isSafeInteger(scope.decimals) ||
      scope.decimals < 0 ||
      scope.decimals > 255 ||
      !Number.isSafeInteger(scope.toSlot) ||
      scope.toSlot < 1
    )
      throw new Error();
    const observedDelta = units(scope.currentRaw) - units(scope.previousRaw);
    const transactions = new Map<
      string,
      {
        chainFingerprint: string;
        knownFingerprint: string | null;
        classificationFingerprint: string;
        versions: Map<number, string>;
        invalidProvenance: boolean;
        observedAt: number | null;
        tx: SupplyMovementEvidence['transactions'][number];
      }
    >();
    const buckets = {
      buy: { count: 0, raw: 0n },
      sell: { count: 0, raw: 0n },
      transferIn: { count: 0, raw: 0n },
      transferOut: { count: 0, raw: 0n },
      unknown: { count: 0, raw: 0n },
    };
    let fromSlot: number | null = null;
    for (const record of records) {
      if (
        record.observationId !== scope.observationId ||
        record.wallet !== scope.wallet ||
        record.mint !== scope.mint ||
        record.toSlot !== scope.toSlot ||
        !Number.isSafeInteger(record.fromSlot) ||
        record.fromSlot < 0 ||
        record.fromSlot >= scope.toSlot ||
        !Array.isArray(record.transactions) ||
        record.transactions.length > 5
      )
        throw new Error();
      if (fromSlot !== null && fromSlot !== record.fromSlot) throw new Error();
      fromSlot = record.fromSlot;
      const parsedTime = Date.parse(record.observedAt);
      const validProvenance =
        typeof record.observedAt === 'string' &&
        Number.isFinite(parsedTime) &&
        new Date(parsedTime).toISOString() === record.observedAt &&
        Number.isSafeInteger(record.anchor) &&
        record.anchor >= record.toSlot;
      for (const tx of record.transactions) {
        if (
          typeof tx.signature !== 'string' ||
          tx.signature.length > 88 ||
          bs58.decode(tx.signature).length !== 64 ||
          !Number.isSafeInteger(tx.slot) ||
          tx.slot <= record.fromSlot ||
          tx.slot > record.toSlot ||
          tx.decimals !== scope.decimals ||
          typeof tx.changeRaw !== 'string' ||
          !/^(0|-?[1-9]\d{0,19})$/.test(tx.changeRaw) ||
          units(tx.afterRaw) - units(tx.beforeRaw) !== BigInt(tx.changeRaw)
        )
          throw new Error();
        requireMovementClassification(tx.classification, tx.changeRaw);
        const c = tx.classification;
        const chainFingerprint = JSON.stringify([
          tx.slot,
          tx.beforeRaw,
          tx.afterRaw,
          tx.changeRaw,
          tx.decimals,
        ]);
        const classificationFingerprint = JSON.stringify([
          c?.kind ?? 'unknown',
          c?.basis ?? 'unresolved',
          c?.protocol,
          c?.quote?.mint,
          c?.quote?.raw,
          c?.quote?.decimals,
          c?.quote?.asset,
          c?.quote?.scope,
          [...(c?.counterpartyAccounts ?? [])].sort(),
        ]);
        const knownFingerprint =
          c && c.kind !== 'unknown' ? classificationFingerprint : null;
        const observedAt =
          validProvenance &&
          typeof tx.source === 'string' &&
          /^[a-zA-Z0-9.-]{1,253}$/.test(tx.source)
            ? parsedTime
            : null;
        const prior = transactions.get(tx.signature);
        const conflict = () => ({
          ok: false as const,
          error:
            'Conflicting saved transaction evidence. Reload and inspect before using activity totals.',
        });
        if (prior) {
          if (
            prior.chainFingerprint !== chainFingerprint ||
            (prior.knownFingerprint !== null &&
              knownFingerprint !== null &&
              prior.knownFingerprint !== knownFingerprint)
          )
            return conflict();
          const differs =
            prior.classificationFingerprint !== classificationFingerprint;
          // Dates order server-saved inspections, never the on-chain event.
          // All versions remain checked, including a version superseded by
          // an unresolved decode, so later input cannot hide a contradiction.
          if (
            (differs && (prior.invalidProvenance || observedAt === null)) ||
            (observedAt !== null &&
              prior.versions.has(observedAt) &&
              prior.versions.get(observedAt) !== classificationFingerprint) ||
            (observedAt === null &&
              [...prior.versions.values()].some(
                (fingerprint) => fingerprint !== classificationFingerprint,
              ))
          )
            return conflict();
          prior.knownFingerprint ??= knownFingerprint;
          prior.invalidProvenance ||= observedAt === null;
          if (observedAt !== null)
            prior.versions.set(observedAt, classificationFingerprint);
          if (
            observedAt !== null &&
            (prior.observedAt === null || observedAt > prior.observedAt)
          ) {
            prior.tx = tx;
            prior.observedAt = observedAt;
            prior.classificationFingerprint = classificationFingerprint;
          }
          continue;
        }
        transactions.set(tx.signature, {
          chainFingerprint,
          knownFingerprint,
          classificationFingerprint,
          versions:
            observedAt === null
              ? new Map()
              : new Map([[observedAt, classificationFingerprint]]),
          invalidProvenance: observedAt === null,
          observedAt,
          tx,
        });
      }
    }
    let decodedNet = 0n;
    for (const { tx } of transactions.values()) {
      const delta = BigInt(tx.changeRaw);
      decodedNet += delta;
      const kind = tx.classification?.kind ?? 'unknown';
      const bucket =
        kind === 'buy'
          ? buckets.buy
          : kind === 'sell'
            ? buckets.sell
            : kind === 'transfer' && delta > 0n
              ? buckets.transferIn
              : kind === 'transfer' && delta < 0n
                ? buckets.transferOut
                : buckets.unknown;
      bucket.count++;
      bucket.raw += kind === 'unknown' ? delta : delta < 0n ? -delta : delta;
    }
    return {
      ok: true as const,
      transactionCount: transactions.size,
      buckets,
      fromSlot,
      observedDeltaRaw: observedDelta.toString(),
      decodedNetRaw: decodedNet.toString(),
      unexplainedRaw: (observedDelta - decodedNet).toString(),
      balancesMatch: observedDelta === decodedNet,
    };
  } catch {
    return {
      ok: false as const,
      error:
        'Saved evidence does not match this wallet alert. Activity totals are unavailable.',
    };
  }
}
