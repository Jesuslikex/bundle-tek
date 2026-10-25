// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createTursoDatabase } from '@/db/turso';
import { fundingOwnerScope } from '@/lib/funding-owner-scope';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { exchangeFundingReviewFixture } from '@/test/exchange-funding-review-fixture';
import { FundingPlanner } from './funding-planner';
import { FUNDING_REQUEST_TIMEOUT_MS } from './use-funding-plan-storage';

// The historical execution children are outside draft-storage recovery scope.
vi.mock('./mainnet-funding-history', () => ({
  MainnetFundingHistoryPanel: () => null,
}));
vi.mock('./funding-execution-history', () => ({
  FundingExecutionHistoryPanel: () => null,
}));
const auth = vi.hoisted(() => ({
  owner: 'alice',
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: auth.owner }),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET, POST } from '@/app/api/funding/route';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let client: Client, root: Root, host: HTMLDivElement;
let listReply: (() => Promise<Response>) | null;
let writeReply: ((response: Response) => Promise<Response>) | null;
let readReply: (() => Promise<Response>) | null;
let writes: string[], writeFinished: ReturnType<typeof deferred<void>>;
let rewriteRequest: ((body: string) => string) | null;
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find(
    (value) => value.textContent?.trim() === text,
  );
  if (!found) throw Error('Missing button: ' + text);
  return found;
};
const click = async (text: string) => {
  await act(async () => {
    button(text).click();
  });
};
const edit = async (selector: string, value: string) => {
  await act(async () => {
    const element = host.querySelector(selector)!;
    const prototype =
      element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const mount = async () => {
  await act(async () => {
    root.render(<FundingPlanner plan={DEFAULT_LAUNCH_PLAN} />);
  });
};
const fill = async () => {
  await edit('#funding-name', 'Preserved funding draft');
  await edit(
    '[aria-label="Funding recipients"]',
    'So11111111111111111111111111111111111111112 0.012345678',
  );
};
const startSave = async () => {
  await act(async () => {
    button('Save funding draft').click();
    await writeFinished.promise;
  });
};
const advance = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(FUNDING_REQUEST_TIMEOUT_MS);
  });
};

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.stubGlobal('crypto', {
    randomUUID,
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => unknown,
      ) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held.delete(name);
        }
      },
    },
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T15:00:00.000Z'));
  auth.owner = 'alice';
  client = createClient({ url: ':memory:' });
  auth.db = createTursoDatabase(client);
  await client.executeMultiple(
    await readFile('drizzle/0007_superb_iron_monger.sql', 'utf8'),
  );
  listReply = null;
  writeReply = null;
  readReply = null;
  writes = [];
  writeFinished = deferred<void>();
  rewriteRequest = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options?: RequestInit) => {
      if (input === '/api/wallet-workspace')
        return Response.json({ wallets: [], folders: [] });
      if (!input.startsWith('/api/funding'))
        throw Error('Unexpected request: ' + input);
      if (options?.method === 'POST') {
        if (typeof options.body !== 'string')
          throw Error('Expected the exact JSON draft body.');
        writes.push(options.body);
        const response = await POST(
          new Request('https://bundle.test/api/funding', {
            ...options,
            body: rewriteRequest ? rewriteRequest(options.body) : options.body,
          }),
        );
        writeFinished.resolve();
        return writeReply ? writeReply(response) : response;
      }
      if (input === '/api/funding' && listReply) return listReply();
      if (input.startsWith('/api/funding?id=') && readReply) return readReply();
      return GET(new Request('https://bundle.test' + input, options));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
});

it('cancels stalled initial loading, ignores its late response and preserves edits on reload', async () => {
  const old = deferred<Response>();
  listReply = () => old.promise;
  await mount();
  await fill();
  await click('Cancel loading');
  expect(button('Reload saved plans').disabled).toBe(false);
  listReply = null;
  await click('Reload saved plans');
  await act(async () =>
    old.resolve(Response.json({ plans: [{ id: 'invalid late result' }] })),
  );
  expect((host.querySelector('#funding-name') as HTMLInputElement).value).toBe(
    'Preserved funding draft',
  );
  expect(host.textContent).not.toContain('invalid late result');
  expect(writes).toHaveLength(0);
});

