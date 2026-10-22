import { z } from 'zod';
import bs58 from 'bs58';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import type { BubbleFunder } from './bubble-map';

const address = z
  .string()
  .max(44)
  .refine((v) => {
    try {
      return bs58.decode(v).length === 32;
    } catch {
      return false;
    }
  });
const funding = z
  .object({
    funder: address,
    signature: z
      .string()
      .max(90)
      .refine((v) => {
        try {
          return bs58.decode(v).length === 64;
        } catch {
          return false;
        }
      }),
    slot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    blockTime: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
  })
  .strict();
const lookup = z.union([
  z.object({ funder: funding }).strict(),
  z
    .object({
      funder: z.null(),
      reason: z.enum([
        'history-too-long',
        'history-unavailable',
        'funding-unavailable',
      ]),
    })
    .strict(),
]);
const responseSchema = z
  .object({ network: z.literal('mainnet'), funders: z.record(address, lookup) })
  .strict();
export type BubbleLookup = z.infer<typeof lookup>;
export type BubbleReadProgress = {
  completed: number;
  total: number;
  group: number;
  groups: number;
  phase: 'reading' | 'waiting' | 'complete';
};
export const isBubbleMapAddress = (value: unknown) =>
  address.safeParse(value).success;
export class BubbleMapReadError extends Error {
  constructor(
    readonly code: 'rate-limited' | 'unavailable',
    completed = 0,
    total = 0,
  ) {
    const message =
      code === 'rate-limited'
        ? 'Funding reads are cooling down. Wait at least 10 seconds before a new check. No automatic retry was made.'
        : 'Funding links could not be checked. Wait at least 10 seconds and refresh the holder data before a new check.';
    super(
      message +
        (completed
          ? ` ${completed} of ${total} wallets were read before stopping. No partial map was kept. A new check reads all selected wallets again.`
          : ''),
    );
  }
}
export const bubbleUnknownReason = (row: BubbleLookup) =>
  row.funder
    ? ''
    : {
        'history-too-long': 'History exceeds this bounded lookup.',
        'history-unavailable': 'No history was returned by the provider.',
        'funding-unavailable':
          'Oldest funding evidence is missing, unsupported or ambiguous.',
      }[row.reason];
export function decodeBubbleMapResponse(value: unknown, addresses: string[]) {
  const result = responseSchema.parse(value);
  if (
    Object.keys(result.funders).length !== addresses.length ||
    addresses.some((a) => !Object.hasOwn(result.funders, a))
  )
    throw new BubbleMapReadError('unavailable');
  // Server validates evidence time. A local device clock is not authority.
  return result.funders;
}
function waitForGate(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 10000);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
/** One explicit, finite read. No retries; at most two groups for 32 addresses. */
export async function readBubbleMapFunding(
  addresses: string[],
  signal: AbortSignal,
  progress: (value: BubbleReadProgress) => void,
) {
  const selection = z.array(address).min(1).max(32).parse(addresses);
  if (new Set(selection).size !== selection.length)
    throw new BubbleMapReadError('unavailable');
  const out: Record<string, BubbleLookup> = {};
  const groups = Math.ceil(selection.length / 20);
  try {
    for (let start = 0; start < selection.length; start += 20) {
      const group = start / 20 + 1;
      signal.throwIfAborted();
      if (start) {
        progress({
          completed: start,
          total: selection.length,
          group,
          groups,
          phase: 'waiting',
        });
        // Wait after the prior response, so its server admission precedes this gap.
        await waitForGate(signal);
      }
      signal.throwIfAborted();
      progress({
        completed: start,
        total: selection.length,
        group,
        groups,
        phase: 'reading',
      });
      signal.throwIfAborted();
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(60000),
      ]);
      const response = await fetch('/api/supply/bubble-map', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addresses: selection.slice(start, start + 20) }),
        cache: 'no-store',
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new BubbleMapReadError(
          response.status === 429 ? 'rate-limited' : 'unavailable',
        );
      }
      const value = await readBoundedPanelJson(response, requestSignal);
      requestSignal.throwIfAborted();
      Object.assign(
        out,
        decodeBubbleMapResponse(value, selection.slice(start, start + 20)),
      );
    }
    signal.throwIfAborted();
    progress({
      completed: selection.length,
      total: selection.length,
      group: groups,
      groups,
      phase: 'complete',
    });
    return out;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new BubbleMapReadError(
      error instanceof BubbleMapReadError ? error.code : 'unavailable',
      Object.keys(out).length,
      selection.length,
    );
  }
}
export function bubbleFunders(
  rows: Record<string, BubbleLookup>,
): Record<string, BubbleFunder | null> {
  return Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [key, row.funder]),
  );
}
