// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupUiFixture } from '../test/warmup-ui-fixture';
const mocks = vi.hoisted(() => ({ sign: vi.fn(), unlock: vi.fn() }));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'warmup-test-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/warmup-signing', async (original) => ({
  ...(await original<typeof import('@/lib/warmup-signing')>()),
  signApprovedWarmupPacket: mocks.sign,
}));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => [], on: () => () => {} }),
}));
import { WarmupCycleWorkflow } from './warmup-cycle-workflow';
import { WarmupApprovedSigning } from './warmup-approved-signing';
import { WarmupSigningRecovery } from './warmup-signing-recovery';
import { WalletWarmup } from './wallet-warmup';
let root: Root,
  container: HTMLDivElement,
  fixture: ReturnType<typeof warmupUiFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = warmupUiFixture();
  vi.stubGlobal('fetch', vi.fn(fixture.fetcher));
  mocks.unlock
    .mockReset()
    .mockImplementation(async () => ({ payload: { wallets: [] } }));
  mocks.sign
    .mockReset()
    .mockImplementation(
      async (_session, review: { inputMint: string }, assert: () => void) => {
        assert();
        return {
          transaction: 'INVALID_FIXTURE_PACKET',
          signature: `FIXTURE_SIGNATURE_${review.inputMint === 'So11111111111111111111111111111111111111112' ? 'Buy' : 'Sell'}`,
        };
      },
    );
  localStorage.setItem('warmup-test-vault', 'SYNTHETIC_NOT_A_VAULT');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem('warmup-test-vault');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(canReview = true) {
  await act(async () =>
    root.render(
      <WarmupCycleWorkflow plan={fixture.plan} canReview={canReview} />,
    ),
  );
}
function button(text: string) {
  const value = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  expect(value, text).toBeTruthy();
  return value!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function check(fragment: string) {
  const label = Array.from(container.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(fragment),
  );
  const input = label?.querySelector<HTMLInputElement>('input[type=checkbox]');
  expect(input).toBeTruthy();
  await act(async () => input!.click());
}
async function sign(side: 'Buy' | 'Sell') {
  await click('Check eligibility for user approval');
  expect(button('Approve and sign this exact transaction').disabled).toBe(true);
  await check('I reviewed the network');
  expect(container.textContent).toContain('Enter the browser-vault passphrase');
  const password = container.querySelector<HTMLInputElement>(
    'input[type=password]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(password, 'fixture-only');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Approve and sign this exact transaction');
  expect(container.textContent).toContain(`FIXTURE_SIGNATURE_${side}`);
  expect(button('Submit this signed transaction to mainnet').disabled).toBe(
    true,
  );
}
async function submitAndVerify(side: 'Buy' | 'Sell') {
  await check('I approve sending this exact signed warmup');
  await click('Submit this signed transaction to mainnet');
  expect(container.querySelector('[aria-current=step]')?.textContent).toContain(
    'Verify receipt',
  );
  await click(`Verify finalized ${side.toLowerCase()} receipt`);
}
it('opens recovery from a blocked cycle and refreshes progress after cancellation', async () => {
  fixture.scenario('recovery');
  await mount();
  await click('Open cycle progress');
  expect(container.textContent).toContain('1 active approvals');
  expect(
    Array.from(container.querySelectorAll('button')).some(
      (b) => b.textContent === 'Review buy',
    ),
  ).toBe(false);
  await click('Open approval recovery');
  expect(
    fixture.calls.filter(
      (c) => c.path.includes('/signing') && c.method === 'GET',
    ),
  ).toHaveLength(1);
  await click('Cancel this unsigned approval');
  expect(container.textContent).toContain('0 active approvals');
  expect(button('Review buy')).toBeTruthy();
});
it('takes selected wallets through history, plan review, save and reopening without scheduling', async () => {
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
  expect(button('Save draft').disabled).toBe(true);
  expect(container.textContent).toContain(
    'Review your draft above to enable Save',
  );
  await click('Check wallet history');
  expect(container.textContent).toContain('Wallet age: unknown');
  const tokens = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(tokens, fixture.plan.document.tokens[0]);
    tokens.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Start in 5 minutes');
  await click('Review warmup plan');
  expect(button('Save draft').disabled).toBe(false);
  await click('Save draft');
  expect(container.textContent).toContain(
    'Warmup plan saved. No swaps scheduled.',
  );
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(0);
  await click('Edit draft');
  expect(button('Save changes').disabled).toBe(true);
});
it('shows a usable wallet-history error when the entry screen receives HTML', async () => {
  fixture.scenario('html');
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
  await click('Check wallet history');
  expect(container.textContent).toContain(
    'Wallet history unavailable. Try checking again.',
  );
  expect(container.textContent).not.toContain('Unexpected token');
});
it('explains an unfunded wallet without funding, signing or starting trades', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetcher(input, init);
      if (input === '/api/wallet-workspace/warmup') {
        const data = (await response.json()) as {
          results: Array<{
            observation: {
              nativeBalance: string;
              sampleCount: number;
              successfulSampleCount: number;
            };
          }>;
        };
        data.results[0].observation.nativeBalance = '0';
        data.results[0].observation.sampleCount = 0;
        data.results[0].observation.successfulSampleCount = 0;
        return Response.json(data);
      }
      return response;
    }),
  );
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
  expect(container.textContent).toContain('Saving a draft starts no trades');
  await click('Check wallet history');
  expect(container.textContent).toContain('Your wallet is unfunded');
  expect(container.textContent).toContain('0 sampled signatures, 0 successful');
  expect(container.textContent).toContain(
    'You can still save and check a draft',
  );
  const activity = Array.from(container.querySelectorAll('details')).find(
    (d) =>
      d.querySelector('summary')?.textContent === 'Wallet activity details',
  )!;
  expect(activity.open).toBe(false);
  expect(activity.textContent).toContain('Wallet age: unknown');
  expect(button('Save draft').disabled).toBe(true);
  expect(
    fixture.calls.filter((call) =>
      ['submit', 'register'].includes(call.action ?? ''),
    ),
  ).toHaveLength(0);
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.unlock).not.toHaveBeenCalled();
});
it('walks buy through separate signing/send approvals, receipt, matched sell and completed progress', async () => {
  await mount();
  await click('Prepare unsigned warmup buy');
  await sign('Buy');
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(0);
  await click('Submit this signed transaction to mainnet');
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(0);
  await submitAndVerify('Buy');
  await click('Review sell of this warmup buy');
  expect(container.textContent).toContain('No buy lot selected');
  await click('Use matched buy amount');
  await click('Prepare unsigned warmup sell');
  await sign('Sell');
  await submitAndVerify('Sell');
  await click('Open cycle progress');
  expect(container.textContent).toContain('1/1 wallet cycles');
  expect(container.textContent).toContain('Recorded lots sold');
  expect(mocks.sign).toHaveBeenCalledTimes(2);
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(2);
});
it('clears send consent on page invalidation and retains receipt recovery after expiry', async () => {
  await mount();
  await click('Prepare unsigned warmup buy');
  await sign('Buy');
  await check('I approve sending this exact signed warmup');
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(button('Submit this signed transaction to mainnet').disabled).toBe(
    true,
  );
  await act(async () => vi.advanceTimersByTime(300001));
  expect(container.textContent).toContain('This signed packet has expired');
  expect(button('Verify finalized buy receipt').disabled).toBe(false);
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(0);
});
it('does not offer new preparation for archived plans or a mismatched wallet selection', async () => {
  await mount(false);
  expect(container.textContent).toContain('Select this saved plan’s wallets');
  expect(
    container.querySelector('[aria-label="Warmup unsigned preparation"]'),
  ).toBeNull();
  fixture.plan.archived = true;
  await mount();
  expect(container.textContent).toContain('This plan is archived');
});
it('shows usable errors for HTML on progress, preparation and approval recovery', async () => {
  fixture.scenario('html');
  await mount();
  await click('Open cycle progress');
  await click('Prepare unsigned warmup buy');
  expect(container.textContent).toContain(
    'Recorded cycle progress unavailable',
  );
  expect(container.textContent).toContain('Warmup preparation unavailable');
  expect(container.textContent).not.toMatch(
    /Unexpected token|Response.*json|<html>/,
  );
  const side = Array.from(container.querySelectorAll('select')).find((select) =>
    Array.from(select.options).some((option) => option.value === 'Sell'),
  )!;
  await act(async () => {
    side.value = 'Sell';
    side.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Buy receipt history unavailable');
  await click('Prepare unsigned warmup sell');
  expect(container.textContent).toContain('Warmup sell review unavailable');
  await act(async () =>
    root.render(<WarmupSigningRecovery preparationId="fixture-preparation" />),
  );
  await click('Read approval status');
  expect(container.textContent).toContain('Approval recovery unavailable');
  expect(container.textContent).not.toContain('Unexpected token');
});
it('keeps an uncertain send on recovery without sending or signing again', async () => {
  await mount();
  await click('Prepare unsigned warmup buy');
  await sign('Buy');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetcher(input, init);
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { action?: string })
          : {};
      if (body.action === 'submit')
        throw new Error('Synthetic lost submission response.');
      return response;
    }),
  );
  await check('I approve sending this exact signed warmup');
  await click('Submit this signed transaction to mainnet');
  expect(container.textContent).toContain(
    'Outcome unknown; recover the original signature',
  );
  expect(container.querySelector('[aria-current=step]')?.textContent).toContain(
    'Verify receipt',
  );
  expect(button('Verify finalized buy receipt').disabled).toBe(false);
  expect(fixture.calls.filter((c) => c.action === 'submit')).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledTimes(1);
});
it('masks a review HTML failure without exposing signing controls', async () => {
  await mount();
  await click('Prepare unsigned warmup buy');
  fixture.scenario('html');
  await click('Check eligibility for user approval');
  expect(container.textContent).toContain(
    'Approval unavailable. Keep any registered signature for recovery.',
  );
  expect(container.textContent).not.toContain('Unexpected token');
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('keeps exact-packet mismatch refusal and never exposes signing for a failed simulation', async () => {
  await mount();
  await click('Prepare unsigned warmup buy');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        review: { ...fixture.review('Buy'), sha256: 'wrong-packet' },
      }),
    ),
  );
  await click('Check eligibility for user approval');
  expect(container.textContent).toContain(
    'Approval differs from the displayed preparation',
  );
  expect(mocks.sign).not.toHaveBeenCalled();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const data = fixture.preparation('Buy');
      data.simulation.succeeded = false;
      return Response.json(data);
    }),
  );
  await click('Prepare unsigned warmup buy');
  expect(container.textContent).toContain('RPC simulation failed');
  expect(
    container.querySelector('[aria-label="User approved warmup signing"]'),
  ).toBeNull();
});
it('leaves imported-swap presentation outside the new warmup-only step indicator', async () => {
  await act(async () =>
    root.render(
      <WarmupApprovedSigning
        projectId="fixture-project"
        preparationId="fixture-preparation"
        order={fixture.order('Buy')}
        reviewNotBefore={Date.now()}
      />,
    ),
  );
  expect(
    container.querySelector('[aria-label="Warmup transaction steps"]'),
  ).toBeNull();
});

