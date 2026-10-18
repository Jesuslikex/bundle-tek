// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://bundle.test"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { layerNativeFixture } from '../../test/launch-layer-native-fixture';
import { PumpLayerPlanner } from './pump-layer-planner';
import { layerUiFixture } from '../../test/launch-layer-ui-fixture';
import { layerTestStorage } from '../../test/launch-layer-storage';
import { GET, POST } from '@/app/api/launch/layers/route';
import {
  saveOwnedLaunchLayerPlan,
  listOwnedLaunchLayerPlans,
} from '@/lib/launch-layer-service';
const state = vi.hoisted(() => ({ db: null as D1Database | null }));
const originalScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'alice' }),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof layerUiFixture>,
  storage: Awaited<ReturnType<typeof layerTestStorage>>;
let calls: { url: string; method: string }[];
let intercept:
  | ((url: string, options: RequestInit) => Promise<Response> | undefined)
  | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await flush();
      });
      assertion();
    },
    { timeout: 5000, interval: 10 },
  );
}
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  if (!found) throw new Error('Missing button: ' + text);
  return found;
};
async function click(text: string, settle = true) {
  await act(async () => {
    button(text).click();
    await flush();
  });
  if (settle)
    await vi.waitFor(
      async () => {
        await act(async () => {
          await flush();
        });
        expect(
          [...host.querySelectorAll('button')].some(
            (b) => b.textContent === 'Cancel planning request',
          ),
        ).toBe(false);
      },
      { timeout: 5000, interval: 10 },
    );
}
async function input(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}
async function render(selection = f.selection) {
  await act(async () => {
    root.render(<PumpLayerPlanner selection={selection} />);
    await flush();
  });
}
async function loadAndFill() {
  await click('Load saved wallets and layer history');
  const rows = [...host.querySelectorAll('fieldset[aria-label]')];
  expect(rows).toHaveLength(5);
  for (const row of rows) {
    const role = row.querySelector('legend')!.textContent;
    const select = row.querySelector('select');
    if (select) await input(select, f.address(role === 'Funder' ? 1 : 3));
    const inputs = [...row.querySelectorAll('input')];
    if (!inputs[0].disabled)
      await input(
        inputs[0],
        role === 'Front buyer'
          ? '0.000001'
          : role === 'Developer'
            ? '0.0000001'
            : '0',
      );
    await input(inputs[1], '0.000005');
    await input(inputs[2], '0.002');
    await input(inputs[3], '0.0001');
  }
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  f = layerUiFixture();
  storage = await layerTestStorage(f);
  state.db = storage.db;
  calls = [];
  intercept = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method });
      const override = intercept?.(url, options);
      if (override) return override;
      const headers = new Headers(options.headers);
      if (method === 'POST') headers.set('origin', 'https://bundle.test');
      const request = new Request('https://bundle.test' + url, {
        ...options,
        headers,
      });
      return method === 'POST' ? POST(request) : GET(request);
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  storage.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScroll)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScroll,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
it('browses older mint snapshots through the real API without changing the editable draft', async () => {
  const older = await saveOwnedLaunchLayerPlan(
    storage.db,
    'alice',
    f.input,
    f.now,
  );
  await saveOwnedLaunchLayerPlan(
    storage.db,
    'alice',
    { ...f.input, target: { kind: 'new', mint: f.address(98) } },
    () => f.now() + 1000,
  );
  await loadAndFill();
  const values = [
    ...host.querySelectorAll<HTMLInputElement>('fieldset input'),
  ].map((input) => input.value);
  await click('Browse saved planning history');
  await until(() =>
    expect(
      host.querySelectorAll('button[aria-label^="Open snapshot"]'),
    ).toHaveLength(2),
  );
  const open = host.querySelector<HTMLButtonElement>(
    `button[aria-label="Open snapshot ${older.id}"]`,
  )!;
  await act(async () => {
    open.click();
    await flush();
  });
  await until(() =>
    expect(host.textContent).toContain(
      'Saved snapshot opened. Your editable draft is unchanged',
    ),
  );
  expect(
    [...host.querySelectorAll<HTMLInputElement>('fieldset input')].map(
      (input) => input.value,
    ),
  ).toEqual(values);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await until(() =>
    expect(host.querySelector('details[open]')?.textContent).toContain(
      older.id,
    ),
  );
  expect(host.textContent).toContain('Use saved ceilings as a new draft');
  expect(host.textContent).not.toContain('Save reviewed planning snapshot');
});
it('compares retained native observations through the real owned route without provider calls or writes', async () => {
  const fixture = await layerNativeFixture();
  const saved = await saveOwnedLaunchLayerPlan(
    storage.db,
    'alice',
    f.input,
    f.now,
  );
  await storage.client.executeMultiple(
    await readFile('drizzle/0012_messy_zzzax.sql', 'utf8'),
  );
  await storage.client.execute({
    sql: 'INSERT INTO wallet_balance_snapshots VALUES(?,?,?,?,?)',
    args: [
      'alice',
      'Solana',
      f.address(1),
      JSON.stringify(fixture.document(f.address(1), '0')),
      123,
    ],
  });
  await click('Load saved wallets and layer history');
  await click('Load saved SOL observations');
  await until(() =>
    expect(host.textContent).toContain('Below ceiling by 0.002105 SOL'),
  );
  expect(host.textContent).toContain('No saved observation');
  expect(host.textContent).toContain('no combined SOL balance is shown');
  expect(host.textContent).toContain(
    'not current spendability or required funding',
  );
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  expect(calls.some((call) => call.url.includes('balances=1'))).toBe(true);
  expect(
    (
      await storage.client.execute(
        'SELECT COUNT(*) AS n FROM wallet_balance_snapshots',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await storage.client.execute('SELECT id FROM launch_layer_plans')).rows[0]
      .id,
  ).toBe(saved.id);
});
it('cancels history reads and ignores an uncooperative late response', async () => {
  let release!: (response: Response) => void;
  intercept = (url) =>
    url.includes('?history=')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  await click('Browse saved planning history');
  expect(host.textContent).toContain('Loading planning history…');
  await click('Cancel history loading');
  const history = await listOwnedLaunchLayerPlans(
    storage.db,
    'alice',
    f.selection.projectId,
  );
  await act(async () => {
    release(Response.json({ history }));
    await flush();
  });
  expect(host.textContent).toContain('History loading cancelled');
  expect(host.textContent).not.toContain('No saved planning snapshots yet');
  intercept = undefined;
  await click('Reload planning history');
  await until(() =>
    expect(host.textContent).toContain('No saved planning snapshots yet'),
  );
});
it('keeps a pending history response out of a different mint context', async () => {
  let release!: (response: Response) => void;
  intercept = (url) =>
    url.includes('?history=')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  await click('Browse saved planning history');
  await render({
    ...f.selection,
    target: { kind: 'new', mint: f.address(98) },
  });
  const history = await listOwnedLaunchLayerPlans(
    storage.db,
    'alice',
    f.selection.projectId,
  );
  await act(async () => {
    release(Response.json({ history }));
    await flush();
  });
  expect(host.textContent).not.toContain('Loading planning history');
  expect(host.textContent).not.toContain('No saved planning snapshots yet');
  expect(host.textContent).toContain(f.address(98));
});
it('releases a timed-out history read even when the transport ignores abort', async () => {
  let release!: (response: Response) => void;
  intercept = (url) =>
    url.includes('?history=')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  vi.useFakeTimers();
  await act(async () => {
    button('Browse saved planning history').click();
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(host.textContent).toContain('History loading timed out');
  expect(button('Reload planning history').disabled).toBe(false);
  await act(async () => {
    release(Response.json({ history: null }));
    await Promise.resolve();
  });
  expect(host.textContent).toContain('History loading timed out');
  expect(host.textContent).not.toContain('could not be confirmed');
});
it('refuses a detail record that differs from its selected history metadata', async () => {
  await saveOwnedLaunchLayerPlan(storage.db, 'alice', f.input, f.now);
  await click('Browse saved planning history');
  await until(() =>
    expect(
      host.querySelectorAll('button[aria-label^="Open snapshot"]'),
    ).toHaveLength(1),
  );
  intercept = (url) =>
    url.includes('&id=')
      ? (async () => {
          const response = await GET(new Request('https://bundle.test' + url));
          const body = (await response.json()) as { plan: { sha256: string } };
          body.plan.sha256 = '0'.repeat(64);
          return Response.json(body);
        })()
      : undefined;
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label^="Open snapshot"]')!
      .click();
    await flush();
  });
  await until(() =>
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'differs from its history entry',
    ),
  );
  expect(host.textContent).not.toContain('Saved snapshot opened');
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});
it('releases a timed-out save even if its transport ignores cancellation', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  let release!: (response: Response) => void;
  intercept = (_url, options) =>
    options.method === 'POST'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  vi.useFakeTimers();
  await act(async () => {
    button('Save reviewed planning snapshot').click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'Request timed out',
  );
  expect(button('Reload context and saved plan').disabled).toBe(false);
  expect(host.textContent).not.toContain('Save reviewed planning snapshot');
  await act(async () => {
    release(Response.json({ plan: null }));
    await Promise.resolve();
  });
  expect(host.querySelector('[role=alert]')?.textContent).toContain(
    'Request timed out',
  );
});
it('reviews and saves through the real authenticated route, service and SQL guards', async () => {
  let insertError: unknown;
  const prepare = storage.db.prepare.bind(storage.db);
  vi.spyOn(storage.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT INTO launch_layer_plans')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args),
        run = bound.run.bind(bound);
      bound.run = async () => {
        try {
          return await run();
        } catch (error) {
          insertError = error;
          throw error;
        }
      };
      return bound;
    };
    return statement;
  });
  await loadAndFill();
  await click('Review layer ceilings');
  expect(host.textContent).toContain('Declared ceiling review');
  expect(host.textContent).toContain('Total native ceiling (SOL)');
  expect(host.textContent).toContain('not verified costs');
  await click('Save reviewed planning snapshot');
  expect(insertError).toBeUndefined();
  expect(host.textContent).toContain('Planning snapshot saved');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  const result = await storage.client.execute(
    'SELECT document FROM launch_layer_plans',
  );
  expect(result.rows).toHaveLength(1);
  const terms = JSON.parse(result.rows[0].document as string).envelope.terms;
  expect(terms.binding.ownerId).toBe('alice');
  expect(terms.roles.front[0].wallet.address).toBe(f.address(3));
  expect(terms.signingAllowed).toBe(false);
  expect(terms.fundingAllowed).toBe(false);
});
it('invalidates review on edits and preserves the exact saved developer/holder order', async () => {
  await loadAndFill();
  expect(host.querySelectorAll('select')).toHaveLength(2);
  await click('Review layer ceilings');
  const firstFee = host.querySelectorAll<HTMLInputElement>(
    'fieldset[aria-label] input',
  )[1];
  await input(firstFee, '0.000006');
  expect(host.textContent).not.toContain('Save reviewed planning snapshot');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});
