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
  ).toEqual(['24m 34s apart', '24m 34s apart']);
  expect(host.textContent).toContain('1 pair under 30 minutes');
  expect(host.textContent).toContain('not first-funding history');
  expect(host.textContent).not.toContain('Unlinked');
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
  expect(host.querySelector('details')).toBeNull();
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