it('normally saves and refreshes the selected revision without replacing current edits', async () => {
  await mount();
  await fill();
  await startSave();
  expect(host.textContent).toContain('Revision 1');
  expect(host.textContent).toContain('Funding draft saved. No funds moved.');
  expect(host.querySelector('[aria-label="Funding save recovery"]')).toBeNull();
  await edit('#funding-name', 'A deliberate second revision');
  writeFinished = deferred<void>();
  await act(async () => {
    button('Save changes').click();
    await writeFinished.promise;
  });
  expect(host.textContent).toContain('Revision 2');
  expect((host.querySelector('#funding-name') as HTMLInputElement).value).toBe(
    'A deliberate second revision',
  );
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(1);
  expect(
    (await client.execute('SELECT * FROM funding_events')).rows,
  ).toHaveLength(2);
  expect(writes).toHaveLength(2);
});

it('returns to editing after a definite route validation rejection without pretending it was saved', async () => {
  rewriteRequest = (body) => {
    const request = JSON.parse(body);
    request.document.currency = 'unsupported';
    return JSON.stringify(request);
  };
  await mount();
  await fill();
  await startSave();
  expect(host.textContent).toContain('was not accepted');
  expect(host.querySelector('[aria-label="Funding save recovery"]')).toBeNull();
  expect(button('Save funding draft').disabled).toBe(false);
  expect(button('New plan').disabled).toBe(false);
  expect((host.querySelector('#funding-name') as HTMLInputElement).value).toBe(
    'Preserved funding draft',
  );
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(0);
  expect(
    (await client.execute('SELECT * FROM funding_events')).rows,
  ).toHaveLength(0);
});
it('times out a stalled response body and makes Reload reachable without another request', async () => {
  listReply = async () =>
    ({
      ok: true,
      headers: new Headers({
        'x-bundle-funding-owner-scope': fundingOwnerScope(auth.owner),
      }),
      json: () => new Promise(() => {}),
    }) as Response;
  await mount();
  await fill();
  await advance();
  expect(host.textContent).toContain('timed out');
  expect(button('Reload saved plans').disabled).toBe(false);
  expect(writes).toHaveLength(0);
});
it.each([401, 502])(
  'shows readable HTTP %i errors while preserving the editor',
  async (status) => {
    listReply = async () =>
      new Response('<html>SECRET parser text</html>', { status });
    await mount();
    await fill();
    expect(host.textContent).not.toMatch(/SECRET|Unexpected token|JSON.parse/);
    expect(
      (host.querySelector('#funding-name') as HTMLInputElement).value,
    ).toBe('Preserved funding draft');
    expect(button('Reload saved plans').disabled).toBe(false);
  },
);
it('recovers a committed create with a lost response through the real owned route and SQL', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await advance();
  expect(host.textContent).toContain('Save outcome unknown');
  expect(button('Check save outcome').disabled).toBe(true);
  expect(button('New plan').disabled).toBe(true);
  expect(writes).toHaveLength(1);
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(host.textContent).toContain('Revision 1');
  expect((host.querySelector('#funding-name') as HTMLInputElement).value).toBe(
    'Preserved funding draft',
  );
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(1);
  expect(
    (await client.execute('SELECT * FROM funding_events')).rows,
  ).toHaveLength(1);
  expect(writes).toHaveLength(1);
});
it('explicitly retries the identical CAS request without creating a second draft or event', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await click('Stop waiting for save');
  writeReply = async (response) => response;
  await click('Retry exact same request');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(writes[0]);
  expect(host.textContent).toContain('Save outcome unknown');
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(1);
  expect(
    (await client.execute('SELECT * FROM funding_events')).rows,
  ).toHaveLength(1);
});
it('does not interpret a missing or old revision as proof that an abandoned write failed', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await click('Stop waiting for save');
  auth.owner = 'bob';
  await click('Check original save');
  expect(host.textContent).toContain('Account changed');
  expect(button('New plan').disabled).toBe(true);
  auth.owner = 'alice';
  await client.execute('UPDATE funding_plans SET revision=0');
  await click('Check original save');
  expect(
    host.querySelector('[aria-label="Funding save recovery"]'),
  ).not.toBeNull();
  expect(writes).toHaveLength(1);
});
it('keeps a mismatched acknowledgement unknown and ignores a late response after recovery', async () => {
  const late = deferred<Response>();
  writeReply = () => late.promise;
  await mount();
  await fill();
  await startSave();
  await click('Stop waiting for save');
  await click('Check original save');
  await act(async () =>
    late.resolve(Response.json({ id: 'wrong-id', revision: 99 })),
  );
  expect(host.textContent).toContain('Revision 1');
  expect(host.textContent).not.toContain('Revision 99');
  expect(writes).toHaveLength(1);
});
it('keeps wrong acknowledgements and stalled recovery blocked until a valid original read', async () => {
  writeReply = async () =>
    Response.json(
      { id: 'wrong-id', revision: 1 },
      {
        headers: {
          'x-bundle-funding-owner-scope': fundingOwnerScope(auth.owner),
        },
      },
    );
  await mount();
  await fill();
  await startSave();
  expect(host.textContent).toContain('Save outcome unknown');
  readReply = () => new Promise(() => {});
  await click('Check original save');
  await advance();
  expect(button('New plan').disabled).toBe(true);
  readReply = null;
  await click('Check original save');
  expect(host.textContent).toContain('Revision 1');
  expect(writes).toHaveLength(1);
});
it('reports a later winning revision as conflict without replacing the editor', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await click('Stop waiting for save');
  await client.execute(
    "UPDATE funding_plans SET revision=2,document=json_set(document,'$.name','Different writer')",
  );
  await click('Check original save');
  expect(host.textContent).toContain('different or later funding revision');
  expect(host.querySelector('[aria-label="Funding save recovery"]')).toBeNull();
  expect((host.querySelector('#funding-name') as HTMLInputElement).value).toBe(
    'Preserved funding draft',
  );
  expect(writes).toHaveLength(1);
});

