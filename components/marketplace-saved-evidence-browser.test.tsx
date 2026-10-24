// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { MarketplaceSavedEvidenceBrowser } from './marketplace-saved-evidence-browser';
import {
  savedEvidenceAuthority,
  savedEvidenceUrl,
  savedWalletCursor,
  savedHistoryCursor,
  SAVED_EVIDENCE_CLOCK_MESSAGE,
  type SavedWalletPage,
  type SavedHistoryPage,
  type SavedEvidenceRecord,
} from '@/lib/marketplace-saved-evidence';

const now = Date.parse('2026-10-24T12:00:00.000Z');
const iso = (before = 0) => new Date(now - before).toISOString();
const wallets = Array.from({ length: 23 }, (_, index) => ({
  address: bs58.encode(new Uint8Array(32).fill(index + 1)),
  revision: 2,
  label: `Saved wallet ${index}`,
  updatedAt: iso(10000),
})).sort((a, b) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
);
function walletPage(offset = 0, cursor: string | null = null): SavedWalletPage {
  const rows = wallets.slice(offset, offset + 20);
  return {
    format: 'marketplace-saved-evidence-page-v1',
    chain: 'Solana',
    view: 'wallets',
    observedAt: iso(),
    ...savedEvidenceAuthority,
    request: { view: 'wallets', cursor },
    wallets: rows,
    nextCursor:
      offset + 20 < wallets.length
        ? savedWalletCursor(rows.at(-1)!.address)
        : null,
  };
}
function record(index = 99): SavedEvidenceRecord {
  const id = `run-${String(index).padStart(3, '0')}`;
  return {
    id,
    revision: 3,
    createdAt: iso(100000),
    updatedAt: iso(20000),
    capturedWalletRevision: 1,
    outcome: 'observation',
    observation: {
      runId: id,
      walletRevision: 1,
      observedAt: iso(30000),
      source: 'history.example.invalid',
      balanceLamports: '18446744073709551615',
      sampleCount: 50,
      successfulSampleCount: 45,
      oldestSampledActivityAt: iso(86400000),
      latestSampledActivityAt: iso(60000),
    },
  };
}
function historyPage(
  offset = 0,
  cursor: string | null = null,
  selected = wallets[0],
): SavedHistoryPage {
  const request = {
    view: 'history' as const,
    address: selected.address,
    revision: selected.revision,
    cursor,
  };
  const rows = Array.from({ length: offset === 0 ? 20 : 2 }, (_, index) =>
    record(99 - offset - index),
  );
  return {
    format: 'marketplace-saved-evidence-page-v1',
    chain: 'Solana',
    view: 'history',
    observedAt: iso(),
    ...savedEvidenceAuthority,
    request,
    wallet: selected,
    records: rows,
    nextCursor:
      offset === 0
        ? savedHistoryCursor(request, rows.at(-1)!.createdAt, rows.at(-1)!.id)
        : null,
  };
}
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetcher.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(strict = false) {
  await act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <MarketplaceSavedEvidenceBrowser />
        </StrictMode>
      ) : (
        <MarketplaceSavedEvidenceBrowser />
      ),
    ),
  );
}
async function disclosure(open = true) {
  await act(async () => {
    const details = host.querySelector('details')!;
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
  });
}
function button(label: string, index = 0) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent === label,
  )[index];
}
async function click(label: string, index = 0) {
  expect(button(label, index)).toBeTruthy();
  await act(async () => button(label, index).click());
}
function defer() {
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (response: Response) => act(async () => resolve(response));
}
async function loadWallets() {
  await render();
  await disclosure();
  fetcher.mockResolvedValueOnce(Response.json(walletPage()));
  await click('Load saved wallets');
}
async function loadHistory() {
  await loadWallets();
  await click('Select this saved read target');
  fetcher.mockResolvedValueOnce(Response.json(historyPage()));
  await click('Load retained history');
}

