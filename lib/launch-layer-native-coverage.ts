import { z } from 'zod';
import {
  parseLaunchLayerEnvelope,
  type LaunchLayerEnvelope,
} from './launch-layer-terms';
import { formatNativeBalance } from './wallet-balance-format';

const raw = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (value) =>
      /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= (1n << 64n) - 1n,
  );
const stamp = z
  .string()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const observation = z
  .object({
    raw,
    observedAt: stamp,
    snapshotId: z.uuid(),
    slot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    source: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:[\]_-]+$/),
    commitment: z.literal('confirmed'),
  })
  .strict();
const evidenceSchema = z
  .object({
    planId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    termsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: stamp,
    rows: z
      .array(
        z
          .object({
            address: z.string().min(32).max(44),
            observation: observation.nullable(),
            issue: z.enum(['missing', 'invalid']).nullable(),
          })
          .strict(),
      )
      .max(500),
    fundingAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
  })
  .strict();
export type LayerNativeEvidence = z.infer<typeof evidenceSchema>;
export function layerRoleMembers(envelope: LaunchLayerEnvelope) {
  const terms = parseLaunchLayerEnvelope(envelope).terms;
  return (
    ['funder', 'developer', 'front', 'back', 'temporary', 'holders'] as const
  ).flatMap((role) => {
    const value = terms.roles[role];
    const members = Array.isArray(value) ? value : value ? [value] : [];
    return members.map((member, index) => ({ role, index, member }));
  });
}
/** A retained public-address observation, never current custody or spendability. */
export function savedLayerSolObservation(
  document: unknown,
  address: string,
  blockNumber: number,
  checkedAt: string,
) {
  if (
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0 ||
    !stamp.safeParse(checkedAt).success
  )
    return null;
  const balance = z
    .object({
      chain: z.literal('Solana'),
      address: z.literal(address),
      raw,
      amount: z.string(),
      currency: z.literal('SOL'),
      decimals: z.literal(9),
      blockNumber: z.literal(blockNumber),
      blockHash: z.null(),
      observedAt: stamp,
      snapshotId: z.uuid(),
      source: observation.shape.source,
      commitment: z.literal('confirmed'),
    })
    .safeParse(document);
  if (
    !balance.success ||
    balance.data.amount !== formatNativeBalance(balance.data.raw, 9) ||
    Date.parse(balance.data.observedAt) > Date.parse(checkedAt)
  )
    return null;
  return observation.parse({
    raw: balance.data.raw,
    observedAt: balance.data.observedAt,
    snapshotId: balance.data.snapshotId,
    slot: balance.data.blockNumber,
    source: balance.data.source,
    commitment: balance.data.commitment,
  });
}
export function layerNativeComparison(
  value: unknown,
  binding: { id: string; sha256: string },
  envelope: LaunchLayerEnvelope,
) {
  const evidence = evidenceSchema.parse(value),
    terms = parseLaunchLayerEnvelope(envelope).terms;
  if (
    evidence.planId !== binding.id ||
    evidence.sha256 !== binding.sha256 ||
    evidence.termsSha256 !== envelope.sha256
  )
    throw Error(
      'Saved observation comparison belongs to a different planning snapshot.',
    );
  const members = layerRoleMembers(envelope);
  if (
    evidence.rows.length !== members.length ||
    new Set(evidence.rows.map((row) => row.address)).size !== members.length
  )
    throw Error('Saved observation comparison is incomplete.');
  const rows = members.map(({ role, index, member }, position) => {
    const row = evidence.rows[position];
    if (
      row.address !== member.wallet.address ||
      (row.observation === null) === (row.issue === null) ||
      (row.observation &&
        Date.parse(row.observation.observedAt) > Date.parse(evidence.checkedAt))
    )
      throw Error(
        'Saved observation comparison has inconsistent wallet evidence.',
      );
    const nativeBuyRaw =
      terms.quote.kind === 'native' ? member.maximumBuyQuoteRaw : '0';
    const ceiling =
      BigInt(nativeBuyRaw) +
      BigInt(member.maximumNetworkFeeLamports) +
      BigInt(member.maximumAccountRentLamports) +
      BigInt(member.retainedNativeReserveLamports);
    const difference = row.observation
      ? BigInt(row.observation.raw) - ceiling
      : null;
    return {
      role,
      index,
      address: member.wallet.address,
      buyQuoteRaw: member.maximumBuyQuoteRaw,
      nativeBuyRaw,
      feeRaw: member.maximumNetworkFeeLamports,
      rentRaw: member.maximumAccountRentLamports,
      reserveRaw: member.retainedNativeReserveLamports,
      ceilingRaw: String(ceiling),
      observation: row.observation,
      issue: row.issue,
      differenceRaw: difference === null ? null : String(difference),
    };
  });
  if (
    rows.reduce((sum, row) => sum + BigInt(row.ceilingRaw), 0n) !==
    BigInt(terms.totals.maximumNativeBudgetLamports)
  )
    throw Error('Declared native totals differ from their wallet ceilings.');
  const first = rows[0]?.observation;
  const snapshotKey = (value: NonNullable<typeof first>) =>
    JSON.stringify([
      value.snapshotId,
      value.slot,
      value.observedAt,
      value.source,
      value.commitment,
    ]);
  const sameSnapshot =
    !!first &&
    rows.every(
      (row) =>
        row.observation && snapshotKey(row.observation) === snapshotKey(first),
    );
  return {
    evidence,
    rows,
    sameSnapshot,
    observedTotalRaw: sameSnapshot
      ? String(
          rows.reduce((sum, row) => sum + BigInt(row.observation!.raw), 0n),
        )
      : null,
  };
}