it.each(['archive', 'restore', 'save'] as const)(
  'recovers a lost %s response at the exact existing revision',
  async (action) => {
    const document = exchangeFundingReviewFixture().plan.document;
    document.source = 'Manual';
    const seed = (operation: string, revision: number) =>
      POST(
        new Request('https://bundle.test/api/funding', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'existing-plan',
            action: operation,
            expectedRevision: revision,
            document,
          }),
        }),
      );
    expect((await seed('save', 0)).status).toBe(200);
    if (action === 'restore')
      expect((await seed('archive', 1)).status).toBe(200);
    await mount();
    writeReply = () => new Promise(() => {});
    if (action === 'save') {
      await act(async () =>
        (
          host.querySelector('.funding-saved-row button') as HTMLButtonElement
        ).click(),
      );
      await edit('#funding-name', 'Updated existing draft');
    }
    await act(async () => {
      button(
        action === 'save'
          ? 'Save changes'
          : action === 'archive'
            ? 'Archive'
            : 'Restore',
      ).click();
      await writeFinished.promise;
    });
    await click('Stop waiting for save');
    await click('Check original save');
    expect(host.textContent).toContain('confirmed in saved history');
    const rows = (await client.execute('SELECT * FROM funding_plans')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(action === 'restore' ? 3 : 2);
    expect(rows[0].archived).toBe(action === 'archive' ? 1 : 0);
    expect(writes).toHaveLength(1);
  },
);

it('admits only one save on a double click and ignores its late result after unmount', async () => {
  const late = deferred<Response>();
  writeReply = () => late.promise;
  await mount();
  await fill();
  await act(async () => {
    const save = button('Save funding draft');
    save.click();
    save.click();
    await writeFinished.promise;
  });
  expect(writes).toHaveLength(1);
  const request = JSON.parse(writes[0]);
  await act(async () => root.render(<p>Different screen</p>));
  const calls = vi.mocked(fetch).mock.calls.length;
  await act(async () =>
    late.resolve(Response.json({ id: request.id, revision: 1 })),
  );
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(host.textContent).toBe('Different screen');
});

const recoveryKeys = () =>
  Object.keys(localStorage).filter((key) =>
    key.startsWith('bundle-funding-save:'),
  );
