// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MeteoraDbcLaunchReview } from './meteora-dbc-launch-review';
import { StonkfunLaunchReview } from './stonkfun-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
const mocks = vi.hoisted(() => ({
  unlock: vi.fn(),
  mint: vi.fn(),
  sign: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_MIN_PASSWORD_LENGTH: 8,
  VAULT_STORAGE_KEY: 'fixture-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/pump-mint-vault', () => ({
  pumpMintStorageKey: (p: string) => 'fixture-mint:' + p,
  parsePumpMintBackup: () => ({
    mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  }),
  unlockPumpMint: mocks.mint,
  clearMintSession: mocks.clear,
  createPumpMint: vi.fn(),
  persistPumpMint: vi.fn(),
}));
vi.mock('@/lib/meteora-dbc-launch-signing', () => ({
  signMeteoraDbcLaunch: mocks.sign,
}));
vi.mock('@/lib/stonkfun-launch-signing', () => ({
  signStonkLaunch: mocks.sign,
}));
const project = {
  id: 'project-a',
  updatedAt: '2026-10-23T00:00:00.000Z',
  payer: {
    address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    revision: 1,
  },
};
const releaseId = 'a'.repeat(64),
  mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  recoveryId = '11111111-1111-4111-8111-111111111111';
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
function review(venue: string) {
  return {
    format:
      venue === 'meteora-dbc'
        ? 'meteora-dbc-launch-review-v1'
        : 'stonkfun-launch-review-v1',
    terms: {
      projectId: project.id,
      updatedAt: project.updatedAt,
      releaseId,
      payer: project.payer.address,
      payerRevision: 1,
      mint,
      config: mint,
      devBuyRaw: '0',
      solLimitLamports: '50000000',
    },
    input: {
      name: 'Fixture coin',
      symbol: 'FIX',
      mint,
      quoteMint: 'So11111111111111111111111111111111111111112',
    },
    transaction: 'unsigned-fixture',
    sha256: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    summary: {
      config: mint,
      feeClaimer: mint,
      pool: mint,
      quoteSymbol: 'SOL',
      quoteDecimals: 9,
      baseDecimals: 6,
      tokenStandard: 'SPL',
      migrationThresholdRaw: '1000000000',
      creatorTradingFeePercent: 0,
      devBuyRaw: '0',
      tokensOutRaw: '0',
      devSupplyBps: 0,
      poolCreationFeeLamports: '0',
      solCostLamports: '10000',
      platformName: 'Fixture',
      raiseRaw: '1000000000',
    },
  };
}
function setup(venue: string, state = 'review') {
  const r = review(venue);
  let saved = {
    format: 'venue-launch-recovery-v1',
    id: recoveryId,
    venue,
    projectId: project.id,
    review: r,
    state,
    signature: ['signed', 'submitting', 'submitted', 'finalized'].includes(
      state,
    )
      ? '1'.repeat(64)
      : null,
    receipt: null,
    createdAt: new Date().toISOString(),
  };
  const posts: Record<string, unknown>[] = [];
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method)
      return Response.json(
        url.includes('projectId=') ? { launches: [saved] } : saved,
      );
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '');
    posts.push(body);
    if (body.action === 'approve') saved = { ...saved, state: 'approved' };
    if (body.action === 'register')
      saved = { ...saved, state: 'signed', signature: '1'.repeat(64) };
    if (body.action === 'submit') saved = { ...saved, state: 'submitted' };
    if (body.action === 'cancel') saved = { ...saved, state: 'cancelled' };
    return Response.json(saved);
  });
  return {
    r,
    posts,
    get saved() {
      return saved;
    },
    set saved(v) {
      saved = v;
    },
  };
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
async function render(venue: string, props = project) {
  await act(async () =>
    root.render(
      venue === 'meteora-dbc' ? (
        <MeteoraDbcLaunchReview
          project={props}
          plan={{
            ...DEFAULT_LAUNCH_PLAN,
            tokenName: 'Fixture coin',
            ticker: 'FIX',
            launchpad: 'Meteora DBC',
            currency: 'SOL',
          }}
          releaseId={releaseId}
        />
      ) : (
        <StonkfunLaunchReview
          project={props}
          plan={{
            ...DEFAULT_LAUNCH_PLAN,
            tokenName: 'Fixture coin',
            ticker: 'FIX',
            launchpad: 'StonkFun',
            currency: 'SOL',
          }}
          releaseId={releaseId}
        />
      ),
    ),
  );
  await settle();
}
function button(text: string) {
  const b = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!b) throw Error('Missing button ' + text + ':' + container.textContent);
  return b;
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function select() {
  await click('review · Fixture coin');
}
async function input(label: string, value: string) {
  const l = [...container.querySelectorAll('label')].find((x) =>
    x.textContent?.includes(label),
  );
  const e =
    l?.querySelector('input') ??
    container.querySelector<HTMLInputElement>('#' + l?.htmlFor);
  if (!e) throw Error(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function checked(label: string) {
  const l = [...container.querySelectorAll('label')].find((x) =>
    x.textContent?.includes(label),
  );
  await act(async () => l?.querySelector('input')?.click());
}
async function sign() {
  await checked('I approve this exact');
  await input('Wallet vault passphrase', 'password1');
  await input('Mint key passphrase', 'password2');
  await click('Approve and sign only');
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  localStorage.setItem('fixture-mint:' + project.id, 'fixture');
  localStorage.setItem('fixture-vault', 'encrypted');
  fetcher.mockReset();
  mocks.unlock.mockReset().mockResolvedValue({ kind: 'payer' });
  mocks.mint.mockReset().mockResolvedValue({ kind: 'mint' });
  mocks.sign.mockReset().mockImplementation(async (_p, _m, _r, current) => {
    current();
    return { transaction: 'signed-fixture', signature: '1'.repeat(64) };
  });
  mocks.clear.mockClear();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
for (const venue of ['meteora-dbc', 'stonkfun']) {
  it(`${venue}: mounts only saved-history GET and restores exact review without signing`, async () => {
    const f = setup(venue);
    await render(venue);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.posts).toEqual([]);
    await select();
    expect(container.textContent).toContain('Fixture coin');
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(f.posts).toEqual([]);
  });
  it(`${venue}: saves approval before signing, registers without sending, then needs separate unchecked broadcast`, async () => {
    const f = setup(venue);
    await render(venue);
    await select();
    await sign();
    expect(f.posts.map((p) => p.action)).toEqual(['approve', 'register']);
    expect(f.posts[0]).toEqual({
      action: 'approve',
      id: recoveryId,
      sha256: f.r.sha256,
      approved: true,
    });
    expect(f.posts[1]).toEqual({
      action: 'register',
      id: recoveryId,
      transaction: 'signed-fixture',
    });
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(button('Broadcast saved launch once').disabled).toBe(true);
    await checked('I approve broadcasting');
    await click('Broadcast saved launch once');
    expect(f.posts.map((p) => p.action)).toEqual([
      'approve',
      'register',
      'submit',
    ]);
    expect(f.posts[2]).toEqual({
      action: 'submit',
      id: recoveryId,
      sha256: f.r.sha256,
      approved: true,
    });
    expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it(`${venue}: restores signed record with no key access and recovery never resends`, async () => {
    const f = setup(venue, 'signed');
    await render(venue);
    await click('signed · Fixture coin');
    expect(button('Broadcast saved launch once').disabled).toBe(true);
    await click('Recover saved launch status');
    expect(f.posts.map((p) => p.action)).toEqual(['recover']);
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it(`${venue}: uncertain register keeps original ID and blocks broadcast/new prepare until recovery`, async () => {
    const f = setup(venue);
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (
        init?.body &&
        JSON.parse(typeof init.body === 'string' ? init.body : '').action ===
          'register'
      )
        throw Error('lost reply');
      return base(url, init);
    });
    await render(venue);
    await select();
    await sign();
    expect(container.textContent).toContain('Recover the original ID');
    expect(
      JSON.parse(
        localStorage.getItem(
          `bundle-venue-launch-recovery:${venue}:${project.id}`,
        )!,
      ),
    ).toMatchObject({ id: recoveryId, stage: 'register' });
    expect(button('Prepare and simulate').disabled).toBe(true);
    expect(f.posts.some((p) => p.action === 'submit')).toBe(false);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    await click('Recover original launch');
    expect(f.posts.at(-1)?.action).toBe('recover');
  });
  it(`${venue}: original expiry is checked at broadcast click without timer advance`, async () => {
    const f = setup(venue, 'signed');
    await render(venue);
    await click('signed · Fixture coin');
    await checked('I approve broadcasting');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.r.expiresAt));
    await click('Broadcast saved launch once');
    expect(f.posts).toEqual([]);
    expect(container.textContent).toContain('broadcast window expired');
  });
}
it('context change invalidates a pending approval before any key unlock or signing', async () => {
  setup('meteora-dbc');
  const base = fetcher.getMockImplementation()!;
  let resolve!: (r: Response) => void;
  fetcher.mockImplementation((url, init) =>
    init?.body &&
    JSON.parse(typeof init.body === 'string' ? init.body : '').action ===
      'approve'
      ? new Promise<Response>((r) => {
          resolve = r;
        })
      : base(url, init),
  );
  await render('meteora-dbc');
  await select();
  await checked('I approve this exact');
  await input('Wallet vault passphrase', 'password1');
  await input('Mint key passphrase', 'password2');
  await act(async () => button('Approve and sign only').click());
  await render('meteora-dbc', {
    ...project,
    updatedAt: '2026-10-23T01:00:00.000Z',
  });
  const r = review('meteora-dbc');
  resolve(
    Response.json({
      format: 'venue-launch-recovery-v1',
      id: recoveryId,
      venue: 'meteora-dbc',
      projectId: project.id,
      review: r,
      state: 'approved',
      signature: null,
      receipt: null,
      createdAt: new Date().toISOString(),
    }),
  );
  await settle();
  expect(mocks.unlock).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('blocked browser storage refuses approval before POST or unlocking keys', async () => {
  const f = setup('stonkfun');
  await render('stonkfun');
  await select();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await sign();
  expect(f.posts).toEqual([]);
  expect(mocks.unlock).not.toHaveBeenCalled();
});
it('HTML history failure stays a generic recovery error and cannot prepare', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>private parser stack</html>', { status: 502 }),
  );
  await render('stonkfun');
  expect(container.textContent).toContain('Launch response unavailable');
  expect(container.textContent).not.toContain('private parser stack');
  expect(button('Prepare and simulate').disabled).toBe(true);
});

for (const venue of ['meteora-dbc', 'stonkfun']) {
  it(`${venue}: preparation retains original ID then reads its exact saved row`, async () => {
    const f = setup(venue);
    const base = fetcher.getMockImplementation()!;
    let first = true;
    fetcher.mockImplementation(async (url, init) => {
      if (first && !init?.method) {
        first = false;
        return Response.json({ launches: [] });
      }
      if (
        init?.body &&
        JSON.parse(typeof init.body === 'string' ? init.body : '').action ===
          'prepare'
      ) {
        f.posts.push(
          JSON.parse(typeof init.body === 'string' ? init.body : ''),
        );
        return Response.json({ ...f.r, recoveryId });
      }
      return base(url, init);
    });
    await render(venue);
    if (venue === 'meteora-dbc') await input('DBC config', mint);
    await click('Prepare and simulate');
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toMatchObject({
      action: 'prepare',
      terms: { projectId: project.id, mint, payerRevision: 1 },
    });
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).endsWith('?id=' + recoveryId),
      ),
    ).toBe(true);
    expect(container.textContent).toContain('Saved launch status: review');
    expect(mocks.unlock).not.toHaveBeenCalled();
  });
  it(`${venue}: cancel permits a new unsigned preparation without renewing old history`, async () => {
    const f = setup(venue);
    await render(venue);
    await select();
    expect(button('Prepare and simulate').disabled).toBe(true);
    await click('Cancel unsigned launch');
    expect(f.posts.map((p) => p.action)).toEqual(['cancel']);
    expect(button('Prepare and simulate').disabled).toBe(false);
    expect(container.textContent).toContain('Saved launch status: cancelled');
    expect(button('Approve and sign only').disabled).toBe(true);
  });
}

