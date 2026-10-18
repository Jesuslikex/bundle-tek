// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrategySessionPlanner } from './strategy-session-planner';
import {
  planStrategySession,
  type StrategySessionInput,
} from '@/lib/strategy-session-plan';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  strategyContext,
  strategyInput,
  strategyProject,
  strategyWallet,
  strategySecond,
} from '../test/strategy-session-fixture';
const project = {
  id: strategyProject,
  revision: 1,
  archived: false,
  updatedAt: '2026-10-18T12:00:00.000Z',
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      ...strategyContext().token,
      name: 'USD Coin',
      source: 'fixture.test',
      totalSupplyRaw: '100000000000',
      observedAt: '2026-10-18T12:00:00.000Z',
    },
  },
} as ImportedTokenProject;
const wallets = () =>
  strategyContext().wallets.map((w, i) => ({
    ...w,
    label: `Wallet ${i + 1}`,
    folderId: '',
    role: 'Recipient',
    updatedAt: '',
  })) as WorkspaceWallet[];
let host: HTMLDivElement,
  root: Root,
  saved: SavedStrategyDraft[],
  requests: { url: string; body: Record<string, unknown> | null }[];
let responder:
  | ((url: string, body: Record<string, unknown> | null) => Promise<Response>)
  | null;
const response = (patch: Record<string, unknown>) =>
  Response.json({ planningOnly: true, executionAllowed: false, ...patch });
