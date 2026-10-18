// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { GET, POST } from '@/app/api/trade-amount-preferences/route';
import { defaultTradeAmountPresets } from '@/lib/trade-amount-preferences';
import { BuyAmountPresets } from './trade-amount-presets';
import { ImportedSellPresets } from './imported-sell-presets';
import {
  ImportedSwapDesk,
  ImportedTokenQuote,
  type ImportedSwapState,
} from './imported-token-quote';
import { importedTokenDocument } from '@/lib/imported-token-project';
import { importedBalanceReviewFixture } from '../test/imported-balance-review-fixture';
const state = vi.hoisted(() => ({
  sessionOwner: 'alice' as string | null,
  apiOwner: 'alice' as string | null,
  db: null as D1Database | null,
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: state.sessionOwner ? { user: { id: state.sessionOwner } } : null,
    }),
  }),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () =>
    state.apiOwner ? { userId: state.apiOwner } : null,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('./imported-swap-wallet', () => ({ ImportedSwapWallet: () => null }));
let host: HTMLDivElement,
  root: Root,
  client: ReturnType<typeof createClient>,
  requests: Promise<Response>[],
  onAmount: ReturnType<typeof vi.fn<(value: string) => void>>;
let quoteReply: ((init?: RequestInit) => Promise<Response>) | null;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = createClient({ url: 'file::memory:' });
  state.db = createTursoDatabase(client);
  state.sessionOwner = state.apiOwner = 'alice';
  for (const file of [
    '0111_trade_amount_preferences',
    '0112_trade_preset_keyboard',
  ])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await client.execute(sql);
  requests = [];
  quoteReply = null;
  onAmount = vi.fn<(value: string) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: RequestInit) => {
      if (url === '/api/imported-projects/quote' && quoteReply) {
        const response = quoteReply(init);
        requests.push(response);
        return response;
      }
      if (url !== '/api/trade-amount-preferences')
        throw Error(
          'Unexpected request; presets must not quote, sign or submit.',
        );
      const request = new Request(
        'https://bundle.test/api/trade-amount-preferences',
        {
          ...init,
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.test',
          },
        },
      );
      const response = init?.method === 'POST' ? POST(request) : GET(request);
      requests.push(response);
      return response;
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function flush() {
  await act(async () => {
    await Promise.all(requests);
  });
}
async function mount(disabled = false, contextKey = 'fixture-one') {
  await act(async () =>
    root.render(
      <BuyAmountPresets
        disabled={disabled}
        contextKey={contextKey}
        onAmountChange={onAmount}
      />,
    ),
  );
  await flush();
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
async function click(text: string) {
  await act(async () => button(text).click());
  await flush();
}
async function open() {
  await act(async () => {
    const details = host.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
}
async function input(label: string, value: string) {
  await act(async () => {
    const el = host.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(
  target: Element,
  value: string,
  options: KeyboardEventInit = {},
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
}
it('refuses duplicate key assignments locally without writing preferences or triggering a trade', async () => {
  await mount();
  await open();
  const count = requests.length;
  await input('Buy SOL key 1', 'q');
  await click('Save amount presets');
  expect(host.textContent).toContain('Each preset key must be unique');
  expect(requests).toHaveLength(count);
  expect(onAmount).not.toHaveBeenCalled();
});
it('saves custom key mappings for this account, restores them after reload, and starts disarmed', async () => {
  await mount();
  await open();
  await input('Buy SOL key 1', '9');
  await click('Save amount presets');
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  await open();
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Buy SOL key 1"]')
      ?.value,
  ).toBe('9');
  const panel = host.querySelector<HTMLElement>(
    '[aria-label="Buy preset keyboard panel"] button[aria-pressed]',
  )!;
  panel.focus();
  await key(panel, '9');
  expect(onAmount).not.toHaveBeenCalled();
  await click('Enable preset keys');
  await key(panel, '1');
  expect(onAmount).not.toHaveBeenCalled();
  await key(panel, '9');
  expect(onAmount).toHaveBeenLastCalledWith('0.01');
  const count = onAmount.mock.calls.length;
  state.sessionOwner = state.apiOwner = 'bob';
  await mount();
  panel.focus();
  await key(panel, '9');
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(count);
  await open();
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Buy SOL key 1"]')
      ?.value,
  ).toBe('1');
});
it('requires focused-panel opt-in and suppresses typing, repeat, modifiers, focus loss, backgrounding, locks and changed token context', async () => {
  await mount();
  const panel = host.querySelector<HTMLElement>(
    '[aria-label="Buy preset keyboard panel"] button[aria-pressed]',
  )!;
  panel.focus();
  await key(panel, '1');
  expect(onAmount).not.toHaveBeenCalled();
  await click('Enable preset keys');
  const outerKey = vi.fn();
  document.addEventListener('keydown', outerKey);
  await key(panel, '1');
  document.removeEventListener('keydown', outerKey);
  expect(outerKey).not.toHaveBeenCalled();
  expect(onAmount).toHaveBeenCalledTimes(1);
  for (const options of [
    { repeat: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ])
    await key(panel, '1', options);
  expect(onAmount).toHaveBeenCalledTimes(1);
  const typing = document.createElement('input');
  panel.appendChild(typing);
  await act(async () => {
    typing.focus();
  });
  await key(typing, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  panel.focus();
  await key(panel, 'Escape');
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  await click('Enable preset keys');
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  await act(async () => outside.focus());
  panel.focus();
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  outside.remove();
  await click('Enable preset keys');
  await act(async () => window.dispatchEvent(new Event('blur')));
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  await click('Enable preset keys');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  await click('Enable preset keys');
  await mount(true);
  await key(panel, '1');
  await mount(false);
  panel.focus();
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  await click('Enable preset keys');
  await mount(false, 'fixture-two');
  panel.focus();
  await key(panel, '1');
  expect(onAmount).toHaveBeenCalledTimes(1);
  typing.remove();
});
it('adds, saves and reloads account presets through actual owned SQL, then fills an amount only on a click', async () => {
  await mount();
  expect(onAmount).not.toHaveBeenCalled();
  expect(host.querySelector('details')?.open).toBe(false);
  await open();
  await input('Buy SOL preset 1', '0.025');
  await click('Add Buy SOL preset');
  await input('Buy SOL preset 2', '0.1');
  await click('Save amount presets');
  expect(host.textContent).toContain('Amount presets saved');
  expect(host.textContent).toContain('0.025 SOL');
  expect(onAmount).not.toHaveBeenCalled();
  const prior = requests.length;
  await click('0.1 SOL');
  expect(onAmount).toHaveBeenLastCalledWith('0.1');
  expect(requests).toHaveLength(prior);
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  expect(host.textContent).toContain('0.1 SOL');
  expect(
    (await client.execute('SELECT revision FROM trade_amount_preferences'))
      .rows[0].revision,
  ).toBe(1);
});
it('drops the prior account values on account switch and never saves or selects automatically', async () => {
  await mount();
  await open();
  await input('Buy SOL preset 1', '0.2');
  await click('Save amount presets');
  expect(host.textContent).toContain('0.2 SOL');
  state.sessionOwner = state.apiOwner = 'bob';
  await mount();
  expect(host.textContent).not.toContain('0.2 SOL');
  expect(host.textContent).toContain('0.01 SOL');
  expect(onAmount).not.toHaveBeenCalled();
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(1);
});
it('keeps disabled selection inert and resets fields only until an explicit save', async () => {
  await mount(true);
  await click('0.01 SOL');
  expect(onAmount).not.toHaveBeenCalled();
  await open();
  await input('Buy SOL preset 1', '0.2');
  await click('Use Bundle defaults');
  expect(host.textContent).toContain(
    'Default values filled. Save to keep them.',
  );
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(0);
  await click('Save amount presets');
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(1);
});
it('refuses stale editor saves and recovers through an explicit reload', async () => {
  await mount();
  await open();
  await input('Buy SOL preset 1', '0.2');
  await POST(
    new Request('https://bundle.test/api/trade-amount-preferences', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
      },
      body: JSON.stringify({
        ownerId: 'alice',
        revision: 0,
        preferences: { ...defaultTradeAmountPresets(), buySol: ['0.3'] },
      }),
    }),
  );
  await click('Save amount presets');
  expect(host.textContent).toContain('Reload presets');
  await click('Reload saved presets');
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Buy SOL preset 1"]')
      ?.value,
  ).toBe('0.3');
});
it('uses saved custom sell percentages through fresh inventory checks and refuses expired observations', async () => {
  await POST(
    new Request('https://bundle.test/api/trade-amount-preferences', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
      },
      body: JSON.stringify({
        ownerId: 'alice',
        revision: 0,
        preferences: {
          ...defaultTradeAmountPresets(),
          sellBalanceBps: [3333, 10000],
          sellSupplyBps: [1],
        },
      }),
    }),
  );
  const f = importedBalanceReviewFixture();
  const render = () =>
    root.render(
      <ImportedSellPresets
        {...f}
        locked={false}
        onAmountChange={onAmount}
        supply={{
          mint: f.context.mint,
          decimals: 6,
          totalSupplyRaw: '1000000',
          observedAt: f.report.observedAt,
        }}
      />,
    );
  await act(async () => render());
  await flush();
  await click('33.33%');
  expect(onAmount).toHaveBeenLastCalledWith('0.001');
  await click('0.01%');
  expect(onAmount).toHaveBeenLastCalledWith('0.0001');
  const keyPanel = host.querySelector<HTMLElement>(
    '[aria-label="Sell preset keyboard panel"] button[aria-pressed]',
  )!;
  await click('Enable preset keys');
  await key(keyPanel, 'q');
  expect(onAmount).toHaveBeenLastCalledWith('0.001');
  await key(keyPanel, 'a');
  expect(onAmount).toHaveBeenLastCalledWith('0.0001');
  f.report.observedAt = new Date(Date.now() - 61000).toISOString();
  f.report.expiresAt = new Date(Date.now() - 1000).toISOString();
  await act(async () => render());
  const count = onAmount.mock.calls.length;
  await click('MAX');
  await key(keyPanel, 'q');
  expect(onAmount).toHaveBeenCalledTimes(count);
  const refreshedAt = Date.now() + 2000;
  vi.spyOn(Date, 'now').mockReturnValue(refreshedAt);
  Object.assign(f, importedBalanceReviewFixture(refreshedAt));
  await act(async () => {
    render();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(button('33.33%').disabled).toBe(false);
  keyPanel.focus();
  await key(keyPanel, 'q');
  expect(onAmount).toHaveBeenCalledTimes(count);
  await click('33.33%');
  expect(onAmount).toHaveBeenCalledTimes(count + 1);
  expect(onAmount).toHaveBeenLastCalledWith('0.001');
});
it('keeps default shortcuts usable after an HTML settings failure and recovers through reload', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let refuse = true;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
      refuse
        ? Promise.resolve(new Response('private upstream HTML'))
        : original(url, init),
    ),
  );
  await mount();
  await open();
  expect(host.textContent).toContain('Saved presets unavailable');
  await click('0.01 SOL');
  expect(onAmount).toHaveBeenLastCalledWith('0.01');
  refuse = false;
  await click('Reload saved presets');
  expect(host.textContent).toContain('Loaded saved presets');
});
it('fills the actual quote form, clears its existing quote and aborts a delayed quote without another request', async () => {
  const token = {
    chain: 'Solana' as const,
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'Fixture',
    symbol: 'FIX',
    decimals: 6,
    totalSupplyRaw: '1000000',
    observedAt: new Date().toISOString(),
    source: 'https://fixture.invalid',
    metadataUri: '',
  };
  const project = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    archived: false,
    updatedAt: token.observedAt,
    document: importedTokenDocument(token, token),
  };
  let current: ImportedSwapState | undefined,
    quoteSignal: AbortSignal | null | undefined;
  const quote = () =>
    Response.json({
      id: project.id,
      revision: 1,
      quote: {
        executionAllowed: false,
        side: 'Buy',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: token.address,
        inAmount: '10000000',
        outAmount: '1000',
        minimumOutAmount: '995',
        router: 'metis',
        source: 'fixture.invalid',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    });
  quoteReply = async (init) => {
    quoteSignal = init?.signal;
    return quote();
  };
  await act(async () =>
    root.render(
      <ImportedSwapDesk project={project}>
        {(s) => {
          current = s;
          return <ImportedTokenQuote project={project} state={s} />;
        }}
      </ImportedSwapDesk>,
    ),
  );
  await flush();
  await click('Quote imported buy');
  expect(current?.quote).not.toBeNull();
  const count = requests.length;
  await click('0.01 SOL');
  expect(current?.quote).toBeNull();
  expect(requests).toHaveLength(count);
  expect(current?.amount).toBe('0.01');
  let release: (v: Response) => void = () => {};
  quoteReply = (init) => {
    quoteSignal = init?.signal;
    return new Promise((resolve) => (release = resolve));
  };
  await act(async () => button('Quote imported buy').click());
  // Busy buttons cannot mutate a live quote. A current external amount callback cancels it.
  await act(async () => current?.onAmountChange('0.025'));
  expect(quoteSignal?.aborted).toBe(true);
  await act(async () => {
    release(quote());
  });
  await flush();
  expect(current?.quote).toBeNull();
  expect(current?.amount).toBe('0.025');
});