for (const venue of ['meteora-dbc', 'stonkfun'])
  it(`${venue}: lost submit reply recovers the original submitting record without a second send`, async () => {
    const f = setup(venue, 'signed');
    const base = fetcher.getMockImplementation()!;
    let submits = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (
        init?.body &&
        JSON.parse(typeof init.body === 'string' ? init.body : '').action ===
          'submit'
      ) {
        submits++;
        f.saved = { ...f.saved, state: 'submitting' };
        throw Error('lost network reply');
      }
      return base(url, init);
    });
    await render(venue);
    await click('signed · Fixture coin');
    await checked('I approve broadcasting');
    await click('Broadcast saved launch once');
    expect(submits).toBe(1);
    expect(button('Broadcast saved launch once').disabled).toBe(true);
    expect(container.textContent).toContain('Recover the original ID');
    await click('Recover original launch');
    expect(submits).toBe(1);
    expect(f.posts.map((p) => p.action)).toEqual(['recover']);
    expect(container.textContent).toContain('Saved launch status: submitting');
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Broadcast saved launch once'),
      ),
    ).toBe(false);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
it('another unresolved original ID cannot be bypassed by selecting a different history row', async () => {
  setup('stonkfun');
  const other = '22222222-2222-4222-8222-222222222222';
  localStorage.setItem(
    `bundle-venue-launch-recovery:stonkfun:${project.id}`,
    JSON.stringify({ id: other, stage: 'submit' }),
  );
  await render('stonkfun');
  await select();
  expect(container.textContent).toContain(
    'Recover the original unresolved launch ID first',
  );
  expect(
    JSON.parse(
      localStorage.getItem(
        `bundle-venue-launch-recovery:stonkfun:${project.id}`,
      )!,
    ),
  ).toEqual({ id: other, stage: 'submit' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(mocks.sign).not.toHaveBeenCalled();
});

for (const venue of ['meteora-dbc', 'stonkfun']) {
  it(`${venue}: stale terminal history cannot clear a lost prepare reminder`, async () => {
    const f = setup(venue, 'cancelled');
    const base = fetcher.getMockImplementation()!;
    const activeId = '33333333-3333-4333-8333-333333333333';
    fetcher.mockImplementation(async (url, init) => {
      if (init?.body && JSON.parse(String(init.body)).action === 'prepare') {
        f.saved = { ...f.saved, id: activeId, state: 'review' };
        throw Error('Lost prepare response');
      }
      return base(url, init);
    });
    await render(venue);
    if (venue === 'meteora-dbc') await input('DBC config', mint);
    await click('Prepare and simulate');
    await click('cancelled · Fixture coin');
    const key = `bundle-venue-launch-recovery:${venue}:${project.id}`;
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      id: '',
      stage: 'prepare',
    });
    expect(container.textContent).toContain(
      'Select the original active launch',
    );
    expect(button('Prepare and simulate').disabled).toBe(true);
    await select();
    expect(localStorage.getItem(key)).toBeNull();
    expect(container.textContent).toContain('Saved launch status: review');
    expect(mocks.unlock).not.toHaveBeenCalled();
  });
  it(`${venue}: explicit owned history selection resolves a lost prepare reminder across reloads`, async () => {
    setup(venue);
    const base = fetcher.getMockImplementation()!;
    let first = true;
    fetcher.mockImplementation(async (url, init) => {
      if (first && !init?.method) {
        first = false;
        return Response.json({ launches: [] });
      }
      if (
        init?.body &&
        JSON.parse(typeof init.body === 'string' ? init.body : '').action ===
          'prepare'
      )
        throw Error('Lost prepare response');
      return base(url, init);
    });
    await render(venue);
    if (venue === 'meteora-dbc') await input('DBC config', mint);
    await click('Prepare and simulate');
    const key = `bundle-venue-launch-recovery:${venue}:${project.id}`;
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      id: '',
      stage: 'prepare',
    });
    await click('Reload saved launches');
    expect(container.textContent).toContain(
      'A launch action may have been saved',
    );
    await select();
    expect(localStorage.getItem(key)).toBeNull();
    await click('Reload saved launches');
    expect(container.textContent).not.toContain(
      'A launch action may have been saved',
    );
    expect(mocks.unlock).not.toHaveBeenCalled();
  });
  for (const changed of ['revision', 'payer', 'release'])
    it(`${venue}: historical ${changed} mismatch cannot unlock or sign`, async () => {
      const f = setup(venue);
      if (changed === 'revision')
        f.r.terms.updatedAt = '2026-10-22T00:00:00.000Z';
      if (changed === 'payer')
        f.r.terms.payer = '11111111111111111111111111111111';
      if (changed === 'release') f.r.terms.releaseId = 'c'.repeat(64);
      await render(venue);
      await select();
      await checked('I approve this exact');
      await input('Wallet vault passphrase', 'password1');
      await input('Mint key passphrase', 'password2');
      expect(button('Approve and sign only').disabled).toBe(true);
      expect(container.textContent).toContain(
        'signing from changed setup is disabled',
      );
      expect(mocks.unlock).not.toHaveBeenCalled();
      expect(f.posts).toEqual([]);
      await click('Recover original launch');
      expect(f.posts.map((p) => p.action)).toEqual(['recover']);
    });
}

it('HTML 401 explains sign-in before parsing its body', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>secret upstream</html>', { status: 401 }),
  );
  await render('stonkfun');
  expect(container.textContent).toContain(
    'Sign in to recover your saved launches',
  );
  expect(container.textContent).not.toContain('secret upstream');
  expect(button('Prepare and simulate').disabled).toBe(true);
});
it('oversized successful history body refuses without exposing its content', async () => {
  fetcher.mockResolvedValue(
    Response.json({ launches: [], padding: 'x'.repeat(1048576) }),
  );
  await render('stonkfun');
  expect(container.textContent).toContain('Launch response unavailable');
  expect(button('Prepare and simulate').disabled).toBe(true);
});