it('is collapsed and passive on mount/disclosure and never offers financial controls', async () => {
  await render(true);
  expect(host.querySelector('details')!.open).toBe(false);
  await disclosure();
  await disclosure(false);
  await disclosure();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    'not proof of control or exclusive custody',
  );
  expect(host.textContent).toContain('not a complete inventory');
  expect(host.querySelector('input,select,form,img,iframe')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /approve|sign|send|pay|list wallet|fund|restore/i.test(b.textContent!),
    ),
  ).toBe(false);
});
it('loads20current saved wallet metadata rows only on an exact GET and selects an internal read target without another request', async () => {
  await loadWallets();
  expect(
    host.querySelectorAll('[aria-label="Saved Solana wallet page"] > li'),
  ).toHaveLength(20);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    savedEvidenceUrl({ view: 'wallets', cursor: null }),
    {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    },
  );
  await click('Select this saved read target', 1);
  expect(fetcher).toHaveBeenCalledOnce();
  const target = host.querySelector(
    '[aria-label="Saved history read target"]',
  )!;
  expect(target.textContent).toContain(wallets[1].address);
  expect(target.textContent).toContain('revision selected: 2');
  expect(host.querySelector('[aria-label="Retained history page"]')).toBeNull();
});
it('replaces wallet pages, clears targets/history and provides a keyboard reachable back position', async () => {
  await loadWallets();
  await click('Select this saved read target');
  const next = walletPage().nextCursor!;
  fetcher.mockResolvedValueOnce(Response.json(walletPage(20, next)));
  button('Next wallet page').focus();
  await click('Next wallet page');
  expect(
    host.querySelector('[aria-label="Saved history read target"]'),
  ).toBeNull();
  expect(
    host.querySelectorAll('[aria-label="Saved Solana wallet page"] > li'),
  ).toHaveLength(3);
  expect(fetcher.mock.calls[1][0]).toBe(
    savedEvidenceUrl({ view: 'wallets', cursor: next }),
  );
  expect(document.activeElement?.textContent).toBe('Saved wallet page 2');
  fetcher.mockResolvedValueOnce(Response.json(walletPage()));
  await click('Previous wallet page');
  expect(host.textContent).toContain('Saved wallet page 1');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('reads20retained records with exact target/revision and preserves historical units and sample scope without lifecycle claims', async () => {
  await loadHistory();
  expect(
    host.querySelectorAll('[aria-label="Retained history page"] > li'),
  ).toHaveLength(20);
  expect(
    host.querySelector('[aria-label="Saved Solana wallet page"]'),
  ).toBeNull();
  expect(fetcher.mock.calls[1][0]).toBe(
    savedEvidenceUrl(historyPage().request),
  );
  for (const text of [
    'run-099',
    'Captured wallet revision: 1',
    '18446744073709551615',
    'lamports (not current)',
    '45 successful records in this 50-signature sample',
    'Oldest timestamp within this sample',
    'does not verify lifecycle continuity',
    'not decoded trade or funding counts',
  ])
    expect(host.textContent).toContain(text);
  expect(host.querySelectorAll('a')).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('paginates same-timestamp history ties with exact target-bound cursors and replaces old rows on next/back', async () => {
  await loadHistory();
  const next = historyPage().nextCursor!;
  fetcher.mockResolvedValueOnce(Response.json(historyPage(20, next)));
  button('Next history page').focus();
  await click('Next history page');
  expect(
    host.querySelectorAll('[aria-label="Retained history page"] > li'),
  ).toHaveLength(2);
  expect(host.textContent).not.toContain('run-099');
  expect(host.textContent).toContain('run-079');
  expect(document.activeElement?.textContent).toBe('Retained history page 2');
  expect(fetcher.mock.calls[2][0]).toBe(
    savedEvidenceUrl({ ...historyPage().request, cursor: next }),
  );
  fetcher.mockResolvedValueOnce(Response.json(historyPage()));
  await click('Previous history page');
  expect(
    host.querySelectorAll('[aria-label="Retained history page"] > li'),
  ).toHaveLength(20);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('keeps read-failed, not-recorded and unknown sampled dates distinct without inventing absent activity or balances', async () => {
  await loadWallets();
  await click('Select this saved read target');
  const page = historyPage();
  page.nextCursor = null;
  page.records = [
    { ...record(99), outcome: 'read-failed', observation: null },
    { ...record(98), outcome: 'not-recorded', observation: null },
    {
      ...record(97),
      observation: {
        ...record(97).observation!,
        sampleCount: 0,
        successfulSampleCount: 0,
        oldestSampledActivityAt: null,
        latestSampledActivityAt: null,
      },
    },
  ];
  fetcher.mockResolvedValueOnce(Response.json(page));
  await click('Load retained history');
  expect(host.textContent).toContain('A failed history read was recorded');
  expect(host.textContent).toContain('No result was recorded');
  expect(host.textContent).toContain(
    'Oldest timestamp within this sample at that check: Unavailable',
  );
  expect(host.textContent).toContain(
    '0 successful records in this 0-signature sample',
  );
});
it.each([
  'controlProven',
  'lifecycleVerified',
  'completeInventory',
  'completeHistory',
  'listingAllowed',
  'paymentAllowed',
  'deliveryAllowed',
  'signingAllowed',
  'executionAllowed',
] as const)(
  'refuses changed %s authority with no displayed partial wallets',
  async (flag) => {
    await render();
    await disclosure();
    fetcher.mockResolvedValueOnce(
      Response.json({ ...walletPage(), [flag]: true }),
    );
    await click('Load saved wallets');
    expect(
      host.querySelector('[aria-label="Saved Solana wallet page"]'),
    ).toBeNull();
    expect(host.textContent).toContain('No partial page is shown');
  },
);
it.each([
  'cross-view',
  'cross-target',
  'cross-revision',
  'wrong-cursor',
  'extra-body',
  'duplicate-row',
  'malformed-date',
  'unknown-cursor',
] as const)(
  'refuses a mismatched or malformed history page: %s',
  async (mode) => {
    await loadWallets();
    await click('Select this saved read target');
    let page: unknown = historyPage();
    if (mode === 'cross-view') page = walletPage();
    if (mode === 'cross-target') page = historyPage(0, null, wallets[1]);
    if (mode === 'cross-revision')
      page = historyPage(0, null, { ...wallets[0], revision: 3 });
    if (mode === 'wrong-cursor')
      page = {
        ...historyPage(),
        request: {
          ...historyPage().request,
          cursor: savedHistoryCursor(
            historyPage().request,
            iso(100000),
            'earlier',
          ),
        },
      };
    if (mode === 'extra-body')
      page = { ...historyPage(), rawDocument: 'private untrusted data' };
    if (mode === 'duplicate-row')
      page = {
        ...historyPage(),
        records: [record(), record()],
        nextCursor: null,
      };
    if (mode === 'malformed-date')
      page = { ...historyPage(), observedAt: 'invalid' };
    if (mode === 'unknown-cursor')
      page = { ...historyPage(), nextCursor: 'untrusted-cursor' };
    fetcher.mockResolvedValueOnce(Response.json(page));
    await click('Load retained history');
    expect(
      host.querySelector('[aria-label="Retained history page"]'),
    ).toBeNull();
    expect(host.textContent).toContain('unavailable');
    expect(host.textContent).not.toContain('private untrusted data');
  },
);
it.each([401, 404, 409, 503])(
  'clears an old history page for HTTP%s and offers only fixed manual recovery',
  async (status) => {
    await loadHistory();
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await click('Load retained history');
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      host.querySelector('[aria-label="Retained history page"]'),
    ).toBeNull();
    if (status === 401) {
      const link = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]');
      expect(link?.target).toBe('_blank');
      expect(link?.rel).toBe('noopener noreferrer');
    }
    if (status === 409) {
      expect(
        host.querySelector('[aria-label="Saved history read target"]'),
      ).toBeNull();
      expect(button('Retry saved evidence read')).toBeUndefined();
      expect(host.textContent).toContain(
        'Reload saved wallets and select it again',
      );
    }
    if (status === 404)
      expect(host.textContent).toContain('unavailable for this account');
    await act(async () => vi.advanceTimersByTime(30000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
it('retries the same authenticated page only manually and clears sign-in while pending', async () => {
  await render();
  await disclosure();
  fetcher.mockResolvedValueOnce(new Response('expired', { status: 401 }));
  await click('Load saved wallets');
  const finish = defer();
  await click('Retry saved evidence read');
  expect(host.querySelector('a')).toBeNull();
  await finish(Response.json(walletPage()));
  expect(
    host.querySelector('[aria-label="Saved Solana wallet page"]'),
  ).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('retains correct back navigation after manually retrying an older page refusal', async () => {
  await loadWallets();
  const next = walletPage().nextCursor!;
  fetcher.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
  await click('Next wallet page');
  fetcher.mockResolvedValueOnce(Response.json(walletPage(20, next)));
  await click('Retry saved evidence read');
  expect(button('Previous wallet page').disabled).toBe(false);
  expect(host.textContent).toContain('Saved wallet page 2');
});
it('releases a hung fetch at15seconds and ignores late success after a new explicit read', async () => {
  const finish = defer();
  await render();
  await disclosure();
  await click('Load saved wallets');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await act(async () => vi.advanceTimersByTime(15000));
  expect(signal.aborted).toBe(true);
  expect(host.textContent).toContain('took too long');
  expect(button('Load saved wallets').disabled).toBe(false);
  fetcher.mockResolvedValueOnce(
    Response.json({ ...walletPage(), wallets: [], nextCursor: null }),
  );
  await click('Load saved wallets');
  const cancel = vi.fn();
  await finish(new Response(new ReadableStream({ cancel })));
  expect(cancel).toHaveBeenCalledOnce();
  expect(
    host.querySelectorAll('[aria-label="Saved Solana wallet page"] > li'),
  ).toHaveLength(0);
});
it('cancels response-body reads at15seconds and refuses oversized responses without partial rows', async () => {
  const cancel = vi.fn();
  fetcher.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await render();
  await disclosure();
  await click('Load saved wallets');
  await act(async () => vi.advanceTimersByTime(15000));
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('took too long');
  fetcher.mockResolvedValueOnce(
    new Response(' '.repeat(1048577), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await click('Load saved wallets');
  expect(host.textContent).toContain('No partial page is shown');
  expect(
    host.querySelector('[aria-label="Saved Solana wallet page"]'),
  ).toBeNull();
});
it.each(['cancel', 'close', 'unmount'] as const)(
  'ignores a late401 after %s and does not restore old targets',
  async (action) => {
    await loadWallets();
    await click('Select this saved read target');
    const finish = defer();
    await click('Load retained history');
    const signal = fetcher.mock.calls[1][1]!.signal!;
    if (action === 'cancel') await click('Cancel saved evidence read');
    if (action === 'close') await disclosure(false);
    if (action === 'unmount') {
      await act(async () => root.unmount());
      root = createRoot(host);
    }
    expect(signal.aborted).toBe(true);
    await finish(new Response('expired', { status: 401 }));
    expect(
      host.querySelector(
        'a,[aria-label="Retained history page"],[aria-label="Saved history read target"]',
      ),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('closing loaded evidence clears both pages and selection; reopening remains passive', async () => {
  await loadHistory();
  await disclosure(false);
  await disclosure();
  expect(
    host.querySelector(
      '[aria-label="Retained history page"],[aria-label="Saved history read target"]',
    ),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not assert lifecycle continuity when captured and current saved revisions match numerically', async () => {
  await loadWallets();
  await click('Select this saved read target');
  const page = historyPage();
  page.records = [
    {
      ...record(),
      capturedWalletRevision: 2,
      observation: { ...record().observation!, walletRevision: 2 },
    },
  ];
  page.nextCursor = null;
  fetcher.mockResolvedValueOnce(Response.json(page));
  await click('Load retained history');
  expect(host.textContent).toContain('Captured wallet revision: 2');
  expect(host.textContent).toContain(
    'does not verify lifecycle continuity, even when it matches',
  );
  expect(host.textContent).not.toContain('Lifecycle verified');
});

it('closing during a delayed response body cancels it and cannot restore records after reopening', async () => {
  await loadWallets();
  await click('Select this saved read target');
  const cancel = vi.fn();
  fetcher.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await click('Load retained history');
  await disclosure(false);
  await disclosure();
  expect(cancel).toHaveBeenCalledOnce();
  expect(
    host.querySelector(
      '[aria-label="Retained history page"],[aria-label="Saved history read target"]',
    ),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([-5001, 300001])(
  'shows fixed clock guidance for a refused page freshness difference of%sms',
  async (difference) => {
    await loadWallets();
    fetcher.mockResolvedValueOnce(
      Response.json({ ...walletPage(), observedAt: iso(difference) }),
    );
    await click('Load saved wallets');
    expect(host.textContent).toContain(SAVED_EVIDENCE_CLOCK_MESSAGE);
    expect(
      host.querySelector(
        '[aria-label="Saved Solana wallet page"],[aria-label="Retained history page"]',
      ),
    ).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(([, options]) => options?.method === 'GET'),
    ).toBe(true);
  },
);

it('keeps the coverage and custody disclosure passive and makes no complete-history promise', async () => {
  await render();
  await disclosure();
  const limits = host.querySelectorAll<HTMLDetailsElement>('details')[1];
  expect(limits.querySelector('summary')?.textContent).toBe(
    'Coverage and custody limits',
  );
  expect(limits.open).toBe(false);
  await act(async () => {
    limits.open = true;
    limits.dispatchEvent(new Event('toggle'));
  });
  await act(async () => {
    limits.open = false;
    limits.dispatchEvent(new Event('toggle'));
  });
  expect(host.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    'Pages cover matching saved records, not all possible history',
  );
  expect(host.textContent).not.toContain('nothing is silently skipped');
  expect(host.querySelector('details > p')?.textContent).toContain(
    'Browse saved workspace wallet records, 20 per page',
  );
});
