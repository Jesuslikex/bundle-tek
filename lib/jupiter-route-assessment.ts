import schema from './jupiter-route-schema.json';
import type { SwapInstructionReview } from './swap-instruction-review';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const labels: Record<string, string> = {
  inputAmount: 'input amount',
  quotedOutput: 'quoted output',
  slippage: 'slippage limit',
  minimumOutput: 'minimum output protection',
  walletAuthority: 'wallet authority',
  sourceWritable: 'source account writability',
  destinationWritable: 'destination account writability',
  inputMint: 'input mint',
  outputMint: 'output mint',
  platformFee: 'quoted platform fee within the 50 basis point cap',
  noPositiveSlippageFee: 'zero positive slippage fee',
  tokenPrograms: 'standard token programs',
  tokenDestination: 'wallet token destination',
  routeGraph: 'connected acyclic trade graph',
};
type Order = Pick<
  SolanaSwapPreparation,
  | 'inputMint'
  | 'outputMint'
  | 'inAmount'
  | 'outAmount'
  | 'minimumOutAmount'
  | 'slippageBps'
> & {
  preparation: Pick<SolanaSwapPreparation['preparation'], 'wallet'>;
  platformFee?: { bps: number; mint: string };
};
export function decodeJupiterRoute(hex: string) {
  return decodeRouteLayout(hex, false);
}
/** Shared ExactOut v1 has output then quoted input in its trailer. */
export function decodeJupiterExactOutRoute(hex: string) {
  const value = decodeRouteLayout(hex, true);
  if (!value) return null;
  return {
    kind: 'sharedAccountsExactOutRoute' as const,
    id: value.id,
    outputTargetRaw: value.quotedOutRaw,
    quotedInputRaw: value.inAmountRaw,
    maximumInputUpperBoundRaw: (
      (BigInt(value.inAmountRaw) * BigInt(10000 + value.slippageBps) + 9999n) /
      10000n
    ).toString(),
    slippageBps: value.slippageBps,
    platformFeeBps: value.platformFeeBps,
    steps: value.steps,
  };
}
function decodeRouteLayout(hex: string, exactOut: boolean) {
  if (!/^(?:[0-9a-f]{2}){8,1232}$/.test(hex))
    throw new Error('Malformed route bytes.');
  if (exactOut && !hex.startsWith('b0d169a89a7d453e')) return null;
  const v2 =
    hex.startsWith('bb64facc31c4af14') || hex.startsWith('d19853937cfed8e9');
  const shared =
    exactOut ||
    hex.startsWith('c1209b3341d69c81') ||
    hex.startsWith('d19853937cfed8e9');
  if (!shared && !v2 && !hex.startsWith('e517cb977ae3ad2a')) return null;
  const bytes = Uint8Array.from(hex.match(/../g)!, (v) => parseInt(v, 16)),
    view = new DataView(bytes.buffer);
  let offset = 8;
  const read = (width: number) => {
    if (offset + width > bytes.length) throw new Error('Truncated route.');
    const start = offset;
    offset += width;
    return start;
  };
  const u8 = () => bytes[read(1)],
    u16 = () => view.getUint16(read(2), true),
    u32 = () => view.getUint32(read(4), true),
    u64 = () => view.getBigUint64(read(8), true);
  const id = shared ? u8() : null;
  const header = () => {
    const first = u64().toString(),
      second = u64().toString();
    return {
      inAmountRaw: exactOut ? second : first,
      quotedOutRaw: exactOut ? first : second,
      slippageBps: u16(),
      platformFeeBps: v2 ? u16() : u8(),
      positiveSlippageBps: v2 ? u16() : 0,
    };
  };
  const amounts = v2 ? header() : null;
  const count = u32();
  if (!count || count > 256) throw new Error('Invalid route step count.');
  const field = (type: string, depth = 0): unknown => {
    if (depth > 4) throw new Error('Nested route field exceeds the limit.');
    if (type === 'u8') return u8().toString();
    if (type === 'u16') return u16().toString();
    if (type === 'u32') return u32().toString();
    if (type === 'u64') return u64().toString();
    if (type === 'u128') {
      const low = u64(),
        high = u64();
      return (low + (high << 64n)).toString();
    }
    if (type === 'bool') {
      const value = u8();
      if (value > 1) throw new Error('Invalid route boolean.');
      return value.toString();
    }
    if (type.startsWith('Option')) {
      const tag = u8();
      if (tag > 1) throw new Error('Invalid route option.');
      return tag ? field(type.slice(6), depth + 1) : null;
    }
    if (type.startsWith('Array:')) {
      const [, element, length] = type.split(':');
      const count = Number(length);
      if (!Number.isSafeInteger(count) || count < 1 || count > 32)
        throw new Error('Invalid route array.');
      return Array.from({ length: count }, () => field(element, depth + 1));
    }
    if (type === 'RemainingAccountsInfo') {
      const count = u32();
      if (count > 32) throw new Error('Invalid remaining-account count.');
      return Array.from({ length: count }, () => {
        const type = u8(),
          length = u8();
        if (type > 8 || length === 0)
          throw new Error('Invalid remaining-account slice.');
        return { type, length };
      });
    }
    if (type === 'bytes') {
      const count = u32();
      if (count > 1024) throw new Error('Route bytes exceed the limit.');
      const start = read(count);
      return Array.from(bytes.slice(start, start + count));
    }
    if (type === 'VecCandidateSwap' || type === 'VecCandidateSwapWithBps') {
      const count = u32();
      if (count < 1 || count > 32) throw new Error('Invalid candidate count.');
      return Array.from({ length: count }, () => {
        const index = u8(),
          variant = schema.candidates[index];
        if (!variant) throw new Error('Unknown candidate layout.');
        const parameters = variant.fields.map((type) => field(type, depth + 1));
        const bps = type === 'VecCandidateSwapWithBps' ? u32() : null;
        if (bps !== null && (bps < 1 || bps > 10000))
          throw new Error('Invalid candidate weight.');
        return { venue: variant.name, parameters, bps };
      });
    }
    const count = (schema.enums as Record<string, number>)[type];
    if (count) {
      const value = u8();
      if (value >= count) throw new Error('Invalid route enum.');
      return value.toString();
    }
    throw new Error('Unsupported route field.');
  };
  const steps = [];
  for (let i = 0; i < count; i++) {
    const variant = schema.variants[u8()];
    if (!variant) return null;
    const parameters: Record<string, string> = {};
    for (let f = 0; f < variant.fields.length; f++) {
      const type = variant.fields[f];
      const value = field(type);
      parameters[String(f)] =
        typeof value === 'string' ? value : JSON.stringify(value);
    }
    const bps = v2 ? u16() : u8() * 100,
      percent = bps / 100,
      inputIndex = u8(),
      outputIndex = u8();
    if (bps < 1 || bps > 10000 || inputIndex === outputIndex)
      throw new Error('Invalid route step.');
    steps.push({
      venue: variant.name,
      parameters,
      percent,
      bps,
      inputIndex,
      outputIndex,
    });
  }
  const values = amounts ?? header();
  if (
    offset !== bytes.length ||
    values.slippageBps > 10000 ||
    values.platformFeeBps > 10000 ||
    values.positiveSlippageBps > 10000
  )
    throw new Error('Invalid route trailer.');
  return {
    kind: shared
      ? v2
        ? 'sharedAccountsRouteV2'
        : 'sharedAccountsRoute'
      : v2
        ? 'routeV2'
        : 'route',
    v2,
    shared,
    id,
    ...values,
    minimumOutLowerBoundRaw: (
      (BigInt(values.quotedOutRaw) * BigInt(10000 - values.slippageBps)) /
      10000n
    ).toString(),
    steps,
  };
}
export function assessJupiterRoute(
  review: SwapInstructionReview,
  order: Order,
) {
  const routes = review.instructions.filter(
    (i) => i.program.address === JUPITER,
  );
  let decoded:
    | (NonNullable<ReturnType<typeof decodeJupiterRoute>> & {
        authority: string;
        sourceAccount: string;
        destinationAccount: string;
        inputMint: string | null;
        outputMint: string;
      })
    | null = null;
  let status: 'Matched fields' | 'Mismatch' | 'Unavailable' = 'Unavailable';
  const issues: string[] = [];
  let checks: Record<string, boolean | null> = {};
  try {
    if (routes.length !== 1) {
      issues.push(
        routes.length
          ? 'Multiple Jupiter calls require aggregate route review.'
          : 'No resolved Jupiter route instruction.',
      );
    } else {
      for (const amount of [
        order.inAmount,
        order.outAmount,
        order.minimumOutAmount,
      ])
        if (
          !/^[1-9]\d{0,19}$/.test(amount) ||
          BigInt(amount) > (1n << 64n) - 1n
        )
          throw new Error('Invalid selected order amount.');
      if (
        !Number.isSafeInteger(order.slippageBps) ||
        order.slippageBps < 0 ||
        order.slippageBps > 10000
      )
        throw new Error('Invalid selected slippage.');
      const value = decodeJupiterRoute(routes[0].dataHex);
      if (!value)
        issues.push(
          'Route layout or venue variant is outside the pinned Jupiter interface.',
        );
      else {
        const accounts = routes[0].accounts;
        if (
          accounts.length <
          (value.v2 ? (value.shared ? 12 : 10) : value.shared ? 11 : 7)
        )
          throw new Error('Missing route accounts.');
        const authority =
            accounts[value.v2 ? (value.shared ? 1 : 0) : value.shared ? 2 : 1],
          source =
            accounts[value.v2 ? (value.shared ? 2 : 1) : value.shared ? 3 : 2],
          destination =
            accounts[value.v2 ? (value.shared ? 5 : 2) : value.shared ? 6 : 3];
        const outputIndex = value.v2
          ? value.shared
            ? 7
            : 4
          : value.shared
            ? 8
            : 5;
        const inputIndex = value.v2
          ? value.shared
            ? 6
            : 3
          : value.shared
            ? 7
            : null;
        const outputMint = accounts[outputIndex].address,
          inputMint = inputIndex === null ? null : accounts[inputIndex].address;
        if (
          [
            authority,
            source,
            destination,
            accounts[outputIndex],
            ...(inputIndex !== null ? [accounts[inputIndex]] : []),
          ].some((a) => !a.address)
        ) {
          issues.push('Required route accounts remain unresolved.');
        } else {
          decoded = {
            ...value,
            authority: authority.address,
            sourceAccount: source.address,
            destinationAccount: destination.address,
            inputMint,
            outputMint,
          };
          const reached = new Set([0]);
          const outgoing = new Set<number>();
          let graph = true;
          for (const step of value.steps) {
            if (!reached.has(step.inputIndex) || step.outputIndex === 0)
              graph = false;
            reached.add(step.outputIndex);
            outgoing.add(step.inputIndex);
          }
          const edges = new Map<number, number[]>();
          for (const step of value.steps)
            edges.set(step.inputIndex, [
              ...(edges.get(step.inputIndex) ?? []),
              step.outputIndex,
            ]);
          const visiting = new Set<number>(),
            visited = new Set<number>();
          const acyclic = (index: number): boolean => {
            if (visiting.has(index)) return false;
            if (visited.has(index)) return true;
            visiting.add(index);
            if ((edges.get(index) ?? []).some((next) => !acyclic(next)))
              return false;
            visiting.delete(index);
            visited.add(index);
            return true;
          };
          graph = graph && acyclic(0);
          const sinks = [...reached].filter((index) => !outgoing.has(index));
          graph =
            graph &&
            sinks.length === 1 &&
            sinks[0] !== 0 &&
            value.steps
              .filter((step) => step.inputIndex === 0)
              .reduce((sum, step) => sum + step.bps, 0) === 10000;
          checks = {
            routeGraph: graph,
            inputAmount: value.inAmountRaw === order.inAmount,
            quotedOutput: value.quotedOutRaw === order.outAmount,
            slippage: value.slippageBps === order.slippageBps,
            minimumOutput:
              BigInt(value.minimumOutLowerBoundRaw) >=
              BigInt(order.minimumOutAmount),
            walletAuthority:
              authority.address === order.preparation.wallet &&
              authority.signer,
            sourceWritable: source.writable,
            destinationWritable: destination.writable,
            inputMint:
              inputMint === null ? null : inputMint === order.inputMint,
            outputMint: outputMint === order.outputMint,
            platformFee:
              value.platformFeeBps === (order.platformFee?.bps ?? 0) &&
              value.platformFeeBps <= 50 &&
              (value.platformFeeBps === 0 ||
                [order.inputMint, order.outputMint].includes(
                  order.platformFee?.mint ?? '',
                )),
            noPositiveSlippageFee: value.positiveSlippageBps === 0,
            ...(value.v2
              ? {
                  tokenPrograms:
                    accounts[value.shared ? 8 : 5].address ===
                      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
                    accounts[value.shared ? 9 : 6].address ===
                      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  tokenDestination:
                    value.shared ||
                    accounts[7].address === JUPITER ||
                    accounts[7].address === destination.address,
                }
              : {}),
          };
          status = Object.values(checks).some((c) => c === false)
            ? 'Mismatch'
            : 'Matched fields';
          for (const [field, matches] of Object.entries(checks))
            if (matches === false)
              issues.push(
                `Declared ${labels[field]} does not match the selected order.`,
              );
        }
      }
    }
  } catch {
    status = 'Mismatch';
    issues.push('Malformed supported route instruction or selected order.');
  }
  return {
    status,
    checks,
    decoded,
    issues,
    source: schema.source,
    instructionsVerified: false as const,
    executionAllowed: false as const,
    limitations:
      'Pinned Jupiter exact-input route fields only. Minimum output is a conservative integer lower bound. Ordinary route instructions do not encode the source mint. Token account ownership, invoked programs, other instructions, fees and total debits remain unverified. Matching fields do not authorize signing.',
  };
}
export type JupiterRouteAssessment = ReturnType<typeof assessJupiterRoute>;
