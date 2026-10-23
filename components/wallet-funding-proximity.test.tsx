// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  useWalletFundingProximity,
  WalletFundingProximityPanel,
  WalletFundingProximityBadge,
} from './wallet-funding-proximity';
const selection = [1, 2].map((n) => ({
  address: bs58.encode(new Uint8Array(32).fill(n)),
  revision: 1,
}));
const reply = () => ({
  format: 'wallet-funding-times-v1',
  network: 'mainnet',
  scope: 'most-recently-saved-native-transfer',
  capturedAt: '2026-10-22T00:00:00.000Z',
  executionAllowed: false,
  wallets: selection.map((w, i) => ({
    ...w,
    reason: null,
    funding: {
      signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
      slot: i + 1,
      blockTime: 100000 + i * 1474,
    },
  })),
});
function Harness({ wallets = selection }: { wallets?: typeof selection }) {
  const check = useWalletFundingProximity(wallets);
  return (
    <>
      <WalletFundingProximityPanel check={check} count={wallets.length} />
      {wallets.map((w) => (
        <WalletFundingProximityBadge
          key={w.address}
          check={check}
          address={w.address}
        />
      ))}
    </>
  );
}
let host: HTMLDivElement, root: Root;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function render(wallets = selection) {
  await act(async () => {
    root.render(<Harness wallets={wallets} />);
    await flush();
  });
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await flush();
  });
}
it('loads only on explicit request and shows exact gap details without claiming first funding', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({ wallets: selection });
    return Response.json(reply());
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Check recorded funding times');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(
    [...host.querySelectorAll('summary')].map((n) => n.textContent),
  ).toEqual(['Review 1 close funding pair', '24m 34s apart', '24m 34s apart']);
  expect(host.textContent).toContain('1 pair under 30 minutes');
  expect(host.textContent).toContain('not first-funding history');
  expect(host.textContent).not.toContain('Unlinked');
});
it('reviews every checked close pair in bounded pages without another read, and clears on selection changes', async () => {
  const wallets = Array.from({ length: 7 }, (_, i) => ({
    address: bs58.encode(new Uint8Array(32).fill(i + 1)),
    revision: 1,
  }));
  const fetcher = vi.fn(async () =>
    Response.json({
      ...reply(),
      wallets: wallets.map((w, i) => ({
        ...w,
        reason: null,
        funding: {
          signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
          slot: i + 1,
          blockTime: 100000 + i,
        },
      })),
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await render(wallets);
  expect(host.querySelector('ol')).toBeNull();
  await click('Check recorded funding times');
  const disclosure = host.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.textContent).toBe(
    'Review 21 close funding pairs',
  );
  expect(host.querySelectorAll('ol li')).toHaveLength(20);
  expect(button('Previous pairs').disabled).toBe(true);
  expect(button('Next pairs').disabled).toBe(false);
  expect(host.textContent).toContain('Pairs 1 to 20 of 21');
  const firstPage = [...host.querySelectorAll('ol li')].map(
    (n) => n.textContent,
  );
  expect(disclosure.textContent).toContain('saved-receipt events');
  button('Next pairs').focus();
  await click('Next pairs');
  expect(document.activeElement).toBe(host.querySelector('nav output'));
  expect(host.querySelectorAll('ol li')).toHaveLength(1);
  expect(host.querySelector('ol')?.start).toBe(21);
  expect(host.textContent).toContain('Pairs 21 to 21 of 21');
  expect(host.querySelector('ol')?.textContent).toContain(wallets[0].address);
  expect(host.querySelector('ol')?.textContent).toContain(wallets[6].address);
  expect(button('Next pairs').disabled).toBe(true);
  button('Previous pairs').focus();
  await click('Previous pairs');
  expect(document.activeElement).toBe(host.querySelector('nav output'));
  expect([...host.querySelectorAll('ol li')].map((n) => n.textContent)).toEqual(
    firstPage,
  );
  expect(fetcher).toHaveBeenCalledOnce();
  await click('Next pairs');
  await click('Check recorded funding times');
  expect(host.querySelectorAll('ol li')).toHaveLength(20);
  expect(host.textContent).toContain('Pairs 1 to 20 of 21');
  expect(host.querySelector('details')?.open).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await render(wallets.map((w) => ({ ...w, revision: 2 })));
  expect(host.querySelector('ol')).toBeNull();
  await render(wallets);
  expect(host.querySelector('ol')).toBeNull();
});
it('keeps exactly twenty pairs on one page and excludes the thirty-minute boundary', async () => {
  const wallets = Array.from({ length: 7 }, (_, i) => ({
    address: bs58.encode(new Uint8Array(32).fill(i + 1)),
    revision: 1,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...reply(),
        wallets: wallets.map((w, i) => ({
          ...w,
          reason: null,
          funding: {
            signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
            slot: i + 1,
            blockTime: 100000 + (i === 6 ? 1800 : i * 100),
          },
        })),
      }),
    ),
  );
  await render(wallets);
  await click('Check recorded funding times');
  expect(host.querySelectorAll('ol li')).toHaveLength(20);
  expect(host.textContent).toContain('Pairs 1 to 20 of 20');
  expect(button('Previous pairs').disabled).toBe(true);
  expect(button('Next pairs').disabled).toBe(true);
  expect(host.querySelector('ol')?.textContent).not.toContain('30m 00s apart');
});
it('keeps keyboard focus on an enabled middle-page control', async () => {
  const wallets = Array.from({ length: 10 }, (_, i) => ({
    address: bs58.encode(new Uint8Array(32).fill(i + 1)),
    revision: 1,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...reply(),
        wallets: wallets.map((w, i) => ({
          ...w,
          reason: null,
          funding: {
            signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
            slot: i + 1,
            blockTime: 100000 + i,
          },
        })),
      }),
    ),
  );
  await render(wallets);
  await click('Check recorded funding times');
  button('Next pairs').focus();
  await click('Next pairs');
  expect(document.activeElement).toBe(button('Next pairs'));
  expect(host.textContent).toContain('Pairs 21 to 40 of 45');
  await click('Next pairs');
  expect(document.activeElement).toBe(host.querySelector('nav output'));
  expect(host.querySelectorAll('ol li')).toHaveLength(5);
  button('Previous pairs').focus();
  await click('Previous pairs');
  expect(document.activeElement).toBe(button('Previous pairs'));
  expect(host.textContent).toContain('Pairs 21 to 40 of 45');
});
it('keeps missing funding time unknown instead of displaying a safe or green result', async () => {
  const result = reply();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...result,
        wallets: result.wallets.map((w) => ({
          ...w,
          funding: null,
          reason: 'no-retained-receipt',
        })),
      }),
    ),
  );
  await render();
  await click('Check recorded funding times');
  expect(host.textContent).toContain('2 unknown');
  expect(
    [...host.querySelectorAll('details > summary')].every((n) =>
      n.textContent?.includes('Funding time unknown'),
    ),
  ).toBe(true);
  expect(host.textContent).toContain('Funding time unknown');
});
it('does not resurrect a saved result after leaving and returning to the original selection', async () => {
  const fetcher = vi.fn(async () => Response.json(reply()));
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click('Check recorded funding times');
  expect(host.querySelector('details')).not.toBeNull();
  await render(selection.map((w) => ({ ...w, revision: 2 })));
  await render(selection);
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).toContain(
    'No funding-time check for this selection',
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it('explains the selection limit rather than leaving an oversized direct panel inert', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await render(
    Array.from({ length: 101 }, (_, i) => ({
      address: bs58.encode(new Uint8Array(32).fill(i + 1)),
      revision: 1,
    })),
  );
  expect(button('Check recorded funding times').disabled).toBe(true);
  expect(host.textContent).toContain('Select up to 100 wallets');
  expect(fetcher).not.toHaveBeenCalled();
});
it('clears old indicators when selection/revision changes and ignores a late response', async () => {
  let release!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click('Check recorded funding times');
  await render(selection.map((w) => ({ ...w, revision: 2 })));
  expect(host.textContent).toContain(
    'cancelled because the source or selected wallets changed',
  );
  expect(host.textContent).toContain('no partial result was kept');
  await act(async () => {
    release(Response.json(reply()));
    await flush();
  });
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).toContain(
    'No funding-time check for this selection',
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it('allows cancelling a read without a retry or late result and hides raw HTML errors', async () => {
  let release!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click('Check recorded funding times');
  await click('Cancel funding-time check');
  await act(async () => {
    release(Response.json(reply()));
    await flush();
  });
  expect(host.textContent).toContain('cancelled');
  expect(host.querySelector('details')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>private details</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await click('Check recorded funding times');
  expect(host.textContent).toContain('could not be checked');
  expect(host.textContent).not.toContain('private details');
});

const providerReply = () => ({
  context: selection,
  format: 'wallet-funding-origins-v1',
  network: 'mainnet',
  scope: 'oldest-provider-reported-transaction',
  ledgerMetadata: 'provider-reported',
  historyComplete: false,
  signingAllowed: false,
  executionAllowed: false,
  capturedAt: '2026-10-22T00:00:00.000Z',
  wallets: reply().wallets.map((w) => ({
    ...w,
    funding: {
      ...w.funding,
      transactionIndex: 0,
      recipientChangeRaw: '1000',
      funders: [selection[1].address],
    },
  })),
});
async function source(value: 'saved' | 'provider') {
  await act(async () => {
    const inputs = [
      ...host.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    inputs[value === 'saved' ? 0 : 1].click();
    await flush();
  });
}
it('checks provider history only on its explicit action and labels its source and funding gaps', async () => {
  const fetcher = vi.fn(async (url: string) => {
    expect(url).toBe('/api/wallet-workspace/funding-origins');
    return Response.json(providerReply());
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  await source('provider');
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain('uses provider quota');
  await click('Check provider funding history');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('2 of 2 provider-reported times');
  expect(host.querySelector('details p')?.textContent).toContain(
    'provider-reported events',
  );
  expect(
    [...host.querySelectorAll('summary')].map((n) => n.textContent),
  ).toEqual(['Review 1 close funding pair', '24m 34s apart', '24m 34s apart']);
  expect(host.textContent).toContain('Provider-reported funding events');
  expect(host.textContent).toContain('Funding sources:');
});
it('keeps source protocols separate and clears saved results when changing sources and returning', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(reply()))
    .mockResolvedValueOnce(Response.json(reply()));
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click('Check recorded funding times');
  expect(host.textContent).toContain('1 pair under 30 minutes');
  await source('provider');
  expect(host.querySelector('details')).toBeNull();
  await click('Check provider funding history');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('details')).toBeNull();
  await source('saved');
  expect(host.querySelector('details')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('aborts provider reads on source change and ignores late results on return', async () => {
  let resolve!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  await source('provider');
  await click('Check provider funding history');
  await source('saved');
  expect(signal?.aborted).toBe(true);
  await source('provider');
  await act(async () => {
    resolve(Response.json(providerReply()));
    await flush();
  });
  expect(host.querySelector('details')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows provider unknown reasons in keyboard-accessible details without treating them as no funding', async () => {
  const body = providerReply();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...body,
        wallets: body.wallets.map((w) => ({
          ...w,
          funding: null,
          reason: 'unavailable-oldest-evidence',
        })),
      }),
    ),
  );
  await render();
  await source('provider');
  await click('Check provider funding history');
  expect(host.textContent).toContain('2 unknown');
  expect(host.querySelector('details summary')?.textContent).toContain(
    'Funding time unknown',
  );
  expect(host.textContent).toContain(
    'oldest returned evidence could not be validated',
  );
  expect(host.textContent).not.toContain('Recorded funding events');
});

it('does not revive provider results across selection A-to-B-to-A changes', async () => {
  let release!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((r) => {
        release = r;
      });
    }),
  );
  await render();
  await source('provider');
  await click('Check provider funding history');
  await render([{ ...selection[0], revision: 2 }]);
  expect(signal?.aborted).toBe(true);
  await render();
  await act(async () => {
    release(Response.json(providerReply()));
    await flush();
  });
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).toContain(
    'No funding-time check for this selection',
  );
});
it('returns keyboard focus after cancelling a provider check', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          ),
        ),
    ),
  );
  await render();
  await source('provider');
  await click('Check provider funding history');
  button('Cancel funding-time check').focus();
  await click('Cancel funding-time check');
  expect(document.activeElement).toBe(button('Check provider funding history'));
});

it.each([true, false])(
  'returns keyboard focus when a provider check finishes (success=%s)',
  async (success) => {
    let release!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    await render();
    await source('provider');
    await click('Check provider funding history');
    await act(async () => {
      button('Cancel funding-time check').focus();
    });
    await act(async () => {
      release(
        success
          ? Response.json(providerReply())
          : new Response(null, { status: 429 }),
      );
      await flush();
    });
    expect(document.activeElement).toBe(
      button('Check provider funding history'),
    );
  },
);

it.each(['saved', 'provider'] as const)(
  'keeps cancellation guidance tied to the original %s read after a source switch',
  async (from) => {
    let captured: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      captured = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetcher);
    await render();
    await source(from);
    await click(
      from === 'saved'
        ? 'Check recorded funding times'
        : 'Check provider funding history',
    );
    await source(from === 'saved' ? 'provider' : 'saved');
    expect(captured!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(host.textContent?.includes('Wait at least 15 seconds')).toBe(
      from === 'provider',
    );
    if (from === 'saved')
      expect(host.textContent).not.toContain('0 wallets were read');
  },
);
