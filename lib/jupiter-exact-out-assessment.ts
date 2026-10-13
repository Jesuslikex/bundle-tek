import type { SwapInstructionReview } from './swap-instruction-review';
import { decodeJupiterExactOutRoute } from './jupiter-route-assessment';
import { walletAddress } from './wallet-workspace';
import schema from './jupiter-route-schema.json';

const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOURCE =
  'https://github.com/jup-ag/jupiter-cpi/blob/12bc5f67b94a2c3edc74d6e721a19442124a0bad/idl.json';
export type JupiterExactOutOrder = {
  swapMode: 'ExactOut';
  wallet: string;
  inputMint: string;
  outputMint: string;
  quotedInputRaw: string;
  outputTargetRaw: string;
  maximumInputRaw: string;
  reviewedInputBudgetRaw: string;
  slippageBps: number;
};
const amount = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid ExactOut amount.');
  return BigInt(value);
};

/** Inspect declared fields. This is deliberately separate from ExactIn signing. */
export function assessJupiterExactOutRoute(
  review: SwapInstructionReview,
  order: JupiterExactOutOrder,
) {
  let status: 'Matched fields' | 'Mismatch' | 'Unavailable' = 'Unavailable';
  let decoded: ReturnType<typeof decodeJupiterExactOutRoute> = null;
  let checks: Record<string, boolean> = {};
  const issues: string[] = [];
  try {
    const routes = review.instructions.filter(
      (i) => i.program.address === JUPITER,
    );
    if (routes.length !== 1) {
      issues.push('Exactly one resolved Jupiter call is required.');
    } else {
      const required = amount(order.quotedInputRaw),
        target = amount(order.outputTargetRaw),
        ceiling = amount(order.maximumInputRaw),
        budget = amount(order.reviewedInputBudgetRaw);
      for (const address of [order.wallet, order.inputMint, order.outputMint])
        walletAddress(address, 'Solana');
      if (order.inputMint === order.outputMint)
        throw new Error('Distinct mints required.');
      if (
        order.swapMode !== 'ExactOut' ||
        !Number.isSafeInteger(order.slippageBps) ||
        order.slippageBps < 0 ||
        order.slippageBps > 10000 ||
        ceiling < required ||
        ceiling > budget
      )
        throw new Error('Invalid ExactOut protection.');
      decoded = decodeJupiterExactOutRoute(routes[0].dataHex);
      if (!decoded)
        issues.push(
          'ExactOut instruction is outside the pinned shared v1 interface.',
        );
      else {
        const accounts = routes[0].accounts;
        if (accounts.length < 13) throw new Error('Missing ExactOut accounts.');
        if (
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].some(
            (i) => !accounts[i].address,
          )
        ) {
          issues.push('ExactOut accounts remain unresolved.');
        } else {
          for (const account of accounts)
            walletAddress(account.address, 'Solana');
          const reached = new Set([0]),
            outgoing = new Set<number>(),
            edges = new Map<number, number[]>();
          let graph = true;
          for (const step of decoded.steps) {
            if (!reached.has(step.inputIndex) || step.outputIndex === 0)
              graph = false;
            reached.add(step.outputIndex);
            outgoing.add(step.inputIndex);
            edges.set(step.inputIndex, [
              ...(edges.get(step.inputIndex) ?? []),
              step.outputIndex,
            ]);
          }
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
          const sinks = [...reached].filter((i) => !outgoing.has(i));
          graph =
            graph &&
            acyclic(0) &&
            sinks.length === 1 &&
            sinks[0] !== 0 &&
            decoded.steps
              .filter((s) => s.inputIndex === 0)
              .reduce((n, s) => n + s.bps, 0) === 10000;
          checks = {
            routeGraph: graph,
            quotedInput: decoded.quotedInputRaw === required.toString(),
            exactOutput: decoded.outputTargetRaw === target.toString(),
            slippage: decoded.slippageBps === order.slippageBps,
            maximumInput: BigInt(decoded.maximumInputUpperBoundRaw) <= ceiling,
            reviewedInputBudget:
              BigInt(decoded.maximumInputUpperBoundRaw) <= budget,
            walletAuthority:
              accounts[2].address === order.wallet && accounts[2].signer,
            sourceWritable: accounts[3].writable,
            destinationWritable: accounts[6].writable,
            inputMint: accounts[7].address === order.inputMint,
            outputMint: accounts[8].address === order.outputMint,
            tokenPrograms:
              accounts[0].address === TOKEN &&
              (accounts[10].address === TOKEN ||
                accounts[10].address === JUPITER),
            noPlatformFee: decoded.platformFeeBps === 0,
            programAccount: accounts[12].address === JUPITER,
          };
          status = Object.values(checks).every(Boolean)
            ? 'Matched fields'
            : 'Mismatch';
          for (const [name, matches] of Object.entries(checks))
            if (!matches)
              issues.push(`ExactOut ${name} differs from the selected review.`);
        }
      }
    }
  } catch {
    status = 'Mismatch';
    issues.push('Malformed ExactOut instruction or selected review.');
  }
  return {
    status,
    decoded,
    checks,
    issues,
    source: SOURCE,
    venueSchemaSource: schema.source,
    executionAllowed: false as const,
    instructionsVerified: false as const,
    limitations:
      'Shared v1 ExactOut declared fields only. Maximum input uses a conservative integer ceiling. Account ownership, mint extensions, invoked programs, SOL wrapping, fees and aggregate debits still require independent review and simulation. Matching fields do not authorize signing.',
  };
}
