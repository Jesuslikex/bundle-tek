// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AccountLaunchPaymentsPanel } from './account-launch-payments';
import { accountLaunchPaymentsFixture as fixture } from '@/test/account-launch-payments-fixture';
import type { AccountLaunchPayments } from '@/lib/account-launch-payments';
let host: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (value: AccountLaunchPayments | undefined) => {
  await act(async () =>
    root.render(<AccountLaunchPaymentsPanel value={value} />),
  );
};
it('starts collapsed, performs no requests and separates exact buy, funding and fee amounts', async () => {
  await render(fixture);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => host.querySelector('summary')!.click());
  expect(host.textContent).toContain('Wallet debits reconciled');
  expect(host.textContent).toContain('0.000001 SOL');
  expect(host.textContent).toContain('0.0035 SOL');
  expect(host.textContent).toContain('0.000005 SOL');
  expect(host.textContent).toContain(
    'No acquisition cost or launch profit is assigned',
  );
  expect(host.querySelectorAll('details')[1].open).toBe(false);
});
it('does not show unavailable buy or setup amounts as zero when only packet fees are known', async () => {
  await render({
    ...fixture,
    packets: [
      {
        index: 0,
        outcome: 'success',
        verified: false,
        reason: 'instruction-metadata-missing',
        networkFeeLamports: '5000',
        wallets: [],
      },
    ],
    verifiedPacketCount: 0,
    purchaseQuoteSubtotalRaw: '0',
    accountFundingSubtotalLamports: '0',
    complete: false,
  });
  expect(host.textContent).toContain(
    'Purchase and setup amounts are unavailable',
  );
  expect(host.textContent).toContain('0.000005 SOL');
  expect(host.querySelector('dl')).toBeNull();
  expect(host.textContent).toContain(
    'provider did not include the instruction metadata',
  );
});
it('preserves large token-quote values without silently converting them into SOL', async () => {
  const amount = '123456789123456789';
  await render({
    ...fixture,
    quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    quoteDecimals: 6,
    purchaseQuoteSubtotalRaw: amount,
    packets: [
      {
        ...fixture.packets[0],
        wallets: [
          { ...fixture.packets[0].wallets[0], purchaseQuoteRaw: amount },
        ],
      },
    ],
  });
  expect(host.textContent).toContain('123456789123.456789 quote tokens');
  expect(host.textContent).not.toContain('123456789123.456789 SOL');
  expect(host.textContent).toContain('Amounts stay in that asset’s units');
});
it('keeps partial subtotals and missing-packet reasons explicit and handles older summaries', async () => {
  await render({
    ...fixture,
    packets: [
      ...fixture.packets,
      {
        index: 1,
        outcome: 'not-observed',
        verified: false,
        reason: 'receipt-unobserved',
        networkFeeLamports: null,
        wallets: [],
      },
    ],
    complete: false,
  });
  expect(host.textContent).toContain('Known buy quote subtotal');
  expect(host.textContent).toContain('(known subtotal)');
  expect(host.textContent).toContain('No finalized receipt is saved');
  await render(undefined);
  expect(host.textContent).toContain('Reload saved evidence');
  expect(host.querySelector('dl')).toBeNull();
});
