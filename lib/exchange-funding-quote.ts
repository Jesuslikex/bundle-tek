import { z } from 'zod';
import { validateFunding } from './funding-plan';
import { walletAddress } from './wallet-workspace';

export class ExchangeFundingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const raw = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((v) => /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= (1n << 64n) - 1n);
const selection = z
  .object({
    planId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    revision: z.number().int().min(1).max(1e9),
    funderRevision: z.number().int().min(1).max(1e9),
    minimumPayoutLamports: raw,
  })
  .strict();
export type ExchangeFundingSelection = z.infer<typeof selection>;
export function exchangeFundingSelection(
  value: unknown,
): ExchangeFundingSelection {
  const parsed = selection.safeParse(value);
  if (!parsed.success)
    throw new ExchangeFundingError(
      'Choose a saved funding draft, current funder and exact payout amount.',
      400,
    );
  return parsed.data;
}
const decimal = (value: bigint) => {
  const digits = value.toString().padStart(10, '0');
  return digits.slice(0, -9) + '.' + digits.slice(-9);
};
function amount(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(value)
  )
    throw new ExchangeFundingError(
      'The exchange returned an invalid SOL amount.',
      502,
    );
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (n <= 0n || n > (1n << 64n) - 1n)
    throw new ExchangeFundingError(
      'The exchange returned an invalid SOL amount.',
      502,
    );
  return n;
}
type Row = {
  document: string;
  revision: number;
  archived: number;
  updatedAt: string;
  walletRevision: number;
  walletArchived: number;
};
/** Quote only. No provider order, deposit address, payment or funding permission. */
export async function previewOwnedExchangeFunding(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  options: {
    key?: string;
    enabled: boolean;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
) {
  const input = exchangeFundingSelection(value);
  if (!options.enabled || !options.key)
    throw new ExchangeFundingError(
      'Exchange funding quotes are not configured. Saved drafts remain available.',
      503,
    );
  const now = options.now ?? Date.now;
  const read = () =>
    db
      .prepare(`SELECT p.document,p.revision,p.archived,p.updated_at AS updatedAt,
    w.revision AS walletRevision,w.archived AS walletArchived
    FROM funding_plans p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana'
    AND w.address=json_extract(p.document,'$.funderAddress') WHERE p.owner_id=? AND p.id=?`)
      .bind(owner, input.planId)
      .first<Row>();
  const row = await read();
  if (!row)
    throw new ExchangeFundingError(
      'Owned funding draft and saved funder not found.',
      404,
    );
  if (
    row.archived ||
    row.walletArchived ||
    row.revision !== input.revision ||
    row.walletRevision !== input.funderRevision
  )
    throw new ExchangeFundingError(
      'Reload the active funding draft and funder before requesting a quote.',
    );
  const plan = validateFunding(JSON.parse(row.document));
  if (
    plan.source !== 'CEX' ||
    plan.chain !== 'Solana' ||
    plan.currency !== 'SOL' ||
    plan.assetAddress !== undefined ||
    plan.recipients.some((r) => r.proxies?.length)
  )
    throw new ExchangeFundingError(
      'Exchange funding currently quotes native SOL CEX drafts without proxy routes only.',
      400,
    );
  const funder = walletAddress(plan.funderAddress, 'Solana');
  if (funder === '11111111111111111111111111111111')
    throw new ExchangeFundingError('Choose a valid saved funder.', 400);
  const required = amount(plan.total),
    requested = BigInt(input.minimumPayoutLamports);
  if (requested < required)
    throw new ExchangeFundingError(
      'The payout must cover the saved distribution total. Network fees and retained reserves are additional.',
      400,
    );
  signal.throwIfAborted();
  // Dedicated shared queues. A denied or failed quote is not automatically retried.
  const claim = crypto.randomUUID(),
    claimedAt = now(),
    ownerScope = 'owner:' + owner;
  const gates = await db.batch([
    db
      .prepare(
        'INSERT INTO exchange_funding_quote_gates(scope,next_allowed_at,claim_id) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET next_allowed_at=excluded.next_allowed_at,claim_id=excluded.claim_id WHERE exchange_funding_quote_gates.next_allowed_at<=?',
      )
      .bind(ownerScope, claimedAt + 15000, claim, claimedAt),
    db
      .prepare(
        "INSERT INTO exchange_funding_quote_gates(scope,next_allowed_at,claim_id) SELECT 'provider:changenow',?,? WHERE EXISTS(SELECT 1 FROM exchange_funding_quote_gates WHERE scope=? AND claim_id=?) ON CONFLICT(scope) DO UPDATE SET next_allowed_at=excluded.next_allowed_at,claim_id=excluded.claim_id WHERE exchange_funding_quote_gates.next_allowed_at<=?",
      )
      .bind(claimedAt + 250, claim, ownerScope, claim, claimedAt),
  ]);
  if (gates.some((gate) => gate.meta.changes !== 1))
    throw new ExchangeFundingError(
      'Exchange quotes are busy. Wait before requesting another quote.',
      429,
    );
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      'https://api.changenow.io/v2/private-transfer/estimated-amount?' +
        new URLSearchParams({
          currency: 'sol',
          network: 'sol',
          toAmount: decimal(requested),
        }),
      {
        method: 'GET',
        headers: { 'x-changenow-api-key': options.key },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      },
    );
  } catch {
    throw new ExchangeFundingError(
      'Exchange quote unavailable. No provider order was created.',
      503,
    );
  }
  if (!response.ok)
    throw new ExchangeFundingError(
      response.status === 429
        ? 'Exchange quote rate limit reached. Wait before requesting another quote.'
        : 'Exchange quote unavailable. No provider order was created.',
      response.status === 429 ? 429 : 503,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ExchangeFundingError(
      'The exchange returned an unreadable quote.',
      502,
    );
  }
  const quote = z
    .object({
      currency: z.literal('sol'),
      network: z.literal('sol'),
      fromAmount: z.string(),
      toAmount: z.string(),
      validUntil: z.string(),
      rateId: z.string().min(1).max(4096),
      warningMessage: z.string().max(2000).nullish(),
    })
    .safeParse(body);
  if (!quote.success)
    throw new ExchangeFundingError(
      'The exchange quote did not match the selected asset and network.',
      502,
    );
  const deposit = amount(quote.data.fromAmount),
    payout = amount(quote.data.toAmount),
    expiry = Date.parse(quote.data.validUntil),
    checkedAt = now();
  if (
    payout !== requested ||
    deposit < payout ||
    !Number.isFinite(expiry) ||
    expiry <= checkedAt + 15000 ||
    expiry > checkedAt + 3600000
  )
    throw new ExchangeFundingError(
      'The exchange quote amount or expiry changed. Request a fresh quote.',
      502,
    );
  signal.throwIfAborted();
  const latest = await read();
  signal.throwIfAborted();
  if (!latest || JSON.stringify(latest) !== JSON.stringify(row))
    throw new ExchangeFundingError(
      'The funding draft or funder changed during the quote. Review it again.',
    );
  const completedAt = now();
  if (expiry <= completedAt + 15000)
    throw new ExchangeFundingError(
      'The exchange quote expired during review. Request a fresh quote.',
    );
  const id = crypto.randomUUID();
  const review = {
    format: 'exchange-funding-quote-v1' as const,
    provider: 'ChangeNOW' as const,
    id,
    planId: input.planId,
    revision: row.revision,
    planUpdatedAt: row.updatedAt,
    funderRevision: row.walletRevision,
    funder,
    network: 'solana-mainnet' as const,
    currency: 'SOL' as const,
    depositLamports: String(deposit),
    expectedPayoutLamports: String(payout),
    providerCostLamports: String(deposit - payout),
    distributionTotalLamports: String(required),
    undistributedPayoutLamports: String(payout - required),
    quotedAt: new Date(completedAt).toISOString(),
    expiresAt: new Date(expiry).toISOString(),
    warning:
      'The exchange processes your deposit and payout separately and may require verification. Network fees and distribution reserves are additional.',
    providerWarning: quote.data.warningMessage ?? null,
    durableReview: true as const,
    orderCreationAllowed: false as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const saved = await db
    .prepare(`INSERT INTO exchange_funding_quotes(id,owner_id,plan_id,plan_revision,funder_revision,plan_document,review,provider_reference,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM funding_plans p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=json_extract(p.document,'$.funderAddress')
    WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.document=? AND p.updated_at=? AND p.archived=0 AND w.revision=? AND w.archived=0)`)
    .bind(
      id,
      owner,
      input.planId,
      row.revision,
      row.walletRevision,
      row.document,
      JSON.stringify(review),
      quote.data.rateId,
      review.quotedAt,
      review.expiresAt,
      owner,
      input.planId,
      row.revision,
      row.document,
      row.updatedAt,
      row.walletRevision,
    )
    .run();
  if (saved.meta.changes !== 1)
    throw new ExchangeFundingError(
      'The funding draft or funder changed before the review was saved.',
    );
  return review;
}

/** Historical review only. Reloading never requests a quote or permits a deposit. */
export async function readOwnedExchangeFundingQuote(
  db: D1Database,
  owner: string,
  id: string,
) {
  if (!z.uuid().safeParse(id).success)
    throw new ExchangeFundingError(
      'Choose a valid exchange funding review.',
      400,
    );
  const row = await db
    .prepare(
      'SELECT review FROM exchange_funding_quotes WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{ review: string }>();
  if (!row)
    throw new ExchangeFundingError(
      'Owned exchange funding review not found.',
      404,
    );
  return JSON.parse(row.review) as Awaited<
    ReturnType<typeof previewOwnedExchangeFunding>
  >;
}