const remount = async () => {
  await act(async () => root.render(<p>Another screen</p>));
  await mount();
};
it('recovers the original committed create after reload without retaining allocations or posting again', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  const key = recoveryKeys()[0],
    text = localStorage.getItem(key)!;
  expect(JSON.parse(text)).toEqual({
    format: 'funding-save-reminder-v1',
    ownerScope: expect.stringMatching(/^[a-f0-9]{64}$/),
    id: JSON.parse(writes[0]).id,
    action: 'save',
    expectedRevision: 0,
    documentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(text).not.toContain('Preserved funding draft');
  expect(text).not.toContain('So111111');
  expect(text).not.toContain('0.012345678');
  await remount();
  expect(writes).toHaveLength(1);
  expect(
    host.querySelector('[aria-label="Funding save recovery"]'),
  ).not.toBeNull();
  expect(button('Retry exact same request').disabled).toBe(true);
  expect(button('New plan').disabled).toBe(true);
  await click('Check original save');
  expect(writes).toHaveLength(1);
  expect(host.textContent).toContain('confirmed in saved history');
  expect(host.textContent).toContain('Open the saved plan explicitly');
  expect(recoveryKeys()).toHaveLength(0);
  expect(host.textContent).not.toContain('Revision 1');
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(1);
  expect(
    (await client.execute('SELECT * FROM funding_events')).rows,
  ).toHaveLength(1);
});
it.each(['archive', 'restore', 'save'] as const)(
  'retains and explicitly recovers a lost %s result across remount',
  async (action) => {
    const document = exchangeFundingReviewFixture().plan.document;
    document.source = 'Manual';
    const seed = async (action: string, expectedRevision: number) =>
      POST(
        new Request('https://bundle.test/api/funding', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'retained-existing',
            action,
            expectedRevision,
            document,
          }),
        }),
      );
    expect((await seed('save', 0)).status).toBe(200);
    if (action === 'restore')
      expect((await seed('archive', 1)).status).toBe(200);
    await mount();
    writeReply = () => new Promise(() => {});
    if (action === 'save') {
      await act(async () =>
        (
          host.querySelector('.funding-saved-row button') as HTMLButtonElement
        ).click(),
      );
      await edit('#funding-name', 'Updated before remount');
    }
    await act(async () => {
      button(
        action === 'save'
          ? 'Save changes'
          : action === 'archive'
            ? 'Archive'
            : 'Restore',
      ).click();
      await writeFinished.promise;
    });
    await remount();
    expect(writes).toHaveLength(1);
    expect(button('Retry exact same request').disabled).toBe(true);
    await click('Check original save');
    expect(host.textContent).toContain('confirmed in saved history');
    expect(writes).toHaveLength(1);
    expect(recoveryKeys()).toHaveLength(0);
  },
);
it('keeps a missing original unknown after reload instead of enabling a replacement save', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await client.execute('DELETE FROM funding_plans');
  await remount();
  await click('Check original save');
  expect(host.textContent).toContain('not visible yet');
  expect(button('New plan').disabled).toBe(true);
  expect(recoveryKeys()).toHaveLength(1);
  expect(writes).toHaveLength(1);
});
it('isolates retained records between authenticated accounts and rediscovers the old account record', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  const aliceKey = recoveryKeys()[0],
    aliceRecord = localStorage.getItem(aliceKey);
  auth.owner = 'bob';
  await remount();
  expect(host.querySelector('[aria-label="Funding save recovery"]')).toBeNull();
  expect(localStorage.getItem(aliceKey)).toBe(aliceRecord);
  expect(writes).toHaveLength(1);
  auth.owner = 'alice';
  await click('Reload saved plans');
  expect(
    host.querySelector('[aria-label="Funding save recovery"]'),
  ).not.toBeNull();
  expect(writes).toHaveLength(1);
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(recoveryKeys()).toHaveLength(0);
});
it('does not send a write when durable storage or cross-tab browser protection is unavailable', async () => {
  await mount();
  await fill();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('PRIVATE quota diagnostic');
  });
  await click('Save funding draft');
  expect(writes).toHaveLength(0);
  expect(host.textContent).toContain('recovery storage');
  expect(host.textContent).not.toContain('PRIVATE');
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'locks');
  await click('Reload saved plans');
  expect(button('Save funding draft').disabled).toBe(true);
  expect(host.textContent).toContain('protect funding saves across tabs');
  expect(writes).toHaveLength(0);
});
it('retains corrupt local recovery data and blocks a new save without displaying raw contents', async () => {
  const scope = (
    await GET(new Request('https://bundle.test/api/funding'))
  ).headers.get('x-bundle-funding-owner-scope')!;
  localStorage.setItem('bundle-funding-save:' + scope, 'PRIVATE not JSON');
  await mount();
  await fill();
  expect(button('Save funding draft').disabled).toBe(true);
  expect(host.textContent).toContain('recovery storage');
  expect(host.textContent).not.toContain('PRIVATE');
  expect(localStorage.getItem('bundle-funding-save:' + scope)).toBe(
    'PRIVATE not JSON',
  );
  expect(writes).toHaveLength(0);
});

