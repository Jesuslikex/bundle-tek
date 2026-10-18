// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { ExchangeOrderHistory } from './exchange-order-history';
import { exchangeOrderHistoryFixture } from '@/test/exchange-order-history-fixture';
let root: Root,
  container: HTMLDivElement,
  fixture: ReturnType<typeof exchangeOrderHistoryFixture>;
const fetcher = vi.fn<typeof fetch>();
const requestUrl = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
const button = (text: string) => {
  const b = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  if (!b) throw new Error('Missing ' + text);
  return b;
};
const click = async (text: string) => {
  await act(async () => button(text).click());
};
async function mount(planId = fixture.plan.id) {
  await act(async () => root.render(<ExchangeOrderHistory planId={planId} />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = exchangeOrderHistoryFixture();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher
    .mockReset()
    .mockImplementation(async (input) =>
      requestUrl(input).includes('?id=')
        ? Response.json({ order: fixture.detail })
        : Response.json(fixture.page),
    );
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('reads only on explicit open and explains that a saved quote is not an order', async () => {
  fixture.page.items = [];
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('View saved exchange orders');
  expect(container.textContent).toContain(
    'Getting a quote does not create an order',
  );
  expect(
    fetcher.mock.calls.every(
      ([, init]) => init?.method === undefined && init?.cache === 'no-store',
    ),
  ).toBe(true);
});
it('opens exact historical wallets and amounts with all payment controls absent', async () => {
  await mount();
  await click('View saved exchange orders');
  await click('Open order 00000000');
  expect(container.textContent).toContain('Review saved');
  expect(container.textContent).toContain(fixture.funder.address);
  expect(container.textContent).toContain(fixture.detail.refundAddress);
  expect(container.textContent).toContain('1.15 SOL');
  expect(container.textContent).toContain('1.1 SOL');
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(
    [...container.querySelectorAll('button')].some((b) =>
      /sign|send|deposit|distribute/i.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('keeps an uncertain order held without offering another attempt', async () => {
  fetcher.mockImplementation(async (input) =>
    requestUrl(input).includes('?id=')
      ? Response.json({
          order: {
            ...fixture.detail,
            state: 'creation-unresolved',
            approved: true,
            approvalExpiresAt: fixture.review.expiresAt,
            providerReferenceRetained: true,
          },
        })
      : Response.json(fixture.page),
  );
  await mount();
  await click('View saved exchange orders');
  await click('Open order 00000000');
  expect(container.textContent).toContain('Its hold remains in place');
  expect(container.textContent).toContain('does not authorize a new order');
});
it('keeps HTML/storage failures out of user-facing text and permits explicit reload', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>parser secret</html>', { status: 503 }),
  );
  await mount();
  await click('View saved exchange orders');
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Reload to try again',
  );
  expect(container.textContent).not.toContain('parser secret');
  fetcher.mockResolvedValue(Response.json(fixture.page));
  await click('Reload saved orders');
  expect(container.querySelector('[role=alert]')).toBeNull();
});
it('refuses changed authority or cross-plan detail instead of displaying it', async () => {
  fetcher.mockImplementation(async (input) =>
    requestUrl(input).includes('?id=')
      ? Response.json({
          order: {
            ...fixture.detail,
            quote: { ...fixture.review, planId: 'other' },
            fundingAllowed: true,
          },
        })
      : Response.json(fixture.page),
  );
  await mount();
  await click('View saved exchange orders');
  await click('Open order 00000000');
  expect(
    container.querySelector('[aria-label="Saved exchange order details"]'),
  ).toBeNull();
  expect(container.querySelector('[role=alert]')).not.toBeNull();
});
it('aborts old-plan reads and ignores a late response after context replacement', async () => {
  let resolve!: (v: Response) => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementation((_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((r) => {
      resolve = r;
    });
  });
  await mount();
  await click('View saved exchange orders');
  await mount('other-plan');
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json(fixture.page)));
  expect(container.textContent).not.toContain('1.1 SOL expected');
  expect(button('View saved exchange orders')).not.toBeNull();
});
it('retains earlier rows when loading a later page and clears private history on sign-out', async () => {
  const first = { ...fixture.page, nextCursor: fixture.id };
  const older = {
    ...fixture.page,
    items: [
      { ...fixture.page.items[0], id: '00000000-0000-4000-8000-000000000003' },
    ],
  };
  fetcher.mockImplementation(async (input) =>
    requestUrl(input).includes('&before=')
      ? Response.json(older)
      : Response.json(first),
  );
  await mount();
  await click('View saved exchange orders');
  await click('Load older exchange orders');
  expect(container.querySelectorAll('li')).toHaveLength(2);
  fetcher.mockResolvedValue(new Response('unauthorized', { status: 401 }));
  await click('Reload saved orders');
  expect(container.querySelectorAll('li')).toHaveLength(0);
  expect(container.textContent).toContain(
    'Sign in to read saved exchange orders.',
  );
});
it('shows a verified receipt as historical credit without treating it as spendable balance', async () => {
  const signature = bs58.encode(new Uint8Array(64).fill(4));
  fetcher.mockImplementation(async (input) =>
    requestUrl(input).includes('?id=')
      ? Response.json({
          order: {
            ...fixture.detail,
            state: 'payout-verified',
            approved: true,
            approvalExpiresAt: fixture.review.expiresAt,
            providerStatus: 'finished',
            providerReferenceRetained: true,
            payoutVerified: true,
            payout: {
              signature,
              recipient: fixture.funder.address,
              amountRaw: fixture.review.expectedPayoutLamports,
              slot: 120,
              observedAt: fixture.review.quotedAt,
            },
          },
        })
      : Response.json(fixture.page),
  );
  await mount();
  await click('View saved exchange orders');
  await click('Open order 00000000');
  expect(container.textContent).toContain('Finalized SOL payout verified');
  expect(container.textContent).toContain(
    'Current spendable balance has not been checked',
  );
  expect(container.querySelector('a')?.href).toBe(
    'https://solscan.io/tx/' + signature,
  );
  expect(
    fetcher.mock.calls.every(([, init]) => init?.method === undefined),
  ).toBe(true);
});

function pendingPayout() {
  return {
    ...fixture.detail,
    state: 'payout-unverified' as const,
    approved: true,
    approvalExpiresAt: fixture.review.expiresAt,
    providerStatus: 'finished' as const,
    providerReferenceRetained: true,
  };
}
function verifiedPayout() {
  return {
    ...pendingPayout(),
    state: 'payout-verified' as const,
    payoutVerified: true,
    payout: {
      signature: bs58.encode(new Uint8Array(64).fill(4)),
      recipient: fixture.funder.address,
      amountRaw: fixture.review.expectedPayoutLamports,
      slot: 120,
      observedAt: fixture.review.quotedAt,
    },
  };
}
async function openPayout() {
  fetcher.mockImplementation(async (input) =>
    requestUrl(input).includes('?id=')
      ? Response.json({ order: pendingPayout() })
      : Response.json(fixture.page),
  );
  await mount();
  await click('View saved exchange orders');
  await click('Open order 00000000');
}
it('verifies only the exact selected saved order, updates its row and keeps every authority disabled', async () => {
  await openPayout();
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(
    true,
  );
  fetcher.mockResolvedValueOnce(Response.json({ order: verifiedPayout() }));
  await click('Verify finalized payout');
  const [url, init] = fetcher.mock.calls.at(-1)!;
  expect(url).toBe('/api/funding/exchange-payout');
  expect(init).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
  });
  expect(JSON.parse(init?.body as string)).toEqual({
    id: fixture.id,
    sha256: fixture.detail.sha256,
  });
  expect(container.textContent).toContain('Finalized SOL payout verified');
  expect(container.textContent).toContain(
    'Payout receipt saved; open to read verified details',
  );
  expect(container.textContent).toContain(
    'Current spendable balance has not been checked',
  );
  expect(container.querySelector('input')).toBeNull();
});
it.each([429, 409, 503])(
  'shows bounded recovery for status%s without exposing provider or HTML diagnostics or retrying',
  async (status) => {
    await openPayout();
    fetcher.mockResolvedValueOnce(
      new Response('<html>private provider URL and key</html>', { status }),
    );
    await click('Verify finalized payout');
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    expect(container.textContent).not.toContain('private provider');
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect(button('Reload this saved order').disabled).toBe(false);
    if (status === 429) expect(container.textContent).toContain('15 seconds');
  },
);
it('clears private history when payout verification returns401', async () => {
  await openPayout();
  fetcher.mockResolvedValueOnce(new Response('', { status: 401 }));
  await click('Verify finalized payout');
  expect(container.querySelectorAll('li')).toHaveLength(0);
  expect(container.textContent).not.toContain(fixture.funder.address);
  expect(container.textContent).toContain('Sign in to verify');
});
it('refuses changed digest, unexpected authority and an unverified success response', async () => {
  for (const order of [
    { ...verifiedPayout(), sha256: 'b'.repeat(64) },
    { ...verifiedPayout(), fundingAllowed: true },
    pendingPayout(),
  ]) {
    await openPayout();
    fetcher.mockResolvedValueOnce(Response.json({ order }));
    await click('Verify finalized payout');
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    expect(container.textContent).not.toContain('Finalized payout:');
    await click('Close saved exchange orders');
  }
});
it('admits one request, cancels waiting and recovers a saved receipt through GET while ignoring late success', async () => {
  await openPayout();
  let resolve!: (v: Response) => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementationOnce((_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((r) => {
      resolve = r;
    });
  });
  await act(async () => {
    button('Verify finalized payout').click();
    button('Verify finalized payout').click();
  });
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(container.textContent).toContain('Checking finalized payout evidence');
  await click('Stop waiting for payout check');
  expect(signal?.aborted).toBe(true);
  expect(container.textContent).toContain(
    'A receipt may already have been saved',
  );
  await act(async () => resolve(Response.json({ order: verifiedPayout() })));
  expect(container.textContent).not.toContain('Finalized payout:');
  fetcher.mockResolvedValueOnce(Response.json({ order: verifiedPayout() }));
  await click('Reload this saved order');
  expect(container.textContent).toContain('Finalized SOL payout verified');
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBeUndefined();
});
it('aborts payout checks when the funding plan changes and ignores late results', async () => {
  await openPayout();
  let resolve!: (v: Response) => void;
  let signal: AbortSignal | undefined;
  fetcher.mockImplementationOnce((_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((r) => {
      resolve = r;
    });
  });
  await click('Verify finalized payout');
  await mount('other-plan');
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ order: verifiedPayout() })));
  expect(container.textContent).not.toContain(fixture.funder.address);
});

