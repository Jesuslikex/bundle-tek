// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CounterBuyBudgetSetup } from './counter-buy-budget-setup';
import { counterBudgetUiFixture } from '../test/counter-budget-ui-fixture';
import {
  COUNTER_BUY_BUDGET_REMINDER,
  counterBudgetReminder,
} from '../lib/counter-buy-budget-view';
let uuidCalls = 0;
let root: Root,
  container: HTMLDivElement,
  f: ReturnType<typeof counterBudgetUiFixture>;
let calls: {
  url: string;
  init: RequestInit;
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
}[];
beforeEach(() => {
  f = counterBudgetUiFixture();
  calls = [];
  uuidCalls = 0;
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) =>
          calls.push({ url, init, resolve, reject }),
        ),
    ),
  );
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    uuidCalls++;
    return f.selection
      .budgetId as `${string}-${string}-${string}-${string}-${string}`;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});
async function render(
  changes: Partial<Parameters<typeof CounterBuyBudgetSetup>[0]> = {},
) {
  await act(async () =>
    root.render(
      <CounterBuyBudgetSetup
        plan={f.plan}
        decisionIdentity={f.identity}
        wallet={{
          address: f.selection.wallet,
          revision: 1,
          label: 'Synthetic preview wallet',
        }}
        maximumSolInputRaw={f.request.maximumSolInputRaw}
        maximumFeeAndRentRaw={f.request.maximumFeeAndRentRaw}
        locked={false}
        {...changes}
      />,
    ),
  );
}
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  )!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function input(label: string, value: string) {
  await act(async () => {
    const l = Array.from(container.querySelectorAll('label')).find(
      (n) => n.textContent === label,
    )!;
    const el = document.getElementById(l.htmlFor) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function respond(value: unknown, status = 200) {
  await act(async () =>
    calls.at(-1)!.resolve(Response.json(value, { status })),
  );
}
async function configure() {
  await render();
  await input('Total swap budget (SOL)', '1');
  await input('Total fees and rent (SOL)', '0.01');
  await input('Original expiry (UTC)', f.selection.expiresAt.slice(0, 16));
}
async function review() {
  await configure();
  await click('Review accounting limits');
  const { action: _action, ...selection } = JSON.parse(
    calls.at(-1)!.init.body as string,
  );
  f.selection = selection;
  f.review.selection = selection;
  f.review.terms.id = selection.budgetId;
  f.review.terms.expiresAt = selection.expiresAt;
  f.saved.budget.terms = structuredClone(f.review.terms);
  await respond({ review: f.review });
}
async function approve() {
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
}
async function save() {
  await review();
  await approve();
  await click('Save accounting metadata');
}
it('mounts without fetching, keeps separate blank totals and explains missing context', async () => {
  await render({ wallet: null });
  expect(fetch).not.toHaveBeenCalled();
  expect(button('Review accounting limits').disabled).toBe(true);
  expect(container.textContent).toContain('Choose a verified wallet above');
  expect(container.querySelectorAll('input')).toHaveLength(3);
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('reviews exact original limits and requires a separate initially unchecked acknowledgement', async () => {
  await review();
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].init.body as string)).toEqual({
    ...f.selection,
    action: 'review',
  });
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  expect(button('Save accounting metadata').disabled).toBe(true);
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).toBeNull();
});
it('persists exact original metadata before one save, admits the result and explicitly previews its exact budget', async () => {
  await save();
  expect(calls).toHaveLength(2);
  expect(
    JSON.parse(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)!),
  ).toEqual(counterBudgetReminder(f.review));
  expect(JSON.parse(calls[1].init.body as string)).toEqual({
    ...f.selection,
    action: 'save',
    reviewSha256: f.review.reviewSha256,
    acknowledgement: f.review.requiredAcknowledgement,
  });
  await respond({ saved: f.saved });
  expect(container.textContent).toContain(
    'Immutable accounting terms saved or recovered',
  );
  expect(calls).toHaveLength(2);
  await click('Preview saved budget');
  expect(calls[2].url).toBe('/api/imported-projects/counter-budget-previews');
  expect(JSON.parse(calls[2].init.body as string)).toEqual(f.budgetRequest);
  await respond({ preview: f.budgetPreview });
  expect(container.textContent).toContain('not reservable');
  expect(container.textContent).toContain('No trading approval');
});
it('lost save response retains original ID and allows GET-only recovery, not another save', async () => {
  await save();
  await act(async () => calls[1].reject(Error('network private details')));
  expect(container.textContent).toContain('Save outcome unknown');
  expect(button('Save accounting metadata')).toBeUndefined();
  await click('Recover original budget ID');
  expect(calls[2].init.method).toBe('GET');
  expect(calls[2].url).toBe(
    `/api/imported-projects/counter-budgets?id=${f.selection.budgetId}`,
  );
  await respond({
    saved: { ...f.saved, currentContext: 'not-checked-history' },
  });
  expect(container.textContent).toContain(
    'Original accounting record recovered',
  );
  expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(2);
});
it('reload reminder performs no automatic fetch and a 404 preserves original-ID recovery', async () => {
  localStorage.setItem(
    COUNTER_BUY_BUDGET_REMINDER,
    JSON.stringify(counterBudgetReminder(f.review)),
  );
  await render();
  expect(fetch).not.toHaveBeenCalled();
  await click('Recover original budget ID');
  await respond({ error: 'not found' }, 404);
  expect(container.textContent).toContain('No replacement was created');
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).not.toBeNull();
  expect(button('Review accounting limits')).toBeUndefined();
  await click('Recover original budget ID');
  expect(calls[1].url).toBe(calls[0].url);
});
it('blocks POST when durable storage fails', async () => {
  await review();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await approve();
  await click('Save accounting metadata');
  expect(calls).toHaveLength(1);
  expect(container.textContent).toContain('No save request was sent');
});
it('does not overwrite a different original reminder before POST', async () => {
  await review();
  const other = structuredClone(f.review);
  other.selection.budgetId = '123e4567-e89b-42d3-a456-426614174222';
  other.terms.id = other.selection.budgetId;
  const text = JSON.stringify(counterBudgetReminder(other));
  localStorage.setItem(COUNTER_BUY_BUDGET_REMINDER, text);
  await approve();
  await click('Save accounting metadata');
  expect(calls).toHaveLength(1);
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).toBe(text);
});
it('storage changes in another tab clear consent and refuse an unsafe save', async () => {
  await review();
  await approve();
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: COUNTER_BUY_BUDGET_REMINDER,
        storageArea: localStorage,
        newValue: 'changed',
      }),
    ),
  );
  expect(container.textContent).toContain('changed in another tab');
  expect(button('Save accounting metadata')).toBeUndefined();
  expect(calls).toHaveLength(1);
});
it('only the exact structured prewrite refusal releases the reminder and keeps the same UUID', async () => {
  await save();
  await respond(
    {
      format: 'owned-counter-budget-save-refusal-v1',
      scope: 'current-request-only',
      priorSaveOutcomeVerified: false,
      originalId: f.selection.budgetId,
      reviewSha256: f.review.reviewSha256,
      writerAttempted: false,
      recoveryRequired: false,
      error: 'Context changed',
    },
    409,
  );
  expect(container.textContent).toContain(
    'this request did not attempt a write',
  );
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).toBeNull();
  await click('Review accounting limits');
  expect(JSON.parse(calls[2].init.body as string).budgetId).toBe(
    f.selection.budgetId,
  );
  expect(uuidCalls).toBe(1);
});
it('a wrong-bound or generic save refusal stays GET-only', async () => {
  await save();
  await respond(
    {
      format: 'owned-counter-budget-save-refusal-v1',
      scope: 'current-request-only',
      priorSaveOutcomeVerified: false,
      originalId: f.plan.id,
      reviewSha256: f.review.reviewSha256,
      writerAttempted: false,
      recoveryRequired: false,
      error: 'wrong ID',
    },
    409,
  );
  expect(container.textContent).toContain('Save outcome unknown');
  expect(button('Recover original budget ID')).toBeTruthy();
});
it('HTML 401 exposes a sign-in link without parser or response-body leaks', async () => {
  await configure();
  await click('Review accounting limits');
  await act(async () =>
    calls[0].resolve(
      new Response('<html>PRIVATE ERROR</html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  expect(container.textContent).not.toMatch(
    /PRIVATE ERROR|Unexpected token|JSON/,
  );
});
it('oversized JSON, unknown fields or altered authority do not become reviewed metadata', async () => {
  await configure();
  await click('Review accounting limits');
  await respond({ review: { ...f.review, extra: 'a'.repeat(65536) } });
  expect(button('Save accounting metadata')).toBeUndefined();
  expect(container.textContent).toContain('differs');
});
it('context change cancels review and ignores its late response', async () => {
  await configure();
  await click('Review accounting limits');
  const old = calls[0];
  await render({
    wallet: {
      address: f.selection.wallet,
      revision: 2,
      label: 'Changed wallet',
    },
  });
  expect(old.init.signal?.aborted).toBe(true);
  await act(async () => old.resolve(Response.json({ review: f.review })));
  expect(button('Save accounting metadata')).toBeUndefined();
  expect(container.textContent).not.toContain(
    'Exact accounting limits reviewed',
  );
});
it('context change during save preserves original marker and refuses late optimistic success', async () => {
  await save();
  const old = calls[1];
  await render({ locked: true });
  expect(old.init.signal?.aborted).toBe(true);
  await act(async () => old.resolve(Response.json({ saved: f.saved })));
  expect(button('Recover original budget ID')).toBeTruthy();
  expect(container.textContent).not.toContain(
    'Immutable accounting terms saved or recovered',
  );
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).not.toBeNull();
});
it('cancelled save keeps recovery while cancelling review permits a fresh explicit read', async () => {
  await configure();
  await click('Review accounting limits');
  await click('Cancel request');
  await click('Review accounting limits');
  const req = JSON.parse(calls[1].init.body as string);
  f.review.selection = { ...f.selection, ...req };
  delete (f.review.selection as unknown as Record<string, unknown>).action;
  f.review.terms.expiresAt = f.review.selection.expiresAt;
  await respond({ review: f.review });
  await approve();
  await click('Save accounting metadata');
  await click('Cancel request');
  expect(container.textContent).toContain('Save outcome unknown');
  expect(button('Recover original budget ID')).toBeTruthy();
});
it('timeout makes an uncooperative save recoverable and does not retry automatically', async () => {
  await review();
  vi.useFakeTimers();
  await approve();
  await click('Save accounting metadata');
  await act(async () => vi.advanceTimersByTime(15000));
  expect(container.textContent).toContain('Save outcome unknown');
  expect(calls).toHaveLength(2);
  expect(calls[1].init.signal?.aborted).toBe(true);
});
it('recovered expired history retains totals and cannot preview or renew', async () => {
  f.review.selection.expiresAt = new Date(Date.now() - 1000).toISOString();
  f.review.terms.expiresAt = f.review.selection.expiresAt;
  f.saved.budget.terms = structuredClone(f.review.terms);
  localStorage.setItem(
    COUNTER_BUY_BUDGET_REMINDER,
    JSON.stringify(counterBudgetReminder(f.review)),
  );
  await render();
  await click('Recover original budget ID');
  await respond({
    saved: { ...f.saved, currentContext: 'not-checked-history' },
  });
  expect(container.textContent).toContain('Original expiry has passed');
  expect(button('Preview saved budget').disabled).toBe(true);
  expect(button('Review accounting limits')).toBeUndefined();
});
it('does not steal outside focus when a slow response arrives', async () => {
  await configure();
  await click('Review accounting limits');
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  outside.focus();
  await respond({ review: f.review });
  expect(document.activeElement).toBe(outside);
  outside.remove();
});
async function allowOriginalRetry() {
  await save();
  await act(async () => calls[1].reject(Error('lost reply')));
  await click('Recover original budget ID');
  await respond({ error: 'Owned budget history not found.' }, 404);
}
it('allows one explicitly acknowledged retry only after JSON owner 404, with byte-identical original save body', async () => {
  await allowOriginalRetry();
  expect(calls).toHaveLength(3);
  expect(button('Retry original metadata save').disabled).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
  const original = calls[1].init.body;
  await approve();
  await click('Retry original metadata save');
  expect(calls).toHaveLength(4);
  expect(calls[3].init.body).toBe(original);
  expect(uuidCalls).toBe(1);
  await respond({
    saved: { ...f.saved, disposition: 'recovered-existing-terms' },
  });
  expect(container.textContent).toContain(
    'Immutable accounting terms saved or recovered',
  );
  expect(button('Retry original metadata save')).toBeUndefined();
});
it('requires another explicit lookup after cancelled retry and ignores a late reply', async () => {
  await allowOriginalRetry();
  await approve();
  await click('Retry original metadata save');
  const retry = calls[3];
  await click('Cancel request');
  expect(retry.init.signal?.aborted).toBe(true);
  await act(async () => retry.resolve(Response.json({ saved: f.saved })));
  expect(container.textContent).toContain('Save outcome unknown');
  expect(button('Retry original metadata save')).toBeUndefined();
  expect(button('Recover original budget ID')).toBeTruthy();
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).not.toBeNull();
  expect(calls).toHaveLength(4);
});
it('does not enable retry after HTML 404 or a non-404 JSON error', async () => {
  await save();
  await act(async () => calls[1].reject(Error('lost reply')));
  await click('Recover original budget ID');
  await act(async () =>
    calls[2].resolve(
      new Response('<html>not found</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    ),
  );
  expect(button('Retry original metadata save')).toBeUndefined();
  await click('Recover original budget ID');
  await respond({ error: 'Owned budget history not found.' }, 502);
  expect(button('Retry original metadata save')).toBeUndefined();
  expect(calls).toHaveLength(4);
});
it('clears retry permission and acknowledgement on context change without replacing its UUID', async () => {
  await allowOriginalRetry();
  await approve();
  await render({
    wallet: {
      address: f.selection.wallet,
      revision: 2,
      label: 'Changed wallet',
    },
  });
  expect(button('Retry original metadata save')).toBeUndefined();
  expect(calls).toHaveLength(3);
  expect(uuidCalls).toBe(1);
  await click('Recover original budget ID');
  expect(calls[3].url).toContain(f.selection.budgetId);
  await respond({ error: 'Owned budget history not found.' }, 404);
  expect(
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked,
  ).toBe(false);
});
it('blocks a manual original retry when reminder durability fails', async () => {
  await allowOriginalRetry();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await approve();
  await click('Retry original metadata save');
  expect(calls).toHaveLength(3);
  expect(container.textContent).toContain('No save request was sent');
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).not.toBeNull();
});
it('does not release an older unknown outcome on a retry-specific prewrite refusal', async () => {
  await allowOriginalRetry();
  await approve();
  await click('Retry original metadata save');
  await respond(
    {
      format: 'owned-counter-budget-save-refusal-v1',
      scope: 'current-request-only',
      priorSaveOutcomeVerified: false,
      originalId: f.selection.budgetId,
      reviewSha256: f.review.reviewSha256,
      writerAttempted: false,
      recoveryRequired: false,
      error: 'This request refused before writer',
    },
    409,
  );
  expect(container.textContent).toContain('Save outcome unknown');
  expect(button('Retry original metadata save')).toBeUndefined();
  expect(button('Review accounting limits')).toBeUndefined();
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).not.toBeNull();
});
const backupKeyFor = (r: typeof f.review) =>
  `${COUNTER_BUY_BUDGET_REMINDER}.${r.selection.budgetId}.${r.reviewSha256}`;
