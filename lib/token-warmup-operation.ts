import {
  isWarmupSigningEvent,
  warmupSigningEventLabel,
  type WarmupSigningEvent,
} from './warmup-signing-events';
import { walletAddress } from './wallet-workspace';
import { validatedSwapFailure } from './swap-failure';
import { projectWarmupReceipt } from './token-warmup-receipt';
import type { TokenOperation, OperationRow } from './token-operation-history';

const wrapped = 'So11111111111111111111111111111111111111112';
const units = (raw: unknown) =>
  typeof raw === 'string' &&
  /^[1-9]\d{0,19}$/.test(raw) &&
  BigInt(raw) <= (1n << 64n) - 1n;
const object = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Warmup history evidence unavailable.');
  return parsed as Record<string, unknown>;
};
const iso = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Warmup history timestamp differs.');
  return value;
};

/** Mint attribution describes the retained action; it does not invent project initiation. */
export function projectWarmupOperation(
  row: OperationRow,
  p: Record<string, unknown>,
  base: Omit<TokenOperation, 'label' | 'state' | 'details'>,
): TokenOperation {
  const event = {
    ...p,
    document: object(p.document),
    failureReceipt: p.failureReceipt === null ? null : object(p.failureReceipt),
  } as unknown as WarmupSigningEvent;
  if (
    !isWarmupSigningEvent(event) ||
    event.sequence !== row.ordinal ||
    row.category !== 'Warmup'
  )
    throw new Error('Warmup history differs.');
  const terms = event.document;
  walletAddress(event.wallet, 'Solana');
  const mint = walletAddress(
    terms.side === 'Buy' ? terms.outputMint : terms.inputMint,
    'Solana',
  );
  if (
    mint !== p.selectedMint ||
    mint === wrapped ||
    (terms.side === 'Buy' ? terms.inputMint : terms.outputMint) !== wrapped ||
    !units(terms.inputRaw) ||
    !units(terms.minimumOutputRaw)
  )
    throw new Error('Warmup mint or amount differs.');
  const details = [
    `Wallet ${event.wallet}; plan ${event.planId}, revision ${event.planRevision}, cycle ${event.cycle}`,
    `${terms.side} input ${terms.inputRaw} atomic units; minimum output ${terms.minimumOutputRaw} atomic units`,
    'Attributed by the retained token mint. This does not establish that the action was started in this project.',
  ];
  if (p.preparation !== null) {
    const preparation = object(p.preparation);
    const doc = object(preparation.document);
    const transaction = object(doc.transaction);
    if (
      preparation.id !== event.preparationId ||
      preparation.planId !== event.planId ||
      preparation.planRevision !== event.planRevision ||
      preparation.cycle !== event.cycle ||
      preparation.wallet !== event.wallet ||
      doc.wallet !== event.wallet ||
      doc.executionAllowed !== false ||
      doc.instructionsVerified !== false ||
      doc.chain !== 'Solana' ||
      !Number.isSafeInteger(preparation.walletRevision) ||
      Number(preparation.walletRevision) < 1 ||
      doc.side !== terms.side ||
      transaction.sha256 !== terms.sha256 ||
      doc.inputMint !== terms.inputMint ||
      doc.outputMint !== terms.outputMint ||
      doc.inAmountRaw !== terms.inputRaw ||
      doc.minimumOutRaw !== terms.minimumOutputRaw ||
      Date.parse(iso(preparation.createdAt)) > Date.parse(event.createdAt)
    )
      throw new Error('Warmup preparation history differs.');
  } else
    details.push(
      'The original preparation record is unavailable; approval terms are retained.',
    );
  const successfulReceipt = projectWarmupReceipt(event, p);
  let networkVerified = !!event.failureReceipt || successfulReceipt.matched;
  if (p.intent !== null) {
    const intent = object(p.intent);
    if (
      intent.id !== event.intentId ||
      intent.preparationId !== event.preparationId ||
      intent.wallet !== event.wallet ||
      intent.network !== 'mainnet' ||
      intent.documentId !== event.intentId ||
      intent.documentPreparationId !== event.preparationId ||
      intent.documentWallet !== event.wallet ||
      (event.signature !== null && intent.signature !== event.signature) ||
      intent.sha256 !== terms.sha256 ||
      intent.inputMint !== terms.inputMint ||
      intent.outputMint !== terms.outputMint ||
      intent.inputRaw !== terms.inputRaw ||
      intent.minimumOutputRaw !== terms.minimumOutputRaw ||
      Date.parse(iso(intent.createdAt)) > Date.parse(event.createdAt)
    )
      throw new Error('Warmup approval context differs.');
    networkVerified = true;
    if (event.failureReceipt) {
      const maximumFeeLamports = intent.maximumFeeLamports;
      if (
        typeof maximumFeeLamports !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(maximumFeeLamports) ||
        BigInt(maximumFeeLamports) > (1n << 64n) - 1n
      )
        throw new Error('Warmup reviewed fee evidence differs.');
      validatedSwapFailure(
        event.failureReceipt,
        { wallet: event.wallet, ...terms, maximumFeeLamports },
        event.signature!,
      );
    }
    details.push('Mainnet network retained in the matching approval review.');
  } else if (event.failureReceipt)
    details.push(
      'Mainnet finalized failure context retained in the matching failure evidence.',
    );
  else if (successfulReceipt.matched)
    details.push(
      'Mainnet finalized receipt context retained in the presently matching successful receipt evidence.',
    );
  else
    details.push(
      'Network evidence is unavailable for this retained record; no mainnet receipt is asserted.',
    );
  if (event.type === 'approval.baseline')
    details.push(
      'Retained-state baseline; earlier transitions were not reconstructed.',
    );
  if (
    event.failureReceipt &&
    Date.parse(iso(event.failureReceipt.observedAt)) >
      Date.parse(event.createdAt)
  )
    throw new Error('Warmup failure observation postdates its history event.');
  if (event.state === 'finalized') {
    details.push(...successfulReceipt.details);
    if (!successfulReceipt.matched)
      details.push(
        'Finalized approval state recorded. This history entry does not include matching successful trade receipt evidence or compute P&L.',
      );
  }
  if (event.state === 'failed' && !event.failureReceipt)
    details.push(
      'Legacy failure state recorded without retained finalized failure evidence.',
    );
  else if (event.failureReceipt)
    details.push(
      `Retained failure evidence: slot ${event.failureReceipt.slot}; transaction failed.`,
    );
  if (event.signature && !networkVerified)
    details.push(
      `Retained signature: ${event.signature}; network-specific transaction link unavailable.`,
    );
  const label =
    event.state === 'finalized'
      ? successfulReceipt.matched
        ? 'Presently retained matching finalized receipt'
        : 'Finalized approval recorded'
      : event.state === 'failed' && !event.failureReceipt
        ? 'Failure recorded; evidence unavailable'
        : warmupSigningEventLabel(event.type);
  return {
    ...base,
    label: `Warmup ${terms.side}: ${label}`,
    state: event.state,
    signature: networkVerified ? event.signature : null,
    details,
  };
}
