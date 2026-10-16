import { afterEach, expect, it, vi } from 'vitest';
import { createPairReadRpc } from './pair-read-rpc';
import { collectPairAccountPartitions } from './pair-account-partitions';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import { PAIR_CLOCK } from './pair-stock-clock';
import { paceWalletRpc } from './wallet-rpc-pacing';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const endpoint = 'https://rpc.example.test/';
type Message = { id: string; method: string; params: unknown[] };
const pending: ReturnType<typeof createPairReadRpc>[] = [];
afterEach(() => {
  for (const reader of pending.splice(0)) reader.close();
  vi.clearAllMocks();
});
function requestBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw Error('Expected JSON');
  return init.body;
}
it('composes partition evidence with the real bounded transport and retains both wire Clocks per call', async () => {
  const now = 1792161668000,
    wire: Message[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(requestBody(init));
    const messages = (Array.isArray(body) ? body : [body]) as Message[];
    wire.push(...messages);
    const replies = messages.map((m) => ({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        context: { slot: 100 },
        value: (m.params[0] as string[]).map((key) =>
          key === PAIR_CLOCK
            ? pairQuoteClock(100, String(now / 1000))
            : { key },
        ),
      },
    }));
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  });
  const signal = new AbortController().signal;
  const reader = createPairReadRpc(
    endpoint,
    signal,
    fetcher as typeof fetch,
    'unsigned-stock-qualification',
    5,
  );
  pending.push(reader);
  const keys = Array.from(
    { length: 6 },
    (_, i) => '1'.repeat(31) + String(i + 1),
  );
  const result = await collectPairAccountPartitions(
    [...keys, PAIR_CLOCK],
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
    reader.rpc,
    signal,
    () => now,
  );
  expect(wire).toHaveLength(2);
  expect(
    wire.every(
      (m) =>
        (m.params[0] as string[]).length === 5 &&
        (m.params[0] as string[]).filter((k) => k === PAIR_CLOCK).length === 2,
    ),
  ).toBe(true);
  expect(result.providerResponses).toHaveLength(2);
  expect(result.observations.every((o) => o.slot === 100)).toBe(true);
  expect(
    vi
      .mocked(paceWalletRpc)
      .mock.calls.reduce((sum, call) => sum + Number(call[2]), 0),
  ).toBe(2);
});
