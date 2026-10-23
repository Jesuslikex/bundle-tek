// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WalletWarmup } from './wallet-warmup';
import { warmupUiFixture } from '../test/warmup-ui-fixture';
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof warmupUiFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = warmupUiFixture();
  vi.stubGlobal('fetch', vi.fn(fixture.fetcher));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[fixture.wallet]}
        walletRevisions={[{ address: fixture.wallet, revision: 1 }]}
        onClose={() => {}}
      />,
    ),
  );
}
async function click(text: string) {
  const b = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )!;
  expect(b, text).toBeTruthy();
  await act(async () => b.click());
}
it('opens a compact activity dialog with secondary history and saved controls', async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[fixture.wallet]}
        walletRevisions={[{ address: fixture.wallet, revision: 1 }]}
        onClose={close}
      />,
    ),
  );
  const dialog = host.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(host.querySelector('h3')?.textContent).toBe('Generate Activity');
  const secondary = [...host.querySelectorAll('details')].filter((detail) =>
    ['Wallet history · read only', 'Saved plans and recovery'].includes(
      detail.querySelector('summary')?.textContent ?? '',
    ),
  );
  expect(secondary).toHaveLength(2);
  expect(secondary.every((detail) => !detail.open)).toBe(true);
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  await act(async () => {
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  expect(close).toHaveBeenCalledOnce();
});
it('reviews and saves a USDC draft with a fresh start without manually finding a mint or date', async () => {
  await mount();
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  expect(
    host.querySelector('textarea')!.closest('details')!.hasAttribute('open'),
  ).toBe(false);
  await click('Use USDC');
  await click('Review warmup plan');
  expect(host.textContent).toContain('0.013 SOL');
  await click('Save draft');
  expect(fixture.plan.document.tokens).toEqual([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ]);
  expect(Date.parse(fixture.plan.document.startAt)).toBe(
    Date.now() + 30 * 60000,
  );
  expect(host.textContent).toContain('No swaps scheduled');
  const advanced = Array.from(host.querySelectorAll('details')).find(
    (d) =>
      d.querySelector('summary')?.textContent === 'Transactions and recovery',
  )!;
  expect(advanced.open).toBe(false);
  const quote = Array.from(host.querySelectorAll('details')).find(
    (d) => d.querySelector('summary')?.textContent === 'Optional market quote',
  )!;
  expect(quote.open).toBe(false);
  const archive = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === 'Archive',
  )!;
  expect(archive.closest('details')?.open).toBe(false);
  const fullSchedule = host.querySelector<HTMLDetailsElement>(
    '[aria-label="Warmup plan review"]',
  )!;
  expect(fullSchedule.open).toBe(false);
  expect(
    fixture.calls.some(
      (c) =>
        ['register', 'submit'].includes(c.action ?? '') ||
        c.path.endsWith('/prepare'),
    ),
  ).toBe(false);
});
it('refreshes an expired saved draft explicitly and requires review before any new save', async () => {
  await mount();
  await click('Use USDC');
  await click('Review warmup plan');
  await click('Save draft');
  await act(async () => vi.advanceTimersByTime(31 * 60000));
  await click('Reload drafts');
  const before = fixture.calls.filter((c) => c.action === 'save').length;
  await click('Review with fresh start');
  expect(host.textContent).toContain('Fresh start selected');
  expect(fixture.calls.filter((c) => c.action === 'save')).toHaveLength(before);
  const save = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent === 'Save changes',
  )!;
  expect(save.disabled).toBe(true);
  await click('Review warmup plan');
  await click('Save changes');
  expect(Date.parse(fixture.plan.document.startAt)).toBe(
    Date.now() + 30 * 60000,
  );
});
it('reveals token entry after review refuses an empty selection, without any mutation', async () => {
  await mount();
  await click('Review warmup plan');
  expect(
    host.querySelector('textarea')!.closest('details')!.hasAttribute('open'),
  ).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
});
it.each([
  ['amount', 'amount', false],
  ['feeReserve', 'feeReserve', true],
] as const)(
  'focuses the invalid %s without opening custom tokens',
  async (property, field, opensOptions) => {
    fixture.plan.document[property] = 'not-a-number';
    fixture.plan.document.startAt = new Date(
      Date.now() + 3600000,
    ).toISOString();
    await act(async () =>
      root.render(
        <WalletWarmup
          chain="Solana"
          addresses={[fixture.wallet]}
          walletRevisions={[{ address: fixture.wallet, revision: 1 }]}
          onClose={() => {}}
          initialPlan={fixture.plan}
        />,
      ),
    );
    await click('Review warmup plan');
    const input = host.querySelector<HTMLInputElement>(
      `[data-warmup-field="${field}"]`,
    )!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(
      host.querySelector('[role=alert]')!.id,
    );
    expect(
      host.querySelector('textarea')!.closest('details')!.hasAttribute('open'),
    ).toBe(false);
    expect(
      host.querySelector('[data-warmup-field=feeReserve]')!.closest('details')!
        .open,
    ).toBe(opensOptions);
    expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  },
);

