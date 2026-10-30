import { afterEach, expect, it, vi } from 'vitest';
import { probeJitoCpmmLiveFrames } from './jito-cpmm-live-frame-probe';
vi.mock('./wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
afterEach(() => vi.unstubAllGlobals());
function input() {
  const b = Buffer.alloc(66);
  b[0] = 1;
  return {
    transactions: [b.toString('base64')],
    addresses: ['11111111111111111111111111111111'],
    minimumSlot: 100,
    simulationSlot: 101,
  };
}
function response(id: string, kind = 'ok') {
  const a = {
    owner: '11111111111111111111111111111111',
    executable: false,
    lamports: 1,
    data: ['', 'base64'],
  };
  return {
    jsonrpc: '2.0',
    id,
    result: {
      context: { slot: kind === 'wrong-slot' ? 102 : 101 },
      value: {
        summary: 'succeeded',
        transactionResults: [
          {
            err: null,
            fee: 5000,
            replacementBlockhash: null,
            preExecutionAccounts: [a],
            postExecutionAccounts: kind === 'missing-post' ? [] : [a],
          },
        ],
      },
    },
  };
}
it('observes complete requested vectors without granting frame or bank qualification', async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const q = JSON.parse(String(init?.body));
    expect(q.method).toBe('simulateBundle');
    expect(q.params[1]).toMatchObject({
      simulationBank: { slot: 101 },
      skipSigVerify: true,
      replaceRecentBlockhash: false,
    });
    expect(q.params[1]).not.toHaveProperty('stateOverrides');
    return new Response(JSON.stringify(response(q.id)));
  });
  vi.stubGlobal('fetch', fetcher);
  const r = await probeJitoCpmmLiveFrames(
    input(),
    new AbortController().signal,
  );
  expect(r.summary).toMatchObject({
    status: 'complete-requested-vectors-observed',
    bankVerified: false,
    feeBankVerified: false,
    fullSwapQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(r.summary.observations.frames).toEqual([
    {
      preCount: 1,
      postCount: 1,
      feePresent: true,
      replacementBlockhashPresent: true,
      error: null,
    },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(r.captures).toHaveLength(1);
});
it.each(['wrong-slot', 'missing-post'])(
  'refuses %s instead of substituting accounts or bank',
  async (kind) => {
    const fetcher = vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify(response(JSON.parse(String(init?.body)).id, kind)),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await probeJitoCpmmLiveFrames(input(), new AbortController().signal))
        .summary.status,
    ).toBe('refused');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('retains exact bank unavailability without tip fallback or retry', async () => {
  const fetcher = vi.fn(
    async (_url, init) =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: JSON.parse(String(init?.body)).id,
          error: {
            code: -32602,
            message: 'bank not found for the provided slot: 101',
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const r = await probeJitoCpmmLiveFrames(
    input(),
    new AbortController().signal,
  );
  expect(r.summary.observations.refusal).toBe('bank-unavailable');
  expect(r.summary.status).toBe('refused');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('stops on 429', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const r = await probeJitoCpmmLiveFrames(
    input(),
    new AbortController().signal,
  );
  expect(r.summary.transport?.rateLimited).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['signed', 'too-many', 'duplicate-address', 'old-slot'])(
  'refuses invalid %s scope before I/O',
  async (kind) => {
    const f = input(),
      fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    if (kind === 'signed') {
      const b = Buffer.from(f.transactions[0], 'base64');
      b[1] = 1;
      f.transactions[0] = b.toString('base64');
    }
    if (kind === 'too-many') f.transactions = Array(6).fill(f.transactions[0]);
    if (kind === 'duplicate-address') f.addresses.push(f.addresses[0]);
    if (kind === 'old-slot') f.simulationSlot = 133;
    expect(
      (await probeJitoCpmmLiveFrames(f, new AbortController().signal)).summary
        .status,
    ).toBe('refused');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
