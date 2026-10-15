// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { observePumpLaunchGroupRecovery } from '@/lib/pump-launch-group-recovery';
import { pumpHolderDigest } from '@/lib/pump-holder-review';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { PumpLaunchGroupReview } from './pump-launch-group-review';
import { pumpLaunchGroupReviewFixture } from '../../test/pump-launch-group-review-fixture';
let f: Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>;
let observation: Record<string, unknown>;
let root: Root,
  container: HTMLDivElement,
  fetcher: ReturnType<typeof vi.fn>,
  state: string;
const prepareRequest = vi.fn(() => ({
  projectId: f.review.projectId,
  holderLimits: f.review.allowances.holders,
}));
const response = () => ({
  format: 'pump-launch-group-review-v1',
  review: structuredClone(f.review),
  state,
  signedEvidence: null,
  durableReview: true,
  approvalRequired: !['approved', 'signed'].includes(state),
  signingAllowed: false,
  executionAllowed: false,
  completeLaunch: false,
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (item) =>
      item.textContent === text || item.getAttribute('aria-label') === text,
  )!;
async function settle() {
  for (
    let i = 0;
    i < 400 &&
    container.textContent?.includes('Checking complete launch group...');
    i++
  )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
  const observed = await observePumpLaunchGroupRecovery(
    f.review,
    null,
    new AbortController().signal,
    async (method) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getEpochInfo')
        return {
          absoluteSlot: (
            BigInt(f.review.input.create.lastValidBlockHeight) + 2000n
          ).toString(),
          blockHeight: f.review.input.create.lastValidBlockHeight,
        };
      throw new Error('Unexpected fixture RPC');
    },
  );
  observation = {
    id: crypto.randomUUID(),
    sourceState: 'approved',
    createdAt: observed.receipt.observedAt,
    sha256: await pumpHolderDigest(observed),
    ...observed,
  };
}, 30000);
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  state = 'review';
  prepareRequest.mockClear();
  fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.body) {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      if (body.action === 'cancel') state = 'cancelled';
      if (body.action === 'observe') return Response.json(observation);
      if (body.action === 'revalidate')
        return Response.json({
          reviewContextSha256: f.review.contextSha256,
          originalReviewExpiresAt: f.review.expiresAt,
          sourceRevalidated: true,
          signingAllowed: false,
          executionAllowed: false,
          simulationSha256: f.review.simulationSha256,
          checked: { simulation: f.review.simulation },
        });
      if (!['prepare', 'cancel'].includes(body.action))
        throw new Error('Unexpected transaction action');
      return Response.json(response());
    }
    if (path.includes('projectId='))
      return Response.json({ launches: [response()], nextCursor: null });
    if (path.includes('observations='))
      return Response.json({ observations: [observation], nextCursor: null });
    return Response.json(response());
  });
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PumpLaunchGroupReview
        projectId={f.review.projectId}
        contextKey="current"
        canPrepare
        prepareRequest={prepareRequest}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('automatically reads saved groups without a write, key unlock or approval control', () => {
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0][0]).toContain(
    'projectId=' + f.review.projectId + '&page=1',
  );
  expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  expect(container.querySelectorAll('input')).toHaveLength(0);
  expect(container.textContent).toContain(
    'Group signing and execution are unavailable',
  );
});
it('opens the full immutable review, lists every packet and every saved wallet limit, then explicitly discards unsigned state', async () => {
  await click('Open complete group: ' + f.review.id);
  expect(container.textContent).toContain(
    'Packet 1 of ' + f.review.packets.length,
  );
  expect(container.textContent).toContain(
    'Packet ' + f.review.packets.length + ' of ' + f.review.packets.length,
  );
  for (const wallet of f.review.allowances.holders)
    expect(container.textContent).toContain(wallet.address);
  expect(container.querySelectorAll('input')).toHaveLength(0);
  await click('Discard unsigned complete group');
  expect(container.textContent).toContain('Unsigned group discarded.');
  const writes = fetcher.mock.calls
    .filter(([, init]) => init?.body)
    .map(([, init]) =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    );
  expect(writes).toEqual([{ action: 'cancel', id: f.review.id }]);
});
it('prepares the entire supplied vector once and keeps original terms visible after a draft change', async () => {
  await click('Simulate complete launch group');
  expect(prepareRequest).toHaveBeenCalledTimes(1);
  const writes = fetcher.mock.calls
    .filter(([, init]) => init?.body)
    .map(([, init]) =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    );
  expect(writes).toEqual([
    { ...prepareRequest.mock.results[0].value, action: 'prepare' },
  ]);
  expect(writes[0].holderLimits).toHaveLength(18);
  await act(async () =>
    root.render(
      <PumpLaunchGroupReview
        projectId={f.review.projectId}
        contextKey="changed"
        canPrepare
        prepareRequest={prepareRequest}
      />,
    ),
  );
  expect(container.textContent).toContain('current draft or limits changed');
  expect(button('Simulate complete launch group').disabled).toBe(true);
});
it('keeps saved recovery access when new preparation is unavailable and never offers unsigned discard for approved groups', async () => {
  state = 'approved';
  await act(async () =>
    root.render(
      <PumpLaunchGroupReview
        projectId={f.review.projectId}
        contextKey="current"
        canPrepare={false}
        prepareRequest={prepareRequest}
      />,
    ),
  );
  await click('Reload saved groups');
  await click('Open complete group: ' + f.review.id);
  expect(button('Simulate complete launch group').disabled).toBe(true);
  expect(button('Check every packet status').disabled).toBe(false);
  expect(button('Discard unsigned complete group')).toBeUndefined();
  expect(fetcher.mock.calls.every(([, init]) => !init?.body)).toBe(true);
});
it('preserves a valid review on HTML and mismatched response failures without exposing parser text', async () => {
  await click('Open complete group: ' + f.review.id);
  fetcher.mockResolvedValue(
    new Response('<html>secret parser details</html>', { status: 503 }),
  );
  await click('Reload saved groups');
  expect(container.textContent).toContain('Packet 1 of');
  expect(container.textContent).toContain('service is unavailable');
  expect(container.textContent).not.toContain('secret parser details');
  fetcher.mockResolvedValue(
    Response.json({
      ...response(),
      review: { ...f.review, projectId: 'foreign' },
    }),
  );
  await click('Open complete group: ' + f.review.id);
  expect(container.textContent).toContain('Group check did not complete');
  expect(container.textContent).toContain('Packet 1 of');
});
it('aborts an in-flight read when its project is replaced and ignores a late old-project result', async () => {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementation(async (_path: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return Response.json(response());
  });
  act(() => button('Open complete group: ' + f.review.id).click());
  await act(async () =>
    root.render(
      <PumpLaunchGroupReview
        projectId="another-project"
        contextKey="other"
        canPrepare={false}
        prepareRequest={prepareRequest}
      />,
    ),
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => finish());
  expect(container.textContent).not.toContain('Packet 1 of');
});