it('keeps an immutable original backup before its first save POST even if the active pointer later disappears', async () => {
  await save();
  expect(JSON.parse(localStorage.getItem(backupKeyFor(f.review))!)).toEqual(
    counterBudgetReminder(f.review),
  );
  localStorage.removeItem(COUNTER_BUY_BUDGET_REMINDER);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(calls).toHaveLength(2);
  expect(button('Review accounting limits').disabled).toBe(true);
  expect(container.textContent).toContain(
    'Choose an original locally retained budget',
  );
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = backupKeyFor(f.review);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Recover original budget ID');
  expect(calls[2].url).toContain(f.selection.budgetId);
});
it('permits another UUID only after an admitted saved record is backed up and only its matching pointer is removed', async () => {
  await save();
  await respond({ saved: f.saved });
  await click('Set up another budget');
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).toBeNull();
  expect(JSON.parse(localStorage.getItem(backupKeyFor(f.review))!)).toEqual(
    counterBudgetReminder(f.review),
  );
  expect(container.textContent).toContain(f.selection.budgetId);
  const nextId = '123e4567-e89b-42d3-a456-426614174222';
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(nextId);
  await input('Total swap budget (SOL)', '2');
  await input('Total fees and rent (SOL)', '0.02');
  await input('Original expiry (UTC)', f.selection.expiresAt.slice(0, 16));
  await click('Review accounting limits');
  expect(JSON.parse(calls[2].init.body as string).budgetId).toBe(nextId);
  expect(calls).toHaveLength(3);
});
it('backup or mismatched active-pointer failure prevents starting another budget', async () => {
  await save();
  await respond({ saved: f.saved });
  localStorage.setItem(COUNTER_BUY_BUDGET_REMINDER, 'another original');
  await click('Set up another budget');
  expect(container.textContent).toContain('No new draft was created');
  expect(localStorage.getItem(COUNTER_BUY_BUDGET_REMINDER)).toBe(
    'another original',
  );
  expect(calls).toHaveLength(2);
});
it('a failed immutable backup prevents the first save request', async () => {
  await review();
  const setter = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!
    .value as (this: Storage, key: string, value: string) => void;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
    function (this: Storage, key, value) {
      if (key.startsWith(`${COUNTER_BUY_BUDGET_REMINDER}.`))
        throw Error('backup blocked');
      setter.call(this, key, value);
    },
  );
  await approve();
  await click('Save accounting metadata');
  expect(calls).toHaveLength(1);
  expect(container.textContent).toContain('No save request was sent');
});
it('discovers multiple backups with explicit selection and no automatic original-ID guess or fetch', async () => {
  const other = structuredClone(f.review);
  other.selection.budgetId = '123e4567-e89b-42d3-a456-426614174222';
  other.terms.id = other.selection.budgetId;
  for (const reviewed of [f.review, other])
    localStorage.setItem(
      backupKeyFor(reviewed),
      JSON.stringify(counterBudgetReminder(reviewed)),
    );
  await render();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('select')!.value).toBe('');
  expect(container.querySelectorAll('option')).toHaveLength(3);
  expect(button('Recover original budget ID')).toBeUndefined();
  expect(button('Review accounting limits').disabled).toBe(true);
});
it('blocks expired original retry at action time without timer advancement and retains GET history', async () => {
  await allowOriginalRetry();
  await approve();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(f.selection.expiresAt));
  await click('Retry original metadata save');
  expect(calls).toHaveLength(3);
  await click('Recover original budget ID');
  await respond({ error: 'Owned budget history not found.' }, 404);
  expect(container.textContent).toContain('cannot be renewed or retried');
  expect(button('Retry original metadata save')).toBeUndefined();
});
it('preserves an explicit original-ID unknown outcome after write context changes', async () => {
  await save();
  await render({ locked: true });
  expect(container.textContent).toContain(
    `Save outcome unknown for original ID ${f.selection.budgetId}`,
  );
  expect(button('Set up another budget')).toBeUndefined();
  expect(button('Recover original budget ID')).toBeTruthy();
});