const makeSaved = (id: string, input: StrategySessionInput) => ({
  id,
  revision: 1,
  archived: false,
  createdAt: '2026-10-18T12:00:00.000Z',
  plan: planStrategySession(input, strategyContext()),
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved = [];
  requests = [];
  responder = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const body = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      requests.push({ url: String(url), body });
      if (responder) return responder(String(url), body);
      if (body?.action === 'save') {
        const draft = makeSaved(
          body.id as string,
          body.input as StrategySessionInput,
        );
        saved = [draft, ...saved.filter((d) => d.id !== draft.id)];
        return response({ draft });
      }
      if (body?.action === 'archive') {
        const draft = saved.find((d) => d.id === body.id)!;
        draft.archived = Boolean(body.archived);
        draft.revision++;
        return response({ draft });
      }
      const archived =
        new URL(String(url), 'https://fixture.test').searchParams.get(
          'archived',
        ) === '1';
      return response({
        projectId: strategyProject,
        archived,
        drafts: saved.filter((d) => d.archived === archived),
        next: null,
      });
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(
  overrides: Partial<Parameters<typeof StrategySessionPlanner>[0]> = {},
) {
  await act(async () =>
    root.render(
      <StrategySessionPlanner
        project={project}
        wallets={wallets()}
        locked={false}
        {...overrides}
      />,
    ),
  );
}
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = (name: string) => act(async () => button(name).click());
function control(
  label: string,
  within: HTMLElement = host,
): HTMLInputElement | HTMLSelectElement {
  const l = [...within.querySelectorAll('label')].find(
    (l) =>
      [...l.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim() === label,
  )!;
  return document.getElementById(l.htmlFor) as
    | HTMLInputElement
    | HTMLSelectElement;
}
async function fill(label: string, value: string, within: HTMLElement = host) {
  const el = control(label, within);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
async function enterOne() {
  await mount();
  await click('Open strategy drafts');
  await fill('Shared maximum input (SOL)', '0.03');
  await click('Start 30 minutes from now');
  await fill('Strategy 1 wallet', `${strategyWallet}:1`);
  await fill('Input per cycle (SOL)', '0.005');
  await fill('Strategy 1 maximum input (SOL)', '0.02');
}
it('loads history only after explicit opening and exposes no execution controls', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  await click('Open strategy drafts');
  expect(requests).toHaveLength(1);
  expect(host.textContent).toContain('Draft planning only');
  expect(host.textContent).not.toContain('Run strategy');
  expect(
    host.querySelector('[aria-label="Combined strategy review"]'),
  ).toBeNull();
});
it('reviews, saves and reopens DCA plus Limit with independent and shared limits', async () => {
  await enterOne();
  await click('Add strategy');
  await fill('Strategy 2 type', 'Limit');
  await fill('Strategy 2 wallet', `${strategySecond}:2`);
  await fill('Limit input (SOL)', '0.01');
  await fill('Strategy 2 market cap (USD)', '100000');
  await fill('Strategy 2 maximum input (SOL)', '0.02');
  await click('Review combined draft');
  expect(
    host.querySelector('[aria-label="Combined strategy review"]')?.textContent,
  ).toContain('2 strategies');
  const review = host.querySelector('[aria-label="Combined strategy review"]')!;
  expect(review.textContent).toContain('Strategy 1: DCA');
  expect(review.textContent).toContain(strategyWallet);
  expect(review.textContent).toContain(
    '0.005 SOL per cycle; 5 cycles, every 60 seconds',
  );
  expect(review.textContent).toContain('Strategy 2: Limit');
  expect(review.textContent).toContain(strategySecond);
  expect(review.textContent).toContain(
    '0.01 SOL when market cap is at or above 100000 USD',
  );
  expect(review.textContent).not.toContain('compete for that budget');
  await click('Save strategy draft');
  expect(saved).toHaveLength(1);
  expect(saved[0].plan.input.strategies.map((s) => s.kind)).toEqual([
    'DCA',
    'Limit',
  ]);
  expect(saved[0].plan.summary.maximumInputRaw).toBe('30000000');
  const captured = saved[0].plan.input.startAt;
  await click('Open Strategy session');
  expect(host.textContent).toContain('saved start has not moved');
  await click('Review combined draft');
  expect(
    host.querySelector('[aria-label="Combined strategy review"]')?.textContent,
  ).toContain(captured);
  const originalId = saved[0].id;
  await click('Save strategy draft');
  expect(saved).toHaveLength(2);
  expect(saved[0].id).not.toBe(originalId);
  expect(saved[0].plan.input.startAt).toBe(captured);
  expect(
    requests.filter((r) => r.body).every((r) => r.body!.action === 'save'),
  ).toBe(true);
});
it('uses the same save ID on a cancelled ambiguous request and ignores its late response', async () => {
  await enterOne();
  await click('Review combined draft');
  let resolve!: (value: Response) => void;
  responder = async (_url, body) =>
    body
      ? new Promise<Response>((r) => {
          resolve = r;
        })
      : response({
          projectId: strategyProject,
          archived: false,
          drafts: [],
          next: null,
        });
  await click('Save strategy draft');
  expect(button('Cancel draft request')).toBeTruthy();
  await click('Cancel draft request');
  expect(host.textContent).toContain('outcome not confirmed');
  const original = requests.find((r) => r.body?.action === 'save')!.body!;
  responder = async (_url, body) =>
    response({
      draft: makeSaved(body!.id as string, body!.input as StrategySessionInput),
    });
  await click('Save strategy draft');
  const writes = requests.filter((r) => r.body?.action === 'save');
  expect(writes).toHaveLength(2);
  expect(writes[1].body!.id).toBe(original.id);
  await act(async () =>
    resolve(
      response({
        draft: makeSaved(
          '00000000-0000-4000-8000-000000000099',
          original.input as StrategySessionInput,
        ),
      }),
    ),
  );
  expect(host.textContent).toContain('Strategy draft saved');
});
it('a changed selected wallet invalidates review and requires explicit reselection', async () => {
  await enterOne();
  await click('Review combined draft');
  const changed = wallets();
  changed[0].revision = 3;
  await mount({ wallets: changed });
  expect(
    host.querySelector('[aria-label="Combined strategy review"]'),
  ).toBeNull();
  expect(control('Strategy 1 wallet').value).toBe('');
  expect(host.textContent).toContain('wallet changed');
});
it('changing input units clears monetary fields and the reviewed plan', async () => {
  await enterOne();
  await click('Review combined draft');
  await fill('Session side', 'Sell');
  expect(control('Shared maximum input (USDC)').value).toBe('');
  expect(control('Input per cycle (USDC)').value).toBe('');
  expect(
    host.querySelector('[aria-label="Combined strategy review"]'),
  ).toBeNull();
});
it('reviews exact token inputs and below-threshold Limit terms without rounding', async () => {
  await enterOne();
  await fill('Session side', 'Sell');
  await fill('Strategy 1 type', 'Limit');
  await fill('Limit input (USDC)', '9007199254.740991');
  await fill('Strategy 1 market cap (USD)', '123456.123456');
  await fill('Trigger direction', 'at-or-below');
  await click('Review combined draft');
  const review = host.querySelector('[aria-label="Combined strategy review"]')!;
  expect(review.textContent).toContain(
    '9007199254.740991 USDC when market cap is at or below 123456.123456 USD',
  );
  expect(review.textContent).toContain(strategyWallet);
});
it('allows optional limits to stay blank, without hiding a required-field dead end', async () => {
  await enterOne();
  await fill('Strategy 1 maximum input (SOL)', '');
  const max = control('Strategy 1 maximum input (SOL)');
  expect((max as HTMLInputElement).required).toBe(false);
  await fill('Shared maximum input (SOL)', '');
  await click('Review combined draft');
  expect(
    host.querySelector('[aria-label="Combined strategy review"]')?.textContent,
  ).toContain('No shared amount cap');
  await click('Save strategy draft');
  expect(saved[0].plan.input.maxAmount).toBeNull();
  expect(saved[0].plan.input.strategies[0].maxAmount).toBeNull();
  expect(saved[0].plan.input.durationSeconds).toBeNull();
});
it('supports archive and restore without converting drafts to sessions', async () => {
  saved = [makeSaved('00000000-0000-4000-8000-000000000010', strategyInput())];
  await mount();
  await click('Open strategy drafts');
  await click('Archive Two strategies');
  expect(saved[0].archived).toBe(true);
  expect(host.textContent).toContain('Draft archived');
  await click('Show archived drafts');
  await click('Restore Two strategies');
  expect(saved[0].archived).toBe(false);
  expect(host.textContent).toContain('Draft restored');
  expect(
    requests.filter((r) => r.body).every((r) => r.body!.action === 'archive'),
  ).toBe(true);
});
it('displays actionable sign-in and non-JSON errors without exposing response bodies', async () => {
  responder = async () =>
    new Response('private upstream details', { status: 401 });
  await mount();
  await click('Open strategy drafts');
  expect(host.textContent).toContain('Sign in again');
  expect(host.textContent).not.toContain('private upstream');
  responder = async () => new Response('private upstream details');
  await click('Reload strategy drafts');
  expect(host.textContent).toContain('unavailable');
  expect(host.textContent).not.toContain('private upstream');
});
it('rejects a successful response with foreign draft identity', async () => {
  await enterOne();
  await click('Review combined draft');
  responder = async (_url, body) =>
    response({
      draft: makeSaved(
        '00000000-0000-4000-8000-000000000099',
        body!.input as StrategySessionInput,
      ),
    });
  await click('Save strategy draft');
  expect(host.textContent).toContain('response differs');
  expect(host.textContent).not.toContain('Strategy draft saved');
});
it('locking removes review and disables new planning while retaining readable history', async () => {
  await enterOne();
  await click('Review combined draft');
  await mount({ locked: true });
  expect(
    host.querySelector('[aria-label="Combined strategy review"]'),
  ).toBeNull();
  expect(button('Review combined draft').disabled).toBe(true);
  expect(button('Reload strategy drafts').disabled).toBe(false);
});
