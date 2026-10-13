import { expect, it, vi } from 'vitest';
import { quoteCounterBuyProposal } from './counter-buy-quote';
import { WRAPPED_SOL } from './warmup-swap-quote';
import type { CounterPlan } from './counter-trade-store';
import { counterBuyFixture as fixture } from '../test/counter-buy-fixture';
const quote = (fetcher: typeof fetch, budget = '1005', p = fixture()) =>
  quoteCounterBuyProposal(
    p.plan,
    p.identity,
    budget,
    'fixture-key',
    AbortSignal.timeout(1000),
    fetcher,
  );
it('requests the exact persisted token target and returns only a bounded wallet-free pricing preview', async () => {
  const p = fixture(),
    fetcher = vi.fn(async () => Response.json(p.response)),
    original = JSON.stringify(p.plan);
  const result = await quote(fetcher, '1005', p);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/swap/v1/quote');
  expect(url.searchParams.get('swapMode')).toBe('ExactOut');
  expect(url.searchParams.get('amount')).toBe(p.response.outAmount);
  expect(url.searchParams.has('taker')).toBe(false);
  expect(options.redirect).toBe('manual');
  expect(result.executionAllowed).toBe(false);
  expect(result.maximumSolInputRaw).toBe('1005');
  expect(result.outputTargetRaw).toBe(p.response.outAmount);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE-TRANSACTION|PRIVATE-REQUEST|fixture-key/,
  );
  expect(JSON.stringify(p.plan)).toBe(original);
});
it.each(['0', '-1', '1e3', '18446744073709551616'])(
  'rejects invalid reviewed swap budgets before a provider read: %s',
  async (budget) => {
    const f = vi.fn();
    await expect(quote(f, budget)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  },
);
it.each(['paused', 'ended'])(
  'rejects %s Counter proposals before a provider read',
  async (state) => {
    const p = fixture();
    p.plan.state = state as CounterPlan['state'];
    const f = vi.fn();
    await expect(quote(f, '1005', p)).rejects.toThrow(/active Counter Buy/);
    expect(f).not.toHaveBeenCalled();
  },
);
it('rejects missing proposals and altered persisted target accounting before quoting', async () => {
  const p = fixture(),
    f = vi.fn();
  await expect(
    quoteCounterBuyProposal(
      p.plan,
      'missing',
      '1005',
      'key',
      AbortSignal.timeout(1000),
      f,
    ),
  ).rejects.toThrow();
  p.plan.ledger.decisions[0].proposalTokenRaw = '999';
  await expect(quote(f, '1005', p)).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
});
it.each([
  { swapMode: 'ExactIn' },
  { outputMint: WRAPPED_SOL },
  { outAmount: '999' },
  { otherAmountThreshold: '999' },
  { otherAmountThreshold: '1006' },
  { slippageBps: 100 },
  { contextSlot: -1 },
  { routePlan: [] },
  { platformFee: { amount: '1', feeBps: 10 } },
  { inAmount: '18446744073709551616' },
])(
  'rejects a mismatched or insufficiently bounded provider response: %j',
  async (patch) => {
    const p = fixture();
    await expect(
      quote(async () => Response.json({ ...p.response, ...patch }), '1005', p),
    ).rejects.toThrow();
  },
);
it('rejects budget overrun even when the response remains inside provider slippage', async () => {
  const p = fixture();
  await expect(
    quote(async () => Response.json(p.response), '1004', p),
  ).rejects.toMatchObject({ code: 'OUTPUT_PROTECTION' });
});
it.each([302, 401, 429, 503])(
  'sanitizes provider HTTP %s without following redirects',
  async (status) => {
    await expect(
      quote(
        async () => new Response('PRIVATE-PROVIDER-DIAGNOSTIC', { status }),
      ),
    ).rejects.toThrow(expect.not.stringContaining('PRIVATE-PROVIDER'));
  },
);
it.each(['<html>PRIVATE-DIAGNOSTIC</html>', 'null', '[]'])(
  'sanitizes malformed quote documents: %s',
  async (body) => {
    await expect(quote(async () => new Response(body))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining('PRIVATE-DIAGNOSTIC'),
    });
  },
);
it('enforces a response-size bound', async () => {
  await expect(
    quote(async () => new Response('x'.repeat(262145))),
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('does not read a provider for an already cancelled request', async () => {
  const p = fixture(),
    c = new AbortController(),
    f = vi.fn();
  c.abort();
  await expect(
    quoteCounterBuyProposal(p.plan, p.identity, '1005', 'key', c.signal, f),
  ).rejects.toThrow(/cancelled/);
  expect(f).not.toHaveBeenCalled();
});
it('sanitizes network failures', async () => {
  await expect(
    quote(async () => {
      throw Error('PRIVATE-NETWORK-DETAIL');
    }),
  ).rejects.toMatchObject({
    message: expect.not.stringContaining('PRIVATE-NETWORK'),
  });
});
it('retains the reviewed snapshot when the callers in-memory plan changes during the provider read', async () => {
  const p = fixture(),
    original = structuredClone(p.plan);
  const result = await quote(
    async () => {
      p.plan.revision = 99;
      p.plan.projectId = '00000000-0000-4000-8000-000000000009';
      return Response.json(p.response);
    },
    '1005',
    p,
  );
  expect(result.planRevision).toBe(original.revision);
  expect(result.projectId).toBe(original.projectId);
  expect(result.outputTargetRaw).toBe(
    original.ledger.decisions[0].proposalTokenRaw,
  );
});