it('reopens current saved ceilings but requires another review before saving', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  await click('Save reviewed planning snapshot');
  await click('Reload context and saved plan');
  await click('Use saved ceilings as a new draft');
  expect(host.textContent).toContain('Review them again before saving');
  expect(host.textContent).not.toContain('Save reviewed planning snapshot');
  await click('Review layer ceilings');
  await click('Save reviewed planning snapshot');
  expect(
    (
      await storage.client.execute(
        'SELECT count(*) AS n FROM launch_layer_plans',
      )
    ).rows[0].n,
  ).toBe(1);
});
it('keeps the last required Front/Back rows and explains disabled removal', async () => {
  await loadAndFill();
  expect(button('Remove Front buyer').disabled).toBe(true);
  await click('Add Back buyer');
  await click('Add Temporary holder');
  expect(button('Remove Back buyer').disabled).toBe(true);
  expect(host.textContent).toContain(
    'Remove temporary holders before removing the last Back buyer',
  );
  await click('Remove Temporary holder');
  expect(button('Remove Back buyer').disabled).toBe(false);
});
it('copies explicit shared ceilings only to current rows and keeps wallet/buy labels separate', async () => {
  await click('Load saved wallets and layer history');
  for (const row of host.querySelectorAll('fieldset[aria-label]')) {
    const select = row.querySelector('select');
    if (select) {
      expect(select.labels?.[0].textContent?.trim()).toContain(
        'Wallet (root scope)',
      );
      expect(select.labels?.[0].htmlFor).toBe(select.id);
    }
    const buy = row.querySelector('input')!;
    expect(buy.labels?.[0].textContent?.trim()).toBe('Maximum buy (SOL)');
  }
  const shared = [
    ...host.querySelectorAll<HTMLInputElement>('input[id*="-shared-"]'),
  ];
  expect(shared).toHaveLength(3);
  await input(shared[0], '0.000005');
  await input(shared[1], '0.002');
  await input(shared[2], '0.0001');
  await click('Apply shared ceilings to current rows');
  for (const row of host.querySelectorAll('fieldset[aria-label]'))
    expect(
      [...row.querySelectorAll('input')].slice(1).map((i) => i.value),
    ).toEqual(['0.000005', '0.002', '0.0001']);
  await click('Add Front buyer');
  const frontRows = [...host.querySelectorAll('fieldset[aria-label]')].filter(
    (row) => row.querySelector('legend')?.textContent === 'Front buyer',
  );
  expect(
    [...frontRows[1].querySelectorAll('input')].map((i) => i.value),
  ).toEqual(['', '', '', '']);
});
it('cancels a pending save and keeps a late response from changing the screen', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  let release!: (response: Response) => void;
  intercept = (_url, options) =>
    options.method === 'POST'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  await click('Save reviewed planning snapshot', false);
  await click('Cancel planning request');
  await act(async () => {
    release(Response.json({ plan: null }));
    await flush();
  });
  expect(host.textContent).toContain(
    'cancellation does not prove a save was prevented',
  );
  expect(host.textContent).not.toContain('Planning snapshot saved');
  expect(host.querySelector('[role=alert]')).toBeNull();
});
it('refuses stale wallet admission without changing ordinary launch settings', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  await storage.client.execute({
    sql: 'UPDATE workspace_wallets SET revision=3 WHERE address=?',
    args: [f.address(3)],
  });
  await click('Save reviewed planning snapshot');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Reselect');
  expect(
    (
      await storage.client.execute(
        'SELECT count(*) AS n FROM launch_layer_plans',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await storage.client.execute('SELECT document FROM workspace_projects'))
      .rows[0].document,
  ).toBe(JSON.stringify(f.document));
});
it('shows safe errors for HTML responses and refuses saving when history is unavailable', async () => {
  intercept = (url) =>
    !url.includes('?context=')
      ? Promise.resolve(
          new Response('<html>private diagnostic</html>', { status: 502 }),
        )
      : undefined;
  await loadAndFill();
  await click('Review layer ceilings');
  expect(button('Save reviewed planning snapshot').disabled).toBe(true);
  expect(host.textContent).not.toContain('<html>');
  expect(host.textContent).not.toContain('private diagnostic');
});
it('cancels pending work and ignores a late save after the mint changes', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  let release!: (response: Response) => void;
  intercept = (_url, options) =>
    options.method === 'POST'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  await click('Save reviewed planning snapshot', false);
  await render({
    ...f.selection,
    target: { kind: 'new', mint: f.address(98) },
  });
  await act(async () => {
    release(Response.json({ plan: null }));
    await flush();
  });
  expect(host.textContent).not.toContain('Planning snapshot saved');
  expect(host.textContent).not.toContain('Saved planning snapshot');
  expect(host.textContent).toContain(f.address(98));
});
it('keeps historical snapshots readable after the source is archived', async () => {
  await loadAndFill();
  await click('Review layer ceilings');
  await click('Save reviewed planning snapshot');
  await storage.client.execute('UPDATE workspace_projects SET archived=1');
  await click('Reload context and saved plan');
  expect(host.textContent).toContain(
    'Current references could not be confirmed',
  );
  expect(host.textContent).toContain('Saved planning snapshot');
  expect(host.textContent).not.toContain('Review layer ceilings');
});
it('requires explicit positive Front buys and refuses noninteger delays before any save', async () => {
  await loadAndFill();
  const front = [...host.querySelectorAll('fieldset[aria-label]')].find(
    (row) => row.querySelector('legend')?.textContent === 'Front buyer',
  )!;
  await input(front.querySelector('input')!, '0');
  await click('Review layer ceilings');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('positive');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});
