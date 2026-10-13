// @vitest-environment jsdom
import { act } from 'react';
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
    '0 verified deliveries · 1 unresolved',
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
    'storage unavailable',
  );
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
