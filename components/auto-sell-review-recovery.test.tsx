// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AutoSellReviewRecovery } from './auto-sell-review-recovery';
import {
  autoSellReviewReference as ref,
  autoSellUnsignedReviewPage as page,
} from '../test/auto-sell-review-fixture';
import { autoSellOutcomeReference as signedRef } from '../test/auto-sell-outcome-fixture';
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async () => Response.json(page()));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = async (reference = ref) =>
  act(async () =>
    root.render(
      <AutoSellReviewRecovery
        reference={reference}
        projectId={ref.projectId}
        mint={ref.mint}
      />,
    ),
  );
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = async (name: string) => {
  expect(button(name)).toBeTruthy();
  await act(async () => button(name).click());
};
const approve = async () =>
  act(async () => {
    const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box).toBeTruthy();
    box.click();
  });
it('does no mount read and binds a user-requested lookup to original preparation, not a fresh review', async () => {
  expect(fetcher).not.toHaveBeenCalled();
  await click('Read original saved review');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0] as string).toContain(
    `preparationId=${ref.preparationId}`,
  );
  expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  expect(host.textContent).toContain(signedRef.intentId);
  expect(host.textContent).not.toContain('SYNTHETIC-UNSIGNED');
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(button('Cancel unsigned approval').disabled).toBe(true);
});
it('requires separate cancellation approval, then a saved read before another action', async () => {
  await click('Read original saved review');
  await click('Cancel unsigned approval');
  expect(fetcher).toHaveBeenCalledOnce();
  await approve();
  fetcher.mockResolvedValueOnce(Response.json({ state: 'cancelled' }));
  await click('Cancel unsigned approval');
  const request = fetcher.mock.calls[1];
  expect(request[1]?.method).toBe('POST');
  expect(JSON.parse(request[1]!.body as string)).toEqual({
    action: 'cancel',
    id: signedRef.intentId,
  });
  expect(button('Cancel unsigned approval')).toBeUndefined();
  expect(host.textContent).toContain('Cancellation acknowledged');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const cancelled = page();
  cancelled.intents[0].state = 'cancelled';
  fetcher.mockResolvedValueOnce(Response.json(cancelled));
  await click('Check saved status');
  expect(fetcher.mock.calls[2][0] as string).toContain(
    `intentId=${signedRef.intentId}`,
  );
  expect(host.textContent).toContain('Saved approval is cancelled');
  expect(host.textContent).toContain('does not restore or resume');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('keeps a lost cancellation reply unknown without a retry and recovers with GET only', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockRejectedValueOnce(Error('private HTML diagnostic'));
  await click('Cancel unsigned approval');
  expect(host.textContent).toContain('outcome is unknown');
  expect(host.textContent).not.toContain('private HTML diagnostic');
  expect(button('Cancel unsigned approval')).toBeUndefined();
  const cancelled = page();
  cancelled.intents[0].state = 'cancelled';
  fetcher.mockResolvedValueOnce(Response.json(cancelled));
  await click('Check saved status');
  expect(
    fetcher.mock.calls.filter(([, i]) => i?.method === 'POST'),
  ).toHaveLength(1);
  expect(host.textContent).toContain('Saved approval is cancelled');
});
it.each(['signed', 'submitted', 'finalized', 'cancelled'] as const)(
  'never offers cancellation for saved %s',
  async (state) => {
    const body = page();
    body.intents[0].state = state;
    body.intents[0].signature =
      state === 'cancelled' ? null : signedRef.signature;
    fetcher.mockResolvedValueOnce(Response.json(body));
    await click('Read original saved review');
    expect(host.querySelector('input[type=checkbox]')).toBeNull();
    expect(host.textContent).toContain('not unsigned');
    expect(fetcher.mock.calls.every(([, i]) => i?.method === 'GET')).toBe(true);
  },
);
it('does not treat no match as permission to restart or create an approval', async () => {
  const body = page();
  body.intents = [];
  fetcher.mockResolvedValueOnce(Response.json(body));
  await click('Read original saved review');
  expect(host.textContent).toContain(
    'absence does not authorize a replacement',
  );
  expect(host.querySelector('input')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('refuses a changed original source without showing cancellation', async () => {
  const body = page();
  body.intents[0].walletRevision++;
  fetcher.mockResolvedValueOnce(Response.json(body));
  await click('Read original saved review');
  expect(host.textContent).toContain('could not be verified');
  expect(host.querySelector('input')).toBeNull();
});
it('aborts selection changes and refuses a late reply across A-to-B-to-A', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await click('Read original saved review');
  const signal = fetcher.mock.calls[0][1]?.signal;
  await mount({ ...ref, walletRevision: ref.walletRevision + 1 });
  expect(signal?.aborted).toBe(true);
  await mount();
  await act(async () => {
    finish(Response.json(page()));
  });
  expect(host.querySelector('input')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('requires fresh consent after a matching read still reports awaiting signature', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockRejectedValueOnce(Error());
  await click('Cancel unsigned approval');
  await click('Check saved status');
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  expect(button('Cancel unsigned approval').disabled).toBe(true);
});
it('does not publish a late cancellation response after context removal or resend on remount', async () => {
  await click('Read original saved review');
  await approve();
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('Cancel unsigned approval');
  const signal = fetcher.mock.calls[1][1]?.signal;
  await mount({ ...ref, walletRevision: ref.walletRevision + 1 });
  expect(signal?.aborted).toBe(true);
  await mount();
  await act(async () => finish(Response.json({ state: 'cancelled' })));
  expect(host.textContent).not.toContain('Cancellation acknowledged');
  expect(
    fetcher.mock.calls.filter(([, i]) => i?.method === 'POST'),
  ).toHaveLength(1);
  expect(host.querySelector('input')).toBeNull();
});

it('explains a protected cancellation refusal and never retries it automatically', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockResolvedValueOnce(
    Response.json({ error: 'protected' }, { status: 409 }),
  );
  await click('Cancel unsigned approval');
  expect(host.textContent).toContain(
    'bundle-bound approvals cannot be cancelled here',
  );
  expect(button('Cancel unsigned approval')).toBeUndefined();
  expect(
    fetcher.mock.calls.filter(([, i]) => i?.method === 'POST'),
  ).toHaveLength(1);
});
it('keeps access failures blocked until a fresh explicit read succeeds', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockResolvedValueOnce(
    Response.json({ error: 'access' }, { status: 403 }),
  );
  await click('Cancel unsigned approval');
  expect(host.textContent).toContain('Check sign-in and project access');
  expect(button('Cancel unsigned approval')).toBeUndefined();
  expect(button('Check saved status').disabled).toBe(false);
  await click('Check saved status');
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  expect(button('Cancel unsigned approval').disabled).toBe(true);
});

it('blocks parent rereads while cancellation is pending or needs its own status read', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockImplementationOnce(async () => new Promise<Response>(() => {}));
  await click('Cancel unsigned approval');
  expect(button('Read original saved review').disabled).toBe(true);
});
it('does not steal focus after a pointer click on non-focusable content outside the panel', async () => {
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('Read original saved review');
  const outside = document.createElement('div');
  document.body.appendChild(outside);
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await act(async () => finish(Response.json(page())));
  expect(document.activeElement).not.toBe(button('Read original saved review'));
  outside.remove();
});

it('blocks a parent reread after a lost cancel acknowledgement until its child status read succeeds', async () => {
  await click('Read original saved review');
  await approve();
  fetcher.mockRejectedValueOnce(Error());
  await click('Cancel unsigned approval');
  expect(button('Read original saved review').disabled).toBe(true);
  await click('Check saved status');
  expect(button('Read original saved review').disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
});
it('explains that a definite conflict may refer to a different approval instead of suggesting endless polling', async () => {
  await act(async () =>
    root.render(
      <AutoSellReviewRecovery
        reference={ref}
        projectId={ref.projectId}
        mint={ref.mint}
        conflict
      />,
    ),
  );
  const body = page();
  body.intents = [];
  fetcher.mockResolvedValueOnce(Response.json(body));
  await click('Read original saved review');
  expect(host.textContent).toContain(
    'Do not assume this preparation is the blocking approval',
  );
});
it('disables cancellation while a run is active without hiding saved status reads', async () => {
  await act(async () =>
    root.render(
      <AutoSellReviewRecovery
        reference={ref}
        projectId={ref.projectId}
        mint={ref.mint}
        allowCancellation={false}
      />,
    ),
  );
  await click('Read original saved review');
  expect(button('Cancel unsigned approval').disabled).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled,
  ).toBe(true);
  expect(host.textContent).toContain('wait for pending work to settle');
  expect(button('Check saved status').disabled).toBe(false);
});

it('withdraws cancellation consent when a new run disables cancellation', async () => {
  await click('Read original saved review');
  await approve();
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  await act(async () =>
    root.render(
      <AutoSellReviewRecovery
        reference={ref}
        projectId={ref.projectId}
        mint={ref.mint}
        allowCancellation={false}
      />,
    ),
  );
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  await act(async () =>
    root.render(
      <AutoSellReviewRecovery
        reference={ref}
        projectId={ref.projectId}
        mint={ref.mint}
      />,
    ),
  );
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  expect(button('Cancel unsigned approval').disabled).toBe(true);
});