it('checks all packet results, retains unresolved fee and reservation warnings and reloads saved observations without signing', async () => {
  state = 'approved';
  await click('Open complete group: ' + f.review.id);
  await click('Check every packet status');
  expect(container.textContent).toContain('Awaiting finalized packet results');
  expect(container.textContent).toContain('some fees remain unresolved');
  expect(container.textContent).toContain(
    'does not prove atomicity, settle balances or release reservations',
  );
  await click('Load saved group observations');
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('&observations=1');
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(
    fetcher.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
      ),
  ).toEqual([{ action: 'observe', id: f.review.id }]);
});
it('rechecks the original immutable sources and expiry without granting approval or execution', async () => {
  await click('Open complete group: ' + f.review.id);
  await click('Recheck complete group sources');
  expect(container.textContent).toContain(
    'Saved sources checked again. Signing and execution remain disabled.',
  );
  expect(
    fetcher.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
      ),
  ).toEqual([{ action: 'revalidate', id: f.review.id }]);
});
it.each([
  [409, 'could not accept this plan or saved state'],
  [429, 'Wait 5 seconds before repeating'],
  [401, 'Sign in again'],
] as const)(
  'explains HTTP %s without losing the saved complete review or exposing server text',
  async (status, message) => {
    await click('Open complete group: ' + f.review.id);
    fetcher.mockResolvedValue(
      new Response('<html>private fixture diagnostic</html>', { status }),
    );
    await click('Recheck complete group sources');
    expect(container.textContent).toContain(message);
    expect(container.textContent).toContain('Packet 1 of');
    expect(container.textContent).not.toContain('private fixture diagnostic');
  },
);
