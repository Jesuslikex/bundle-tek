// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MainnetFundingHistoryPanel } from './mainnet-funding-history';
import {
  decodeMainnetFundingHistory,
  mainnetFundingHistoryCursor,
  type MainnetFundingHistory,
  type MainnetFundingRecord,
} from '@/lib/mainnet-funding-history';
const id = 'saved-funding',
  other = 'other-funding';
let container: HTMLDivElement, root: Root;
let requests: {
  url: string;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}[];
const record = (sequence: number, revision = 1): MainnetFundingRecord => ({
  sequence,
  createdAt: '2026-10-13T00:00:00.000Z',
  withdrawalId: '00000000-0000-4000-8000-' + String(sequence).padStart(12, '0'),
  wallet: 'public-source',
  walletRevision: 1,
  recipient: 'public-recipient',
  amount: '0.01',
  amountRaw: '10000000',
  asset: { kind: 'native', mint: null, decimals: 9 },
  funding: {
    format: 'mainnet-funding-v1',
    planId: id,
    revision,
    item: 1,
    termsSha256: 'a'.repeat(64),
    scheduledAt: '2026-10-13T00:00:00.000Z',
  },
  state: 'submitted',
  evidenceGap: null,
  signature: 'public-transaction',
  feeLimitLamports: '5000',
  maximumDebitLamports: '10005000',
  reserveLamports: '890880',
  reviewExpiresAt: '2026-10-13T00:01:00.000Z',
  receipt: null,
  failure: null,
});
const page = (
  events: MainnetFundingRecord[],
  revision: number | null = null,
  plan = id,
): MainnetFundingHistory => ({
  id: plan,
  name: 'Saved funding',
  currentRevision: 2,
  archived: true,
  revision,
  executionAllowed: false,
  events,
  progress: { revision: revision ?? 2, records: [] },
  nextCursor: null,
});
beforeEach(async () => {
  requests = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({ url, signal: init?.signal, resolve }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MainnetFundingHistoryPanel id={id} revision={2} name="Saved funding" />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function button(name: string) {
  const value = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(name),
  );
  if (!value) throw new Error('Missing button: ' + name);
  return value;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function respond(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
}
it('loads on open, shows unresolved progress and exact finalized delivery, and paginates without duplicate transitions', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await click('Open mainnet');
  const submitted = record(2),
    finalized = {
      ...record(3),
      state: 'finalized' as const,
      receipt: {
        slot: 120,
        observedAt: '2026-10-13T00:00:00.000Z',
        deliveredRaw: '10000000',
        networkFeeLamports: '5000',
        accountRentLamports: '0',
        transferFeeRaw: null,
      },
    };
  const first = page([finalized, submitted]);
  first.progress.records = [
    { ...record(4, 2), state: 'signing', signature: null },
  ];
  first.nextCursor = mainnetFundingHistoryCursor(id, null, 2);
  await respond(0, first);
  expect(container.textContent).toContain('Archived draft');
  expect(container.textContent).toContain(
    '0 verified deliveries for direct routes · 0 verified proxy-leg transfers · 1 unresolved steps',
  );
  expect(container.textContent).toContain('recipient received 0.01 SOL');
  expect(container.textContent).toContain(
    'No successful finalized delivery receipt was recorded at this transition',
  );
  expect(container.querySelector('a')?.href).toContain(
    'explorer.solana.com/tx/',
  );
  expect(container.querySelector('a')?.href).not.toContain('devnet');
  await act(async () =>
    container.querySelector('details')!.querySelector('summary')!.click(),
  );
  expect(container.querySelector('details')!.open).toBe(true);
  await click('Load older');
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('cursor'),
  ).toBe(first.nextCursor);
  await respond(1, page([submitted, record(1)]));
  expect(container.textContent).toContain('0 unresolved steps');
  expect(container.querySelector('ol')!.querySelectorAll('li')).toHaveLength(3);
  expect(
    [...container.querySelectorAll('button')].some(
      (value) =>
        value.textContent?.includes('Approve') ||
        value.textContent?.includes('Submit signed'),
    ),
  ).toBe(false);
});
it('aborts obsolete revision and plan requests, ignores late responses and restores history after reopening', async () => {
  await click('Open mainnet');
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(requests[0].signal?.aborted).toBe(true);
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('revision'),
  ).toBe('2');
  await respond(0, page([record(99)]));
  expect(container.textContent).not.toContain('000000000099');
  await act(async () =>
    root.render(
      <MainnetFundingHistoryPanel
        id={other}
        revision={2}
        name="Other funding"
      />,
    ),
  );
  expect(requests[1].signal?.aborted).toBe(true);
  expect(new URL(requests[2].url, 'http://test').searchParams.get('id')).toBe(
    other,
  );
  await click('Close mainnet');
  expect(requests[2].signal?.aborted).toBe(true);
  await respond(2, page([], null, other));
  expect(container.querySelector('ol')).toBeNull();
  await click('Open mainnet');
  expect(requests).toHaveLength(4);
  await respond(3, page([], null, other));
  expect(container.textContent).toContain('No retained mainnet');
});
it('rejects mismatched response evidence and keeps retained records visible through a failed reload', async () => {
  await click('Open mainnet');
  await respond(0, page([record(1)], null, other));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.querySelector('ol')).toBeNull();
  await click('Reload mainnet');
  await respond(1, page([record(1)]));
  expect(container.querySelectorAll('ol li')).toHaveLength(1);
  await click('Reload mainnet');
  await respond(2, { error: 'History storage unavailable.' }, 503);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'history is unavailable',
  );
  expect(container.textContent).toContain('Previously loaded history');
  expect(container.querySelectorAll('ol li')).toHaveLength(1);
});
it('discloses recorded finalization with withheld evidence and excludes it from verified progress', async () => {
  await click('Open mainnet');
  const unverified = {
    ...record(1, 2),
    state: 'finalized' as const,
    evidenceGap:
      'Outcome observation follows this captured transition. The recorded state is retained, but outcome evidence is withheld.',
  };
  const history = page([unverified]);
  history.progress.records = [unverified];
  await respond(0, history);
  expect(container.textContent).toContain(
    'Finalization recorded; delivery evidence unverified',
  );
  expect(container.textContent).toContain('0 verified deliveries');
  expect(container.textContent).toContain(
    'Recorded outcomes without verified evidence: 1',
  );
  expect(container.textContent).toContain(
    'Evidence gap: Outcome observation follows',
  );
  expect(container.textContent).not.toContain('Finalized delivery verified');
  expect(container.textContent).not.toContain('recipient received');
});
it('rejects noncanonical and overflowing atomic units in fetched DTOs', () => {
  for (const value of [
    '01',
    '-1',
    '18446744073709551616',
    '99999999999999999999',
  ])
    expect(() =>
      decodeMainnetFundingHistory(
        page([{ ...record(1), reserveLamports: value }]),
        id,
        null,
      ),
    ).toThrow();
  expect(() =>
    decodeMainnetFundingHistory(
      page([{ ...record(1), reserveLamports: '18446744073709551615' }]),
      id,
      null,
    ),
  ).not.toThrow();
});
it('names a proxy leg receipt without counting it as final allocation delivery', async () => {
  await click('Open mainnet');
  const leg = {
    ...record(1, 2),
    funding: { ...record(1, 2).funding, leg: 1 },
    state: 'finalized' as const,
    signature: 'synthetic-signature',
    receipt: {
      slot: 100,
      observedAt: '2026-10-12T23:59:59.000Z',
      deliveredRaw: '10000000',
      networkFeeLamports: '5000',
      accountRentLamports: '0',
      transferFeeRaw: null,
    },
  };
  const history = page([leg]);
  history.progress.records = [leg];
  await respond(0, history);
  expect(container.textContent).toContain('Proxy leg 1');
  expect(container.textContent).toContain(
    '0 verified deliveries for direct routes',
  );
  expect(container.textContent).toContain('1 verified proxy-leg transfer');
  expect(container.textContent).toContain(
    'Finalized proxy-leg transfer verified',
  );
  expect(container.textContent).toContain('does not by itself prove');
});
it('pages all400 route steps locally while keeping full-scope counts and exact focus', async () => {
  await click('Open mainnet');
  const history = page([]);
  history.progress.records = Array.from({ length: 400 }, (_, i) => ({
    ...record(i + 1, 2),
    funding: {
      ...record(i + 1, 2).funding,
      item: Math.floor(i / 4) + 1,
      leg: (i % 4) + 1,
    },
  }));
  await respond(0, history);
  const rows = () =>
    container.querySelectorAll(
      'ul[aria-label="Mainnet recipient progress"] > li',
    );
  const status = container.querySelector(
    'output[aria-label="Mainnet route progress page"]',
  );
  expect(rows()).toHaveLength(25);
  expect(status?.textContent).toContain('25 of 400');
  expect(container.textContent).toContain('400 unresolved steps');
  for (let n = 2; n <= 16; n++) {
    await click('Next route steps');
    expect(document.activeElement).toBe(status);
    expect(status?.textContent).toContain(`page ${n} of 16`);
    expect(rows()).toHaveLength(25);
  }
  expect(rows()[24].textContent).toContain('Recipient 100');
  expect(rows()[24].textContent).toContain('Proxy leg 4');
  expect(
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Next route steps',
    )?.disabled,
  ).toBe(true);
  await click('Previous route steps');
  expect(status?.textContent).toContain('page 15 of 16');
  expect(document.activeElement).toBe(status);
  expect(requests).toHaveLength(1);
});
it('keeps captured transitions visible without zero-delivery claims when progress is unavailable', async () => {
  await click('Open mainnet');
  const history = page([record(1)]);
  history.progress = { revision: 2, records: null, unavailable: true };
  await respond(0, history);
  expect(
    container.querySelectorAll(
      'ol[aria-label="Mainnet funding transitions"] li',
    ),
  ).toHaveLength(1);
  expect(container.textContent).toContain('Route-step summary is unavailable');
  expect(container.textContent).not.toContain('0 verified deliveries');
  expect(
    container.querySelector('ul[aria-label="Mainnet recipient progress"]'),
  ).toBeNull();
  expect(
    container.querySelector('output[aria-label="Mainnet route progress page"]'),
  ).toBeNull();
});
it('separates direct deliveries and proxy transfers in a mixed revision', async () => {
  await click('Open mainnet');
  const receipt = {
    slot: 100,
    observedAt: '2026-10-12T23:59:59.000Z',
    deliveredRaw: '10000000',
    networkFeeLamports: '5000',
    accountRentLamports: '0',
    transferFeeRaw: null,
  };
  const proxy = {
    ...record(1, 2),
    state: 'finalized' as const,
    funding: { ...record(1, 2).funding, leg: 1 },
    receipt,
  };
  const direct = {
    ...record(2, 2),
    state: 'finalized' as const,
    funding: { ...record(2, 2).funding, item: 2 },
    receipt,
  };
  const history = page([]);
  history.progress.records = [proxy, direct];
  await respond(0, history);
  expect(container.textContent).toContain(
    '1 verified deliveries for direct routes',
  );
  expect(container.textContent).toContain('1 verified proxy-leg transfers');
});

