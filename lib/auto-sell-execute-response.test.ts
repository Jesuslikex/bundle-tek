import { AutoSellReviewRecoveryError } from './auto-sell-review-recovery';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAutoSellExecutor,
  AutoSellUncertainError,
} from './auto-sell-execute';
import { autoSellOutcomeReference as ref } from '../test/auto-sell-outcome-fixture';
import type { VaultSession } from './browser-wallet-vault';
const SOL = 'So11111111111111111111111111111111111111112';
const session = { payload: { wallets: [] } } as unknown as VaultSession;
const response = (value: unknown, status = 200) =>
  Response.json(value, { status });
function fixture(
  intercept: (
    stage: string,
    normal: Response,
    signal: AbortSignal,
  ) => Promise<Response> | Response,
) {
  const stages: string[] = [];
  const entered = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  for (const stage of ['prepare', 'review', 'register', 'submit']) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    entered.set(stage, { promise, resolve });
  }
  const sign = vi.fn(async (_session, _review, assertCurrent: () => void) => {
    assertCurrent();
    return { signature: ref.signature, transaction: 'synthetic-signed' };
  });
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const stage = url.endsWith('/prepare') ? 'prepare' : String(body.action);
    stages.push(stage);
    entered.get(stage)!.resolve();
    const normal =
      stage === 'prepare'
        ? response({
            order: {
              side: 'Sell',
              inAmount: ref.inputRaw,
              inputMint: ref.mint,
              outputMint: SOL,
              preparation: {
                wallet: ref.wallet,
                transaction: 'synthetic',
                sha256: ref.preparationSha256,
              },
            },
            history: { id: ref.preparationId },
            simulation: { succeeded: true },
            reviewWaitMs: 0,
          })
        : stage === 'review'
          ? response({
              review: {
                id: ref.intentId,
                preparationId: ref.preparationId,
                wallet: ref.wallet,
                sha256: ref.preparationSha256,
                transaction: 'synthetic',
                inputRaw: ref.inputRaw,
                inputMint: ref.mint,
                outputMint: SOL,
                network: 'mainnet',
              },
            })
          : response({
              signature: ref.signature,
              state: stage === 'register' ? 'signed' : 'submitted',
            });
    return intercept(stage, normal, init.signal!);
  });
  const sell = createAutoSellExecutor({
    projectId: ref.projectId,
    projectRevision: ref.projectRevision,
    mint: ref.mint,
    decimals: 6,
    wallets: [
      { address: ref.wallet, revision: ref.walletRevision },
      { address: SOL, revision: 1 },
    ],
    session: () => session,
    fetcher: fetcher as unknown as typeof fetch,
    sleep: async () => {},
    sign,
  });
  return {
    sell,
    sign,
    fetcher,
    stages,
    entered: (stage: string) => entered.get(stage)!.promise,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([
  'awaiting_signature',
  'cancelled',
  'failed',
  'submitted',
  'finalized',
  null,
  undefined,
])(
  'keeps a signed outcome unresolved and never submits after registration state %s',
  async (state) => {
    const f = fixture((stage, normal) =>
      stage === 'register'
        ? response({ signature: ref.signature, state })
        : normal,
    );
    const error = await f
      .sell(BigInt(ref.inputRaw), new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual(ref);
    expect(f.stages).toEqual(['prepare', 'review', 'register']);
    expect(f.sign).toHaveBeenCalledOnce();
  },
);
it.each(['signed', 'failed', 'finalized', null, undefined])(
  'does not report success for an invalid submit state %s',
  async (state) => {
    const f = fixture((stage, normal) =>
      stage === 'submit'
        ? response({ signature: ref.signature, state })
        : normal,
    );
    const error = await f
      .sell(BigInt(ref.inputRaw), new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual(ref);
    expect(f.stages).toEqual(['prepare', 'review', 'register', 'submit']);
    expect(f.sign).toHaveBeenCalledOnce();
  },
);
it('limits streamed signed-step bodies and keeps the original uncertain reference', async () => {
  const cancel = vi.fn();
  const f = fixture((stage, normal) =>
    stage === 'register'
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"signature":"' +
                    ref.signature +
                    '","state":"signed","padding":"',
                ),
              );
              controller.enqueue(new Uint8Array(1048577).fill(32));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : normal,
  );
  const controller = new AbortController();
  const pending = f
    .sell(BigInt(ref.inputRaw), controller.signal)
    .catch((e) => e);
  const error = await pending;
  expect(cancel).toHaveBeenCalledOnce();
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(f.stages).toEqual(['prepare', 'review', 'register']);
});
it('refuses JSON served as HTML before signing', async () => {
  const f = fixture(async (stage, normal) =>
    stage === 'review'
      ? new Response(await normal.text(), {
          headers: { 'content-type': 'text/html' },
        })
      : normal,
  );
  await expect(
    f.sell(BigInt(ref.inputRaw), new AbortController().signal),
  ).rejects.toThrow();
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.stages).not.toContain('register');
});
it('enforces the complete-request deadline while the review body is stalled', async () => {
  const deadlines: AbortController[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  let release!: () => void;
  let cancelled = false;
  const f = fixture((stage, normal) =>
    stage === 'review'
      ? new Response(
          new ReadableStream({
            start(controller) {
              release = () => {
                void normal.text().then((text) => {
                  if (cancelled) return;
                  controller.enqueue(new TextEncoder().encode(text));
                  controller.close();
                });
              };
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : normal,
  );
  const pending = f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  await f.entered('review');
  expect(f.stages).toEqual(['prepare', 'review']);
  deadlines.at(-1)!.abort(new DOMException('Expired', 'TimeoutError'));
  release();
  const error = await pending;
  expect(error).toBeInstanceOf(Error);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.stages).not.toContain('register');
});

it('does no HTTP or signing work for an already stopped run', async () => {
  const f = fixture((_stage, normal) => normal);
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.sell(BigInt(ref.inputRaw), controller.signal),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
});
it('does not abort or repeat an already started submission when Stop is pressed', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  let submitSignal: AbortSignal | undefined;
  const f = fixture((stage, normal, signal) => {
    if (stage !== 'submit') return normal;
    submitSignal = signal;
    return new Promise<Response>((resolve) => {
      finish = () => resolve(normal);
    });
  });
  const pending = f.sell(BigInt(ref.inputRaw), controller.signal);
  await f.entered('submit');
  expect(submitSignal).toBeDefined();
  controller.abort();
  expect(submitSignal!.aborted).toBe(false);
  finish();
  const result = await pending;
  expect(result.signature).toBe(ref.signature);
  expect(f.stages).toEqual(['prepare', 'review', 'register', 'submit']);
});
it('keeps a submit-stage 429 uncertain without retry or another wallet', async () => {
  const f = fixture((stage, normal) =>
    stage === 'submit'
      ? response({ error: 'Rate limited', reviewWaitMs: 0 }, 429)
      : normal,
  );
  const error = await f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(f.stages).toEqual(['prepare', 'review', 'register', 'submit']);
});
it('cancels a stalled registration body on Stop and retains recovery metadata', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const f = fixture((stage, normal) =>
    stage === 'register'
      ? new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json' },
        })
      : normal,
  );
  const pending = f
    .sell(BigInt(ref.inputRaw), controller.signal)
    .catch((e) => e);
  await f.entered('register');
  expect(f.stages).toEqual(['prepare', 'review', 'register']);
  controller.abort();
  const error = await pending;
  expect(cancel).toHaveBeenCalledOnce();
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(f.stages).not.toContain('submit');
});
it('refuses malformed signed-step UTF-8 and retains the original signature', async () => {
  const f = fixture((stage, normal) =>
    stage === 'register'
      ? new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { 'content-type': 'application/json' },
        })
      : normal,
  );
  const error = await f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(error.message).not.toMatch(/Unexpected|JSON|position|character/);
  expect(f.stages).toEqual(['prepare', 'review', 'register']);
});