it('uses one cross-tab critical section and adopts the original pending save rather than posting a second draft', async () => {
  const otherHost = document.createElement('div');
  document.body.appendChild(otherHost);
  const otherRoot = createRoot(otherHost);
  try {
    await mount();
    await fill();
    await act(async () =>
      otherRoot.render(<FundingPlanner plan={DEFAULT_LAUNCH_PLAN} />),
    );
    const otherEdit = async (selector: string, value: string) =>
      act(async () => {
        const element = otherHost.querySelector(selector)!;
        const prototype =
          element.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
          element,
          value,
        );
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const otherButton = (text: string) =>
      [...otherHost.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === text,
      )!;
    await otherEdit('#funding-name', 'Another tab draft');
    await otherEdit(
      '[aria-label="Funding recipients"]',
      'So11111111111111111111111111111111111111112 0.1',
    );
    writeReply = () => new Promise(() => {});
    await startSave();
    await act(async () => otherButton('Save funding draft').click());
    expect(writes).toHaveLength(1);
    expect(otherHost.textContent).toContain('Another tab');
    await click('Stop waiting for save');
    await act(async () => otherButton('Save funding draft').click());
    expect(writes).toHaveLength(1);
    expect(
      otherHost.querySelector('[aria-label="Funding save recovery"]'),
    ).not.toBeNull();
    expect(otherButton('Retry exact same request').disabled).toBe(true);
    await act(async () => otherButton('Check original save').click());
    expect(writes).toHaveLength(1);
    expect(otherHost.textContent).toContain('confirmed in saved history');
    expect(recoveryKeys()).toHaveLength(0);
  } finally {
    await act(async () => otherRoot.unmount());
    otherHost.remove();
  }
});
it('never erases a different recovery record when its acknowledgement arrives', async () => {
  const late = deferred<Response>();
  let ack: Response | undefined;
  writeReply = (response) => {
    ack = response;
    return late.promise;
  };
  await mount();
  await fill();
  await startSave();
  const key = recoveryKeys()[0];
  const replacement = {
    ...JSON.parse(localStorage.getItem(key)!),
    id: 'another-pending-draft',
    documentHash: 'b'.repeat(64),
  };
  const text = JSON.stringify(replacement);
  localStorage.setItem(key, text);
  await act(async () => late.resolve(ack!));
  expect(localStorage.getItem(key)).toBe(text);
  expect(writes).toHaveLength(1);
  expect(host.textContent).toContain('changed in another tab');
  expect(button('New plan').disabled).toBe(true);
});
it('keeps a missing-owner-scope acknowledgement unknown without losing the original reminder', async () => {
  writeReply = async (response) => Response.json(await response.json());
  await mount();
  await fill();
  await startSave();
  expect(
    host.querySelector('[aria-label="Funding save recovery"]'),
  ).not.toBeNull();
  expect(recoveryKeys()).toHaveLength(1);
  expect(button('New plan').disabled).toBe(true);
  expect(writes).toHaveLength(1);
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(recoveryKeys()).toHaveLength(0);
  expect(writes).toHaveLength(1);
});

it('clears only a definitively rejected first POST when the account changes before it reaches the route', async () => {
  await mount();
  await fill();
  auth.owner = 'bob';
  await startSave();
  expect(writes).toHaveLength(1);
  expect(
    (await client.execute('SELECT * FROM funding_plans')).rows,
  ).toHaveLength(0);
  expect(host.textContent).toContain('changed before this save');
  expect(recoveryKeys()).toHaveLength(0);
  await click('Reload saved plans');
  expect(
    (
      host.querySelector(
        '[aria-label="Funding recipients"]',
      ) as HTMLTextAreaElement
    ).value,
  ).toBe('');
});
it('never uses a later account-mismatch rejection to clear an earlier unknown write', async () => {
  writeReply = () => new Promise(() => {});
  await mount();
  await fill();
  await startSave();
  await click('Stop waiting for save');
  auth.owner = 'bob';
  writeReply = async (response) => response;
  await click('Retry exact same request');
  expect(writes).toHaveLength(2);
  expect(recoveryKeys()).toHaveLength(1);
  expect(button('New plan').disabled).toBe(true);
  auth.owner = 'alice';
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(recoveryKeys()).toHaveLength(0);
});
it('keeps an accepted-but-not-committed HTTP202 acknowledgement unknown until an exact saved read', async () => {
  writeReply = async (response) =>
    Response.json(await response.json(), {
      status: 202,
      headers: response.headers,
    });
  await mount();
  await fill();
  await startSave();
  expect(
    host.querySelector('[aria-label="Funding save recovery"]'),
  ).not.toBeNull();
  expect(button('New plan').disabled).toBe(true);
  expect(writes).toHaveLength(1);
  await click('Check original save');
  expect(host.textContent).toContain('confirmed in saved history');
  expect(writes).toHaveLength(1);
});