it('releases a stuck history read at its deadline and supports explicit reload without a retry', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  fetcher.mockImplementationOnce((_input, init) => {
    signal = init!.signal!;
    return new Promise<Response>(() => {});
  });
  await mount();
  await click('View saved exchange orders');
  expect(button('Reload saved orders').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(signal.aborted).toBe(true);
  expect(button('Reload saved orders').disabled).toBe(false);
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('Reload saved orders');
  expect(container.querySelectorAll('li')).toHaveLength(1);
});
it('stops a history body reader that ignores cancellation and ignores its late result', async () => {
  let resolve!: (v: unknown) => void;
  fetcher.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      new Promise((r) => {
        resolve = r;
      }),
  } as Response);
  await mount();
  await click('View saved exchange orders');
  await click('Stop loading saved history');
  await act(async () => resolve(fixture.page));
  expect(container.querySelectorAll('li')).toHaveLength(0);
  await click('Reload saved orders');
  expect(container.querySelectorAll('li')).toHaveLength(1);
});
it('settles a payout response body timeout and offers saved-result recovery without sending again', async () => {
  await openPayout();
  vi.useFakeTimers();
  let resolve!: (v: unknown) => void;
  fetcher.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      new Promise((r) => {
        resolve = r;
      }),
  } as Response);
  await click('Verify finalized payout');
  await act(async () => vi.advanceTimersByTimeAsync(35000));
  expect(container.textContent).toContain(
    'a receipt may already have been saved',
  );
  expect(button('Reload this saved order').disabled).toBe(false);
  await act(async () => resolve({ order: verifiedPayout() }));
  expect(container.textContent).not.toContain('Finalized payout:');
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
});
