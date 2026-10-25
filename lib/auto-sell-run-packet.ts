import bs58 from 'bs58';
import type { SwapPreparationSummary } from './imported-swap-preparation-history';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';

export const AUTO_SELL_RUN_SUMMARY_MAX_BYTES = 32768;
const MAX_SUMMARY_UNITS = 8192;
const U64 = (1n << 64n) - 1n;
const SOL = 'So11111111111111111111111111111111111111112';
const HASH = /^[a-f0-9]{64}$/;
const fail = () =>
  Error(
    'The retained unsigned Auto Sell packet or original summary differs. No signing is enabled.',
  );
const topKeys = [
  'executionAllowed',
  'instructionsVerified',
  'chain',
  'side',
  'wallet',
  'inputMint',
  'outputMint',
  'inAmountRaw',
  'quotedOutRaw',
  'minimumOutRaw',
  'slippageBps',
  'router',
  'quoteSource',
  'quotedAt',
  'expiresAt',
  'transaction',
  'simulation',
  'balance',
  'limitations',
] as const;
function unicode(value: string) {
  for (const character of value) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff)
      throw fail();
  }
}
/** Detach every descriptor before hashing or awaiting packet decoding. */
function snapshot(
  value: unknown,
  depth = 0,
  budget = { units: MAX_SUMMARY_UNITS, nodes: 128 },
): unknown {
  if (depth > 3 || --budget.nodes < 0) throw fail();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw fail();
    return value;
  }
  if (typeof value === 'string') {
    unicode(value);
    budget.units -= value.length;
    if (budget.units < 0) throw fail();
    return value;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const names = Reflect.ownKeys(value);
  if (names.length > 32) throw fail();
  const copy: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      typeof name !== 'string' ||
      name === '__proto__' ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw fail();
    copy[name] = snapshot(descriptor.value, depth + 1, budget);
  }
  return copy;
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw fail();
  return row;
}
function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw fail();
  return value;
}
function raw(value: unknown, positive = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > U64 ||
    (positive && value === '0')
  )
    throw fail();
  return value;
}
function text(value: unknown, maximum = MAX_SUMMARY_UNITS) {
  if (typeof value !== 'string' || !value || value.length > maximum)
    throw fail();
  return value;
}
function date(value: unknown) {
  const result = text(value, 24);
  if (
    result.length !== 24 ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw fail();
}
function address(value: unknown) {
  const result = text(value, 44);
  try {
    const bytes = bs58.decode(result);
    if (bytes.length !== 32 || bs58.encode(bytes) !== result) throw fail();
  } catch {
    throw fail();
  }
  return result;
}
function triState(value: unknown) {
  if (value !== null && typeof value !== 'boolean') throw fail();
}

/** Historical structure only. Successful simulation or current eligibility is
 * deliberately not required or inferred by this descriptor-safe reader. */
export function readAutoSellRunPacketSummary(
  value: unknown,
): SwapPreparationSummary {
  const copy = snapshot(value);
  const row = object(copy, topKeys, ['platformFee']);
  if (
    row.executionAllowed !== false ||
    row.instructionsVerified !== false ||
    row.chain !== 'Solana' ||
    row.side !== 'Sell' ||
    row.router !== 'metis'
  )
    throw fail();
  address(row.wallet);
  if (address(row.inputMint) === SOL || address(row.outputMint) !== SOL)
    throw fail();
  raw(row.inAmountRaw, true);
  raw(row.quotedOutRaw, true);
  raw(row.minimumOutRaw, true);
  if (BigInt(row.minimumOutRaw as string) > BigInt(row.quotedOutRaw as string))
    throw fail();
  integer(row.slippageBps, 1, 50);
  text(row.quoteSource);
  text(row.limitations);
  date(row.quotedAt);
  date(row.expiresAt);
  if (row.platformFee !== undefined) {
    const fee = object(row.platformFee, ['bps', 'mint']);
    // Match the quote's metadata shape, not the separate signing fee policy.
    integer(fee.bps, 0, 10000);
    if (![row.inputMint, row.outputMint].includes(address(fee.mint)))
      throw fail();
  }
  const transaction = object(row.transaction, [
    'sha256',
    'bytes',
    'instructionCount',
    'lookupTableCount',
    'lastValidBlockHeight',
    'estimatedFeesLamports',
  ]);
  if (typeof transaction.sha256 !== 'string' || !HASH.test(transaction.sha256))
    throw fail();
  integer(transaction.bytes, 1, 1232);
  integer(transaction.instructionCount, 1, 1232);
  integer(transaction.lookupTableCount, 0, 256);
  raw(transaction.lastValidBlockHeight, true);
  raw(transaction.estimatedFeesLamports);
  const balance = object(
    row.balance,
    ['source', 'observedAt', 'requestedRaw', 'amountCovered'],
    ['nativeSlot'],
  );
  text(balance.source);
  date(balance.observedAt);
  raw(balance.requestedRaw, true);
  if (
    balance.requestedRaw !== row.inAmountRaw ||
    typeof balance.amountCovered !== 'boolean'
  )
    throw fail();
  if (balance.nativeSlot !== undefined) integer(balance.nativeSlot);
  const simulation = object(row.simulation, [
    'succeeded',
    'source',
    'observedAt',
    'feeSlot',
    'simulationSlot',
    'networkFeeLamports',
    'unitsConsumed',
    'nativeChangeRaw',
    'tokensComplete',
    'inputAmountMatches',
    'minimumOutputCovered',
    'routeStatus',
    'bindingStatus',
    'authorityActionCount',
    'unrecognizedInstructionCount',
    'unresolvedAccountCount',
  ]);
  if (
    typeof simulation.succeeded !== 'boolean' ||
    typeof simulation.tokensComplete !== 'boolean'
  )
    throw fail();
  text(simulation.source);
  date(simulation.observedAt);
  integer(simulation.feeSlot);
  integer(simulation.simulationSlot);
  raw(simulation.networkFeeLamports);
  if (simulation.unitsConsumed !== null) raw(simulation.unitsConsumed);
  if (simulation.nativeChangeRaw !== null) {
    const delta = text(simulation.nativeChangeRaw, 21);
    if (
      !/^-?(0|[1-9]\d{0,19})$/.test(delta) ||
      BigInt(delta).toString() !== delta ||
      BigInt(delta) < -U64 ||
      BigInt(delta) > U64
    )
      throw fail();
  }
  triState(simulation.inputAmountMatches);
  triState(simulation.minimumOutputCovered);
  if (
    typeof simulation.routeStatus !== 'string' ||
    typeof simulation.bindingStatus !== 'string' ||
    !['Matched fields', 'Mismatch', 'Unavailable'].includes(
      simulation.routeStatus,
    ) ||
    !['Matched bindings', 'Mismatch', 'Unavailable'].includes(
      simulation.bindingStatus,
    )
  )
    throw fail();
  for (const field of [
    'authorityActionCount',
    'unrecognizedInstructionCount',
    'unresolvedAccountCount',
  ])
    if (simulation[field] !== null) integer(simulation[field]);
  const encoded = JSON.stringify(copy);
  if (
    encoded.length > MAX_SUMMARY_UNITS ||
    new TextEncoder().encode(encoded).byteLength >
      AUTO_SELL_RUN_SUMMARY_MAX_BYTES
  )
    throw fail();
  return copy as SwapPreparationSummary;
}

/** Bind exact bytes from the original JSON.stringify writer, without rewriting
 * whitespace, keys or escapes into a different historical document. */
export async function autoSellRunSummarySha256(rawOriginalSummaryText: string) {
  if (
    typeof rawOriginalSummaryText !== 'string' ||
    !rawOriginalSummaryText ||
    rawOriginalSummaryText.length > MAX_SUMMARY_UNITS
  )
    throw fail();
  unicode(rawOriginalSummaryText);
  if (
    new TextEncoder().encode(rawOriginalSummaryText).byteLength >
    AUTO_SELL_RUN_SUMMARY_MAX_BYTES
  )
    throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOriginalSummaryText);
  } catch {
    throw fail();
  }
  const summary = readAutoSellRunPacketSummary(parsed);
  if (JSON.stringify(summary) !== rawOriginalSummaryText) throw fail();
  const bytes = new TextEncoder().encode(
    JSON.stringify(['auto-sell-run-summary-v1', rawOriginalSummaryText]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
}

/** Envelope identity only. This accepts historical expiry and grants no route,
 * lifetime, custody, simulation, signing or execution authority. */
export async function validateAutoSellRunPacket(
  transaction: unknown,
  summary: SwapPreparationSummary,
) {
  const captured = readAutoSellRunPacketSummary(summary);
  let packet;
  try {
    packet = await reviewUnsignedSwapEnvelope(transaction, captured.wallet);
  } catch {
    throw fail();
  }
  if (
    packet.sha256 !== captured.transaction.sha256 ||
    packet.transactionBytes !== captured.transaction.bytes ||
    packet.instructionCount !== captured.transaction.instructionCount ||
    packet.lookupTableCount !== captured.transaction.lookupTableCount
  )
    throw fail();
  return { transaction: packet.transaction, sha256: packet.sha256 };
}
