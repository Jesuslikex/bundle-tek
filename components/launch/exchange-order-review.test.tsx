// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExchangeOrderReview } from './exchange-order-review';
import bs58 from 'bs58';
import { exchangeOrderHistoryFixture } from '@/test/exchange-order-history-fixture';
let f: ReturnType<typeof exchangeOrderHistoryFixture>,
  root: Root,
  host: HTMLDivElement;
let wallets: unknown[], proofs: unknown[], retained: unknown;
const fetcher = vi.fn<typeof fetch>();
const btn = (name: string) => {
  const b = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === name,
  );
  if (!b) throw Error('Missing ' + name);
  return b;
};
const click = async (name: string) => act(async () => btn(name).click());
const mount = async (quote = f.review, blockedReason = '') =>
  act(async () =>
    root.render(
      <ExchangeOrderReview quote={quote} blockedReason={blockedReason} />,
    ),
  );
const posts = () =>
  fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
const refund = () => ({
  chain: 'Solana',
  address: f.detail.refundAddress,
  revision: 4,
  label: 'Refund fixture',
  archived: false,
});
const open = () => click('Review refund wallet');
async function choose() {
  const select = host.querySelector('select')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, f.detail.refundAddress);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  f = exchangeOrderHistoryFixture();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.review.quotedAt));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  retained = null;
  wallets = [f.funder, refund()];
  proofs = wallets.map((w) => ({
    chain: (w as ReturnType<typeof refund>).chain,
    address: (w as ReturnType<typeof refund>).address,
  }));
  fetcher.mockReset().mockImplementation(async (input, init) => {
    if (input === '/api/wallet-workspace')
      return Response.json({ wallets, proofs });
    if (init?.method === 'POST') {
      retained = f.detail;
      return Response.json({ order: retained });
    }
    return Response.json({ order: retained });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('loads only after explicit open, requires a separate choice and saves only the exact quote/refund reference', async () => {
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await open();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.querySelectorAll('option')).toHaveLength(2);
  expect(host.querySelector('select')?.value).toBe('');
  await choose();
  expect(host.textContent).toContain('1.15 SOL');
  expect(host.textContent).toContain('1.1 SOL');
  expect(host.querySelector('input')).toBeNull();
  await click('Save quote and refund review');
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0][1]?.body as string)).toEqual({
    quoteId: f.review.id,
    refund: { address: f.detail.refundAddress, revision: 4 },
  });
  expect(host.textContent).toContain(
    'Review saved. No exchange order, deposit or approval was created',
  );
  expect(host.textContent).toContain('Saved review ' + f.detail.id);
  expect(host.querySelector('select')).toBeNull();
});
it('offers only active proven Solana refund wallets and refuses missing funder proof', async () => {
  wallets.push(
    {
      ...refund(),
      address: bs58.encode(new Uint8Array(32).fill(9)),
      archived: true,
    },
    { ...refund(), chain: 'Ethereum', address: '0x1' },
    {
      ...refund(),
      address: '11111111111111111111111111111112',
      label: 'Unproven',
    },
  );
  await mount();
  await open();
  expect(host.querySelectorAll('option')).toHaveLength(2);
  proofs = [];
  await click('Reload saved review and wallets');
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.textContent).toContain('receiving funder needs');
  expect(posts()).toHaveLength(0);
});
it('blocks a duplicate roster and a review from another immutable quote', async () => {
  wallets.push(refund());
  await mount();
  await open();
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  wallets = [f.funder, refund()];
  retained = {
    ...f.detail,
    quote: { ...f.review, id: '00000000-0000-4000-8000-000000000009' },
  };
  await click('Reload saved review and wallets');
  expect(host.textContent).not.toContain('Saved review ' + f.detail.id);
  expect(btn('Save quote and refund review').disabled).toBe(true);
});
it('keeps an unknown save held and recovers it through GET without an automatic second POST', async () => {
  await mount();
  await open();
  await choose();
  fetcher.mockImplementationOnce(async () => {
    retained = f.detail;
    return new Response('<html>private provider diagnostic</html>', {
      status: 503,
    });
  });
  await click('Save quote and refund review');
  expect(host.textContent).toContain('A review may already exist');
  expect(host.textContent).not.toContain('private provider');
  expect(host.querySelector('select')?.disabled).toBe(true);
  expect(btn('Save quote and refund review').disabled).toBe(true);
  await click('Reload saved review and wallets');
  expect(host.textContent).toContain('Saved review recovered');
  expect(posts()).toHaveLength(1);
});
it('permits manual retry only after recovery confirms no review exists', async () => {
  await mount();
  await open();
  await choose();
  fetcher.mockRejectedValueOnce(new Error('lost response'));
  await click('Save quote and refund review');
  expect(btn('Save quote and refund review').disabled).toBe(true);
  await click('Reload saved review and wallets');
  expect(btn('Save quote and refund review').disabled).toBe(false);
  expect(posts()).toHaveLength(1);
  await click('Save quote and refund review');
  expect(posts()).toHaveLength(2);
});
it('cancels one in-flight save, ignores a late result and retains the recovery requirement', async () => {
  await mount();
  await open();
  await choose();
  let release!: (v: Response) => void, signal!: AbortSignal;
  fetcher.mockImplementationOnce((_input, init) => {
    signal = init!.signal!;
    return new Promise((r) => {
      release = r;
    });
  });
  await act(async () => {
    btn('Save quote and refund review').click();
    btn('Save quote and refund review').click();
  });
  expect(posts()).toHaveLength(1);
  await click('Stop waiting for review');
  expect(signal.aborted).toBe(true);
  expect(btn('Save quote and refund review').disabled).toBe(true);
  await act(async () => release(Response.json({ order: f.detail })));
  expect(host.textContent).not.toContain('Saved review ' + f.detail.id);
});
it('clears a pending result when the quote changes and rejects unexpected authority on success', async () => {
  await mount();
  await open();
  await choose();
  fetcher.mockResolvedValueOnce(
    Response.json({ order: { ...f.detail, fundingAllowed: true } }),
  );
  await click('Save quote and refund review');
  expect(host.textContent).not.toContain('Saved review ' + f.detail.id);
  await mount({ ...f.review, id: '00000000-0000-4000-8000-000000000009' });
  expect(btn('Review refund wallet')).toBeDefined();
  expect(host.querySelector('select')).toBeNull();
});
it('allows historical recovery but blocks a new review when expired or the parent draft changed', async () => {
  vi.mocked(Date.now).mockReturnValue(Date.parse(f.review.expiresAt));
  retained = f.detail;
  await mount();
  await open();
  expect(host.textContent).toContain('Saved review recovered');
  expect(host.querySelector('select')).toBeNull();
  retained = null;
  await mount(f.review, 'Funding draft changed. Request a fresh quote.');
  await open();
  await choose();
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.textContent).toContain('Funding draft changed');
  expect(posts()).toHaveLength(0);
});
it('invalidates an otherwise-ready choice five seconds before quote expiry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await mount();
  await open();
  await choose();
  expect(btn('Save quote and refund review').disabled).toBe(false);
  vi.mocked(Date.now).mockReturnValue(Date.parse(f.review.expiresAt) - 5000);
  await act(async () => vi.advanceTimersByTimeAsync(55000));
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.textContent).toContain('too close to expiry');
});
it('clears saved private review on authentication failure', async () => {
  retained = f.detail;
  await mount();
  await open();
  expect(host.textContent).toContain('Saved review ' + f.detail.id);
  fetcher.mockResolvedValue(new Response('', { status: 401 }));
  await click('Reload saved review and wallets');
  expect(host.textContent).not.toContain('Saved review ' + f.detail.id);
  expect(host.textContent).toContain('Sign in to review');
});