it('lets a stalled history read time out, then retries only on user request', async () => {
  const original = fixture.fetcher;
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/wallet-workspace/warmup' && ++reads === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return original(input, init);
    }),
  );
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
  await click('Check wallet history');
  expect(
    container.querySelector('output[aria-live=polite]')?.textContent,
  ).toContain('does not start warmup');
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(container.textContent).toContain('Wallet history took too long');
  expect(button('Check wallet history').disabled).toBe(false);
  expect(reads).toBe(1);
  await click('Check wallet history');
  expect(reads).toBe(2);
  expect(container.textContent).toContain('Wallet age: unknown');
  expect(container.textContent).not.toContain('took too long');
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.unlock).not.toHaveBeenCalled();
});
it('cancels a pending history read and refuses its late result', async () => {
  let finish!: (response: Response) => void;
  const original = fixture.fetcher;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      input === '/api/wallet-workspace/warmup'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    ),
  );
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
  await click('Check wallet history');
  await click('Cancel history check');
  expect(button('Check wallet history').disabled).toBe(false);
  await act(async () =>
    finish(
      await original('/api/wallet-workspace/warmup', {
        method: 'POST',
        body: JSON.stringify({ chain: 'Solana', addresses: [fixture.wallet] }),
      }),
    ),
  );
  expect(container.textContent).not.toContain('Wallet age: unknown');
  expect(container.textContent).toContain('History check cancelled');
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.unlock).not.toHaveBeenCalled();
});