it.each(['register', 'submit'])(
  'refuses a mismatched signature at %s without another send or wallet',
  async (stage) => {
    const f = fixture((current, normal) =>
      current === stage
        ? response({
            signature: 'different',
            state: stage === 'register' ? 'signed' : 'submitted',
          })
        : normal,
    );
    const error = await f
      .sell(BigInt(ref.inputRaw), new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual(ref);
    expect(f.stages).toEqual(
      stage === 'register'
        ? ['prepare', 'review', 'register']
        : ['prepare', 'review', 'register', 'submit'],
    );
  },
);
it.each(['register', 'submit'])(
  'refuses a non-JSON signed-stage %s reply without raw HTML details',
  async (stage) => {
    const f = fixture((current, normal) =>
      current === stage
        ? new Response('<html>private diagnostic</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          })
        : normal,
    );
    const error = await f
      .sell(BigInt(ref.inputRaw), new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual(ref);
    expect(error.message).not.toContain('private diagnostic');
    expect(error.message).toContain('HTTP 502');
    expect(f.stages.filter((x) => x === stage)).toHaveLength(1);
    expect(f.stages.filter((x) => x === 'prepare')).toHaveLength(1);
  },
);
it('does not retry a submit502 that already records submitted state', async () => {
  const f = fixture((stage, normal) =>
    stage === 'submit'
      ? response(
          {
            signature: ref.signature,
            state: 'submitted',
            error: 'Outcome unknown',
          },
          502,
        )
      : normal,
  );
  const error = await f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(f.stages).toEqual(['prepare', 'review', 'register', 'submit']);
});
it('bounds a stalled submit body by its own deadline after Stop', async () => {
  const deadlines: AbortController[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    expect(ms).toBe(40000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const controller = new AbortController();
  const cancel = vi.fn();
  const f = fixture((stage, normal) =>
    stage === 'submit'
      ? new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json' },
        })
      : normal,
  );
  const pending = f
    .sell(BigInt(ref.inputRaw), controller.signal)
    .catch((e) => e);
  await f.entered('submit');
  controller.abort();
  expect(deadlines.at(-1)!.signal.aborted).toBe(false);
  deadlines.at(-1)!.abort(new DOMException('Expired', 'TimeoutError'));
  const error = await pending;
  expect(cancel).toHaveBeenCalledOnce();
  expect(error).toBeInstanceOf(AutoSellUncertainError);
  expect(error.outcome).toEqual(ref);
  expect(f.stages).toEqual(['prepare', 'review', 'register', 'submit']);
});

it.each(['network', 'invalid', '503'] as const)(
  'retains original pre-sign review after %s and never tries another wallet',
  async (kind) => {
    const f = fixture((stage, normal) => {
      if (stage !== 'review') return normal;
      if (kind === 'network') throw Error('private diagnostic');
      return kind === '503'
        ? response({ error: 'unavailable' }, 503)
        : response({ review: {} });
    });
    const error = await f
      .sell(BigInt(ref.inputRaw), new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellReviewRecoveryError);
    expect(error.reference).toMatchObject({
      preparationId: ref.preparationId,
      projectId: ref.projectId,
      inputRaw: ref.inputRaw,
      preparationSha256: ref.preparationSha256,
    });
    expect(error.message).not.toContain('private diagnostic');
    expect(f.stages).toEqual(['prepare', 'review']);
    expect(f.sign).not.toHaveBeenCalled();
  },
);
it('retains the existing review when local signing refuses without a returned packet', async () => {
  const f = fixture((_stage, normal) => normal);
  f.sign.mockRejectedValueOnce(Error('vault no longer available'));
  const error = await f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  expect(error).toBeInstanceOf(AutoSellReviewRecoveryError);
  expect(error.reference.preparationId).toBe(ref.preparationId);
  expect(f.stages).toEqual(['prepare', 'review']);
  expect(f.sign).toHaveBeenCalledOnce();
});

it('distinguishes a definite review409 from an unreadable saved-review outcome', async () => {
  const f = fixture((stage, normal) =>
    stage === 'review'
      ? response({ error: 'Recover existing approval' }, 409)
      : normal,
  );
  const error = await f
    .sell(BigInt(ref.inputRaw), new AbortController().signal)
    .catch((e) => e);
  expect(error).toBeInstanceOf(AutoSellReviewRecoveryError);
  expect(error.conflict).toBe(true);
  expect(f.stages).toEqual(['prepare', 'review']);
});
