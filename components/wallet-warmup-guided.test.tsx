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
async function start() {
  const volume = host.querySelector<HTMLInputElement>(
    '[data-warmup-field="amount"]',
  )!;
  if (!volume.value) {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(volume, '0.01');
    volume.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await click('Start activity on 1 wallet');
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
  expect(host.querySelector('h3')?.textContent).toBe('Wallet warmup');
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
  await start();
  expect(host.textContent).toContain('0.02 SOL');
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
  await start();
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
  await start();
  await click('Save changes');
  expect(Date.parse(fixture.plan.document.startAt)).toBe(
    Date.now() + 30 * 60000,
  );
});
it('reveals token entry after review refuses an empty selection, without any mutation', async () => {
  await mount();
  const area = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(area, '');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await start();
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
    await start();
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
      host.querySelector('[data-warmup-field=feeReserve]')!.closest('details'),
    ).toBeNull();
    expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  },
);

it('opens the max loss input from the main form when native validation needs correction', async () => {
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
  const input = host.querySelector<HTMLInputElement>(
    '[data-warmup-field="feeReserve"]',
  )!;
  expect(input.closest('details')).toBeNull();
  expect(input.getAttribute('data-warmup-field')).toBe('feeReserve');
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
  await start();
  const startInput = host.querySelector<HTMLInputElement>(
    'input[type="datetime-local"]',
  )!;
  expect(startInput.closest('details')!.open).toBe(true);
  expect(document.activeElement).toBe(startInput);
  expect(
    host.querySelector('textarea')!.closest('details')!.hasAttribute('open'),
  ).toBe(false);
  expect(startInput.getAttribute('aria-invalid')).toBe('true');
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'next 30 days',
  );
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
  await click('Start in 5 minutes');
  await start();
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(startInput.getAttribute('aria-invalid')).not.toBe('true');
  expect(fixture.calls.every((c) => c.method === 'GET')).toBe(true);
});
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('reviews and saves a Proxima-style volume target with duration and transactions per day', async () => {
  await mount();
  await click('Use USDC');
  const volume = host.querySelector<HTMLInputElement>(
    '[data-warmup-field="amount"]',
  )!;
  const duration = host.querySelector<HTMLInputElement>(
    '[data-warmup-field="cycles"]',
  )!;
  const min = host.querySelector<HTMLInputElement>(
    '[aria-label="Minimum transactions per day"]',
  )!;
  const max = host.querySelector<HTMLInputElement>(
    '[aria-label="Maximum transactions per day"]',
  )!;
  expect(min.value).toBe('20');
  expect(max.value).toBe('40');
  await act(async () => {
    type(volume, '0.03');
    type(duration, '2');
    type(min, '20');
    type(max, '40');
  });
  // 30 transactions a day is a 48 minute delay, so two hours is three cycles
  // and 0.03 SOL over one wallet and three cycles is 0.01 SOL a buy.
  expect(host.textContent).toContain('Volume 0.03 SOL');
  expect(host.textContent).toContain('Cost ~0.04 SOL');
  expect(host.textContent).toContain('2h, around the clock');
  await start();
  await click('Save draft');
  const doc = fixture.plan.document;
  expect(doc.amount).toBe('0.01');
  expect(doc.cycles).toBe(3);
  expect(doc.intervalSeconds).toBe(2880);
  expect(doc.amountMax).toBeUndefined();
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

it('draws an organic schedule at review and saves the reviewed draws', async () => {
  await mount();
  await click('Use USDC');
  const organic = host.querySelector<HTMLInputElement>(
    'input[type="radio"][value="organic"]',
  )!;
  expect(organic.checked).toBe(false);
  expect(
    host.querySelector('[aria-label="Cadence jitter percent"]'),
  ).toBeNull();
  await act(async () => organic.click());
  expect(organic.checked).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Cadence jitter percent"]',
    )!.value,
  ).toBe('30');
  await start();
  expect(host.textContent).toContain('Organic timing');
  expect(host.textContent).toContain('30% cadence jitter');
  await click('Save draft');
  const document = fixture.plan.document;
  expect(document.organicTerms).toEqual({
    jitterPercent: 30,
    holdMinSeconds: 60,
    holdMaxSeconds: 600,
    skipPercent: 25,
    randomTokens: true,
  });
  // One wallet, three loops: the first loop is always kept, so between one and
  // three buys survive the skip draw and each keeps its own sell.
  const buys = document.organic!.skips[0].filter((skip) => !skip).length;
  expect(buys).toBeGreaterThanOrEqual(1);
  expect(buys).toBeLessThanOrEqual(8);
  expect(document.organic!.offsets[0]).toHaveLength(8);
  expect(document.organic!.holds[0]).toHaveLength(8);
});

it('rejects an organic hold that cannot fit inside the delay', async () => {
  await mount();
  await click('Use USDC');
  await act(async () =>
    (
      host.querySelector<HTMLInputElement>('input[type="radio"][value="organic"]')!
    ).click(),
  );
  const longest = host.querySelector<HTMLInputElement>(
    '[aria-label="Longest hold in seconds"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(longest, '9000');
    longest.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await start();
  expect(host.textContent).toContain('fit inside the cycle delay');
});

it('offers routing and wallet order, and reflects Axiom in the fee hint', async () => {
  await mount();
  const platform = host.querySelector(
    '[data-warmup-field="platform"]',
  ) as unknown as HTMLSelectElement;
  const schedule = host.querySelector(
    '[data-warmup-field="schedule"]',
  ) as unknown as HTMLSelectElement;
  expect(platform.value).toBe('none');
  expect(schedule.value).toBe('staggered');
  expect(Array.from(platform.options).map((o) => o.value)).toEqual([
    'none',
    'axiom',
  ]);
  expect(Array.from(schedule.options).map((o) => o.value)).toEqual([
    'staggered',
    'sequential',
  ]);
  expect(host.textContent).toContain('reviewed direct swap route');
  await act(async () => {
    platform.value = 'axiom';
    platform.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('declared intent');
  expect(host.textContent).toContain('Confirm the real route on chain');
});

it('picks wallets from the roster through the Wallets field', async () => {
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[]}
        walletRevisions={[]}
        onClose={() => {}}
        roster={[
          { address: fixture.wallet, label: 'Test A seller' },
          { address: '7gAmms23jNJW17V8PnbRm4FwXW5UxGc4abFiDAcSFUx9', label: 'Test B buyer' },
        ]}
        onSelect={onSelect}
      />,
    ),
  );
  expect(host.textContent).toContain('Select the wallets to put to work.');
  expect(host.textContent).toContain('Complete the plan to start');
  await click('Select wallets');
  const boxes = Array.from(
    host.querySelectorAll<HTMLInputElement>('[role="dialog"] input'),
  );
  expect(boxes).toHaveLength(2);
  await act(async () => boxes[0].click());
  expect(onSelect).toHaveBeenCalledWith([fixture.wallet]);
  await click('Done');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