it('rejects HTML and hides parser and server details behind useful status messages', async () => {
  await click('Open mainnet');
  await act(async () =>
    requests[0].resolve(
      new Response('<html>private trace</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.textContent).not.toMatch(
    /private trace|Unexpected token|JSON|<html>/,
  );
  await click('Reload mainnet');
  await respond(1, { error: 'internal-secret-details' }, 401);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Sign in again',
  );
  expect(container.textContent).not.toContain('internal-secret-details');
  await click('Reload mainnet');
  await act(async () =>
    requests[2].resolve(
      new Response('<html>private trace</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.textContent).not.toMatch(
    /private trace|Unexpected token|JSON|<html>/,
  );
});

it('withholds the old revision immediately and keeps no stale counts after a refused new filter', async () => {
  await click('Open mainnet');
  const old = page([record(1)]);
  old.progress.records = [record(1, 2)];
  await respond(0, old);
  expect(container.textContent).toContain('1 unresolved steps');
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('ol')).toBeNull();
  expect(container.textContent).not.toContain('1 unresolved steps');
  await respond(1, { error: 'private internals' }, 503);
  expect(container.querySelector('ol')).toBeNull();
  expect(container.textContent).not.toContain('Previously loaded history');
  expect(container.textContent).not.toContain('private internals');
});

it('keeps every history action out of the parent form submission path', async () => {
  const submitted = vi.fn((event: { preventDefault(): void }) =>
    event.preventDefault(),
  );
  await act(async () =>
    root.render(
      <form onSubmit={submitted}>
        <MainnetFundingHistoryPanel id={id} revision={2} name="Saved funding" />
      </form>,
    ),
  );
  await click('Open mainnet');
  expect(
    [...container.querySelectorAll('button')].every((b) => b.type === 'button'),
  ).toBe(true);
  const history = page([record(1)]);
  history.nextCursor = mainnetFundingHistoryCursor(id, null, 1);
  await respond(0, history);
  expect(button('Load older').type).toBe('button');
  await click('Load older');
  await click('Cancel history loading');
  await click('Reload mainnet');
  await click('Close mainnet');
  expect(submitted).not.toHaveBeenCalled();
});

it('does not move focus when Cancel is activated while another control has focus', async () => {
  await click('Open mainnet');
  const select = container.querySelector('select')!;
  select.focus();
  await click('Cancel history loading');
  expect(document.activeElement).toBe(select);
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'cancelled',
  );
});

it('cancels a hung refresh, retains the last loaded evidence, and ignores its late reply', async () => {
  await click('Open mainnet');
  await respond(0, page([record(1)]));
  await click('Reload mainnet');
  expect(container.textContent).toContain('Previously loaded history');
  button('Cancel history loading').focus();
  await click('Cancel history loading');
  expect(document.activeElement).toBe(button('Reload mainnet'));
  expect(requests[1].signal?.aborted).toBe(true);
  expect(container.textContent).toContain('History loading cancelled');
  expect(button('Reload mainnet').disabled).toBe(false);
  await respond(1, page([record(99)]));
  expect(container.querySelectorAll('ol li')).toHaveLength(1);
  expect(container.textContent).not.toContain('000000000099');
  await click('Reload mainnet');
  await respond(2, page([record(2)]));
  expect(container.textContent).not.toContain('Previously loaded history');
  expect(container.textContent).not.toContain('History loading cancelled');
  expect(container.textContent).toContain('000000000002');
});

it('ends a never-resolving request at15seconds without retrying or accepting a late result', async () => {
  vi.useFakeTimers();
  await click('Open mainnet');
  await act(async () => vi.advanceTimersByTimeAsync(14999));
  expect(container.textContent).toContain('Loading mainnet funding history');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(requests[0].signal?.aborted).toBe(true);
  expect(container.textContent).toContain('History loading timed out');
  expect(button('Reload mainnet').disabled).toBe(false);
  expect(requests).toHaveLength(1);
  await respond(0, page([record(99)]));
  expect(container.querySelector('ol')).toBeNull();
  expect(container.textContent).not.toContain('000000000099');
});

it('restores disappearing Cancel focus on timeout without stealing focus from another control', async () => {
  vi.useFakeTimers();
  await click('Open mainnet');
  button('Cancel history loading').focus();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(document.activeElement).toBe(button('Reload mainnet'));
  await click('Reload mainnet');
  const select = container.querySelector('select')!;
  select.focus();
  await respond(1, page([]));
  expect(document.activeElement).toBe(select);
});

it('cancels a stalled response body on deadline and refuses over1MiB rather than rendering it', async () => {
  vi.useFakeTimers();
  await click('Open mainnet');
  const cancel = vi.fn();
  await act(async () =>
    requests[0].resolve(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(cancel).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('History loading timed out');
  await click('Reload mainnet');
  // This is otherwise a valid DTO, so only the byte bound may refuse it.
  const oversized = { ...page([record(1)]), name: 'x'.repeat(1048577) };
  expect(() => decodeMainnetFundingHistory(oversized, id, null)).not.toThrow();
  await respond(1, oversized);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(container.querySelector('ol')).toBeNull();
  expect(button('Reload mainnet').disabled).toBe(false);
});

it.each(['failure', 'cancel', 'timeout'] as const)(
  'retains merged pages and the exact next cursor after an older-page %s',
  async (outcome) => {
    vi.useFakeTimers();
    await click('Open mainnet');
    const first = page([record(3), record(2)]);
    first.nextCursor = mainnetFundingHistoryCursor(id, null, 2);
    await respond(0, first);
    await click('Load older');
    const older = page([record(1)]);
    older.nextCursor = mainnetFundingHistoryCursor(id, null, 1);
    await respond(1, older);
    const retained = container.querySelector('ol')!.textContent;
    await click('Load older');
    expect(
      new URL(requests[2].url, 'http://test').searchParams.get('cursor'),
    ).toBe(older.nextCursor);
    if (outcome === 'failure') await respond(2, { error: 'private' }, 503);
    else if (outcome === 'cancel') await click('Cancel history loading');
    else await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(container.querySelector('ol')!.textContent).toBe(retained);
    expect(container.textContent).toContain('Previously loaded history');
    expect(button('Load older').disabled).toBe(false);
    if (outcome !== 'failure') {
      await respond(2, page([record(99)]));
      expect(container.querySelector('ol')!.textContent).toBe(retained);
    }
    await click('Load older');
    expect(
      new URL(requests[3].url, 'http://test').searchParams.get('cursor'),
    ).toBe(older.nextCursor);
    await respond(3, page([record(1)]));
    expect(container.querySelector('ol')!.textContent).toBe(retained);
    expect(container.textContent).toContain(
      'retains previously loaded transition pages',
    );
    expect(container.querySelectorAll('ol li')).toHaveLength(3);
  },
);

it('discards an older-page reply after the selected revision changes', async () => {
  await click('Open mainnet');
  const first = page([record(2)]);
  first.nextCursor = mainnetFundingHistoryCursor(id, null, 2);
  await respond(0, first);
  await click('Load older');
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(requests[1].signal?.aborted).toBe(true);
  await respond(1, page([record(99)]));
  expect(container.querySelector('ol')).toBeNull();
  await respond(2, page([], 2));
  expect(container.textContent).not.toContain('000000000099');
  expect(container.querySelectorAll('ol li')).toHaveLength(0);
});

it.each(['close', 'unmount'] as const)(
  'clears its deadline and ignores late replies on %s mid-load',
  async (action) => {
    vi.useFakeTimers();
    await click('Open mainnet');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    if (action === 'close') await click('Close mainnet');
    else await act(async () => root.render(null));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    await respond(0, page([record(99)]));
    expect(container.textContent).not.toMatch(/timed out|000000000099/);
    expect(requests).toHaveLength(1);
  },
);

it.each([403, 404, 429])(
  'uses a safe actionable message for HTTP%d',
  async (status) => {
    await click('Open mainnet');
    await respond(0, { error: 'private diagnostics' }, status);
    expect(container.textContent).not.toContain('private diagnostics');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      status === 429
        ? 'Wait before reloading'
        : 'Reopen the saved funding plan',
    );
  },
);

it('hands focused read actions to Cancel and returns to Reload even when the last older-page button disappears', async () => {
  await click('Open mainnet');
  const first = page([record(2)]);
  first.nextCursor = mainnetFundingHistoryCursor(id, null, 2);
  await respond(0, first);
  button('Reload mainnet').focus();
  await click('Reload mainnet');
  expect(document.activeElement).toBe(button('Cancel history loading'));
  await respond(1, first);
  expect(document.activeElement).toBe(button('Reload mainnet'));
  button('Load older').focus();
  await click('Load older');
  expect(document.activeElement).toBe(button('Cancel history loading'));
  await respond(2, page([record(1)]));
  expect(document.activeElement).toBe(button('Reload mainnet'));
  expect(
    [...container.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('Load older'),
    ),
  ).toBe(false);
});

it('issues exactly one on-open request under StrictMode', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MainnetFundingHistoryPanel id={id} revision={2} name="Saved funding" />
      </StrictMode>,
    ),
  );
  await click('Open mainnet');
  expect(requests).toHaveLength(1);
  await respond(0, page([]));
  expect(requests).toHaveLength(1);
});
