// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplaceControlFixture } from '@/test/marketplace-control-evidence-fixture';
import { ownershipMessage } from '@/lib/wallet-ownership-message';
import { buildMarketplaceControlEvidence } from '@/lib/marketplace-control-evidence';
import { MarketplaceControlEvidencePanel } from './marketplace-control-evidence-panel';
const now = Date.parse('2026-10-20T12:00:00.000Z');
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = marketplaceControlFixture(now);
  f.site = window.location.origin;
  f.row.message = ownershipMessage(
    f.site,
    'Solana',
    f.selection.address,
    f.id,
    f.issuedAt,
    f.expiresAt,
  );
  const evidence = await buildMarketplaceControlEvidence(
    f.row,
    f.selection,
    f.site,
    now,
  );
  return { ...f, evidence };
}
async function mount() {
  const f = await fixture();
  await act(async () =>
    root.render(
      <MarketplaceControlEvidencePanel
        inventory={f.inventory}
        selection={f.selection}
      />,
    ),
  );
  return f;
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
const result = () => host.querySelector('[aria-label="Control record result"]');
it('only requests the exact reviewed record manually and explains the existing verification flow without a signer', async () => {
  const f = await fixture(),
    fetcher = vi.fn(async () => Response.json({ evidence: f.evidence }));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/');
  expect(host.textContent).toContain('My wallets');
  expect(host.textContent).toContain('reload seller inventory');
  await click('Check saved control record');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/marketplace/operator/control-evidence');
  expect(JSON.parse(init.body as string)).toEqual(f.selection);
  expect(result()?.textContent).toContain(
    'Recent same-site verification record',
  );
  expect(result()?.textContent).toContain('does not approve the asking price');
  expect(result()?.textContent).toContain('exclusive key control');
  expect(host.querySelector('input')).toBeNull();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(result()).toBeNull();
  expect(host.textContent).toContain('snapshot expired');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  'no-record',
  'challenge-unavailable',
  'expired-record',
  'other-origin',
] as const)(
  'explains %s without pretending it establishes current control',
  async (state) => {
    const f = await fixture();
    if (state === 'no-record' || state === 'challenge-unavailable') {
      Object.assign(f.row, {
        challengeId: null,
        message: null,
        challengeExpiresAt: null,
        usedAt: null,
        claimId: null,
      });
      if (state === 'no-record') {
        f.row.proofVerifiedAt = null;
        f.row.proofChallengeId = null;
        f.inventory.wallets[0].ownershipProofAt = null;
      }
    } else {
      const expires =
        state === 'expired-record' ? new Date(now).toISOString() : f.expiresAt;
      const issued = new Date(Date.parse(expires) - 300000).toISOString();
      f.row.challengeExpiresAt = expires;
      f.row.message = ownershipMessage(
        state === 'other-origin' ? 'https://old.test' : f.site,
        'Solana',
        f.selection.address,
        f.id,
        issued,
        expires,
      );
    }
    const evidence = await buildMarketplaceControlEvidence(
      f.row,
      f.selection,
      f.site,
      now,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ evidence })),
    );
    await act(async () =>
      root.render(
        <MarketplaceControlEvidencePanel
          inventory={f.inventory}
          selection={f.selection}
        />,
      ),
    );
    await click('Check saved control record');
    expect(result()).not.toBeNull();
    expect(result()?.textContent).not.toContain('Recent same-site');
    expect(result()?.textContent).toContain(
      'Payment and key delivery remain unavailable',
    );
  },
);
it.each([400, 401, 403, 408, 409, 413, 415, 503])(
  'uses fixed local guidance for status %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'private error' }, { status })),
    );
    await mount();
    await click('Check saved control record');
    expect(host.querySelector('output')).not.toBeNull();
    expect(result()).toBeNull();
    expect(host.textContent).not.toContain('private error');
  },
);
it.each(['html', 'price', 'authority', 'origin', 'future'] as const)(
  'refuses %s responses without exposing parser text',
  async (change) => {
    const f = await fixture();
    if (change === 'price') f.evidence.selection.priceLamports = '1';
    if (change === 'authority')
      Object.assign(f.evidence, { signingAllowed: true });
    if (change === 'origin') f.evidence.siteOrigin = 'https://other.test';
    if (change === 'future')
      f.evidence.observedAt = new Date(now + 1).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        change === 'html'
          ? new Response('<html>private parser</html>', {
              status: 502,
              headers: { 'content-type': 'text/html' },
            })
          : Response.json({ evidence: f.evidence }),
      ),
    );
    await mount();
    await click('Check saved control record');
    expect(result()).toBeNull();
    expect(host.querySelector('output')).not.toBeNull();
    expect(host.textContent).not.toContain('private parser');
    expect(host.textContent).not.toContain('Zod');
    if (change === 'future') expect(host.textContent).toContain('device time');
  },
);
it('cancels a pending read, ignores its late response and aborts on unmount', async () => {
  const f = await fixture();
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check saved control record');
  expect(button('Checking control record…').disabled).toBe(true);
  await click('Cancel control check');
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ evidence: f.evidence })));
  expect(result()).toBeNull();
  expect(host.textContent).toContain('cancelled');
  await click('Check saved control record');
  await act(async () => root.render(null));
  expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
});