it('opens a collapsed options section when native input validation needs correction', async () => {
  await mount();
  const label = Array.from(host.querySelectorAll('label')).find((l) =>
    l.textContent?.includes('Fee reserve per wallet'),
  )!;
  const input = label.querySelector('input')!;
  const details = input.closest('details')!;
  expect(details.open).toBe(false);
  await act(async () =>
    input.dispatchEvent(
      new Event('invalid', { bubbles: false, cancelable: true }),
    ),
  );
  expect(details.open).toBe(true);
});
it('routes an expired saved start to timing and recovers without saving automatically', async () => {
  fixture.plan.document.startAt = new Date(Date.now() - 60000).toISOString();
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[fixture.wallet]}
        walletRevisions={[{ address: fixture.wallet, revision: 1 }]}
        onClose={() => {}}
        initialPlan={fixture.plan}
      />,
    ),
  );
  await click('Review warmup plan');
  const start = host.querySelector<HTMLInputElement>(
    'input[type="datetime-local"]',
  )!;
  expect(start.closest('details')!.open).toBe(true);
  expect(document.activeElement).toBe(start);
  expect(
    host.querySelector('textarea')!.closest('details')!.hasAttribute('open'),
  ).toBe(false);
  expect(start.getAttribute('aria-invalid')).toBe('true');
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'next 30 days',
  );
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  await click('Start in 5 minutes');
  await click('Review warmup plan');
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(start.getAttribute('aria-invalid')).not.toBe('true');
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
});
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('reviews and saves Proxima-style range amounts with a seconds delay', async () => {
  await mount();
  await click('Use USDC');
  await click('Range');
  const max = host.querySelector<HTMLInputElement>(
    'input[aria-label="Maximum amount"]',
  )!;
  const minutes = host.querySelector<HTMLInputElement>(
    'input[aria-label="Delay minutes"]',
  )!;
  const seconds = host.querySelector<HTMLInputElement>(
    'input[aria-label="Delay seconds"]',
  )!;
  await act(async () => {
    type(max, '0.002');
    type(minutes, '0');
    type(seconds, '45');
  });
  // 3 loops x 0.002 upper bound + 0.01 reserve for one wallet.
  expect(host.textContent).toContain('Required (max): 0.016 SOL');
  expect(host.textContent).toContain('Estimated: 1m 53s');
  await click('Review warmup plan');
  expect(host.textContent).toContain('drawn between 0.001 and 0.002 SOL');
  await click('Save draft');
  const doc = fixture.plan.document;
  expect(doc.amountMax).toBe('0.002');
  expect(doc.intervalSeconds).toBe(45);
  expect(doc.intervalMinutes).toBeUndefined();
  expect(doc.amounts).toHaveLength(1);
  expect(doc.amounts![0]).toHaveLength(3);
  for (const a of doc.amounts![0]) {
    expect(Number(a)).toBeGreaterThanOrEqual(0.001);
    expect(Number(a)).toBeLessThanOrEqual(0.002);
  }
});

it('compares funding inside the real dialog without changing draft fields or saving approval', async () => {
  const requestUrl = (input: RequestInfo | URL) =>
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const originalFetcher = fixture.fetcher;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input) !== '/api/wallet-workspace/funding-times')
        return originalFetcher(input, init);
      return Response.json({
        format: 'wallet-funding-times-v1',
        network: 'mainnet',
        scope: 'most-recently-saved-native-transfer',
        capturedAt: '2026-10-18T12:00:00.000Z',
        executionAllowed: false,
        wallets: [
          {
            address: fixture.wallet,
            revision: 1,
            funding: null,
            reason: 'no-retained-receipt',
          },
        ],
      });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  const fields = () =>
    [
      ...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input,textarea',
      ),
    ].map((el) => ({
      id: el.id,
      value: el.value,
      checked: 'checked' in el ? el.checked : null,
    }));
  const before = fields();
  expect(
    fetcher.mock.calls.some(([url]) => requestUrl(url).includes('funding-')),
  ).toBe(false);
  await click('Check recorded funding times');
  expect(host.textContent).toContain('1 unknown');
  expect(host.textContent).toContain(
    'No retained successful native SOL receipt was found.',
  );
  expect(fields()).toEqual(before);
  const posts = fetcher.mock.calls.filter(
    ([, init]) => init?.method === 'POST',
  );
  expect(posts).toHaveLength(1);
  expect(requestUrl(posts[0][0])).toBe('/api/wallet-workspace/funding-times');
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({
    wallets: [{ address: fixture.wallet, revision: 1 }],
  });
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
});