it('aborts an in-flight save on quote replacement and ignores the late old review', async () => {
  await mount();
  await open();
  await choose();
  let release!: (v: Response) => void, signal!: AbortSignal;
  fetcher.mockImplementationOnce((_input, init) => {
    signal = init!.signal!;
    return new Promise((r) => {
      release = r;
    });
  });
  await click('Save quote and refund review');
  await mount({ ...f.review, id: '00000000-0000-4000-8000-000000000009' });
  expect(signal.aborted).toBe(true);
  await act(async () => release(Response.json({ order: f.detail })));
  expect(host.textContent).not.toContain('Saved review ' + f.detail.id);
  expect(btn('Review refund wallet')).toBeDefined();
});
it('settles an ignored response-body timeout as an unknown save and recovers without another POST', async () => {
  await mount();
  await open();
  await choose();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: (v: unknown) => void;
  fetcher.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      new Promise((r) => {
        release = r;
      }),
  } as Response);
  await click('Save quote and refund review');
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(btn('Save quote and refund review').disabled).toBe(true);
  expect(host.textContent).toContain('A review may already exist');
  retained = f.detail;
  await click('Reload saved review and wallets');
  await act(async () =>
    release({ order: { ...f.detail, fundingAllowed: true } }),
  );
  expect(host.textContent).toContain('Saved review recovered');
  expect(posts()).toHaveLength(1);
});
it('keeps recovered historical terms readable when wallet choices cannot load', async () => {
  retained = f.detail;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, init) =>
    input === '/api/wallet-workspace'
      ? Promise.resolve(new Response('', { status: 503 }))
      : original(input, init),
  );
  await mount();
  await open();
  expect(host.textContent).toContain('Saved review ' + f.detail.id);
  expect(host.textContent).toContain('Refund wallet choices are unavailable');
  expect(posts()).toHaveLength(0);
});
