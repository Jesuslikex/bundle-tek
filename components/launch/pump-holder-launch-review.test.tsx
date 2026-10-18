// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://bundle.test"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PumpHolderLaunchReview } from './pump-holder-launch-review';
import { pumpHolderClientFixture } from '../../test/pump-holder-client-fixture';
import { holderDisplayRaw } from '@/lib/pump-holder-launch-client';
const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  verify: vi.fn(),
  wallet: vi.fn(),
  mint: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@/lib/pump-mint-vault', () => ({
  parsePumpMintBackup: JSON.parse,
  pumpMintStorageKey: (id: string) => 'mint:' + id,
  unlockPumpMint: mocks.mint,
  clearMintSession: mocks.clear,
  createPumpMint: vi.fn(),
  persistPumpMint: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'test-vault',
  unlockVault: mocks.wallet,
}));
vi.mock('@/lib/pump-holder-signing', async (original) => ({
  ...(await original<typeof import('@/lib/pump-holder-signing')>()),
  signPumpHolderPacket: mocks.sign,
  verifyPumpHolderSignedPacket: mocks.verify,
}));
let container: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof pumpHolderClientFixture>>,
  saved: typeof f.launch,
  calls: Record<string, unknown>[],
  beforeResponse: (action: string) => Promise<void>;
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
const label = (text: string) =>
  [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.trim().startsWith(text))!
    .querySelector('input')!;
async function settle() {
  for (
    let i = 0;
    i < 300 &&
    container.textContent?.includes('Checking complete holder launch');
    i++
  )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
}
const click = async (text: string) => {
  await act(async () => button(text).click());
  await settle();
};
const input = (text: string, value: string) =>
  act(() => {
    const field = label(text);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const check = (text: string) => act(() => label(text).click());
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  f = await pumpHolderClientFixture(window.location.origin);
  saved = JSON.parse(JSON.stringify(f.launch));
  calls = [];
  beforeResponse = async () => {};
  localStorage.clear();
  localStorage.setItem(
    'mint:' + f.project.id,
    JSON.stringify({
      projectId: f.project.id,
      mint: f.launch.review.input.create.mint,
      encrypted: 'synthetic envelope',
    }),
  );
  localStorage.setItem('test-vault', 'encrypted synthetic wallet vault');
  mocks.sign
    .mockReset()
    .mockImplementation(async (_sessions, review, _consent, current) => {
      current();
      return {
        transaction: 'existing synthetic signed packet',
        reviewId: review.id,
      };
    });
  mocks.verify.mockReset().mockResolvedValue('2'.repeat(88));
  mocks.wallet.mockReset().mockResolvedValue({ payload: { wallets: [] } });
  mocks.mint.mockReset().mockResolvedValue({ payload: { wallets: [] } });
  mocks.clear.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (!init?.body) return Response.json({ launches: [saved] });
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      calls.push(body);
      if (path === '/api/launch/pump/preflight')
        return Response.json(f.observation);
      await beforeResponse(body.action);
      if (body.action === 'approve')
        saved = { ...saved, state: 'approved', signingAllowed: true };
      if (body.action === 'register')
        saved = {
          ...saved,
          state: 'signed',
          signingAllowed: false,
          signature: '2'.repeat(88),
        };
      if (body.action === 'submit') saved = { ...saved, state: 'submitted' };
      if (body.action === 'cancel') saved = { ...saved, state: 'cancelled' };
      return Response.json(saved);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PumpHolderLaunchReview project={f.project} releaseId={f.releaseId} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function prepare() {
  input('Deployer maximum', '0.01');
  input(
    'Maximum developer buy spend',
    holderDisplayRaw('100000000', f.built.quote.decimals),
  );
  await click('Read current holder targets');
  if (f.launch.review.input.holders[0].kind === 'exact-quote-input') {
    input('Holder 1 minimum tokens received', '0.000001');
    input('Holder 2 minimum tokens received', '0.000001');
  } else {
    input(
      'Holder 1 maximum quote spend',
      holderDisplayRaw('100000000', f.built.quote.decimals),
    );
    input(
      'Holder 2 maximum quote spend',
      holderDisplayRaw('100000000', f.built.quote.decimals),
    );
  }
  check('I saved');
  await click('Simulate complete holder launch');
}
function consent() {
  input('Mint backup passphrase', 'synthetic mint pass');
  input('Wallet vault passphrase', 'synthetic wallet pass');
  check('I approve signing');
  check('I understand simulation');
}
it('prepares every holder in order, displays zero slots and simulated costs without signing', async () => {
  await prepare();
  expect(calls[1]).toMatchObject({
    action: 'prepare',
    feeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
    holderLimits: [
      {
        address: f.launch.review.input.holders[0].address,
        feeAndRentLimitRaw: '10000000',
        maximumQuoteCostRaw: '100000000',
      },
      {
        address: f.launch.review.input.holders[1].address,
        feeAndRentLimitRaw: '10000000',
        maximumQuoteCostRaw: '100000000',
      },
      {
        address: f.launch.review.input.holders[2].address,
        feeAndRentLimitRaw: '0',
      },
    ],
  });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
  expect(container.textContent).toContain('No buy');
  expect(container.textContent).toContain(
    'Complete packet: wallet limits and simulated settlement',
  );
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('opens planning with the actual mint candidate without unlocking or signing', async () => {
  await click('Plan Front / Back layers');
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector(
        'section[aria-label="Front and Back layer planning"]',
      ),
    ).not.toBeNull();
  });
  const panel = container.querySelector(
    'section[aria-label="Front and Back layer planning"]',
  )!;
  expect(panel.textContent).toContain(f.launch.review.input.create.mint);
  expect(panel.textContent).toContain(
    'Saving here does not configure the ordinary launch below',
  );
  expect(mocks.wallet).not.toHaveBeenCalled();
  expect(mocks.mint).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('requires two signing consents and separate broadcast consent, passes the complete signer map and clears both sessions', async () => {
  await prepare();
  consent();
  await click('Approve and sign complete holder launch');
  expect(calls.map((c) => c.action).filter(Boolean)).toEqual([
    'prepare',
    'approve',
    'register',
  ]);
  expect(
    [...mocks.sign.mock.calls[0][0].keys()].sort((a, b) => a.localeCompare(b)),
  ).toEqual([...f.built.requiredSigners].sort((a, b) => a.localeCompare(b)));
  expect(calls[2].consent).toMatchObject({
    contextSha256: f.launch.review.contextSha256,
    approvedScope: 'create-developer-and-holder-buys',
    acknowledgeSimulationLimits: true,
  });
  expect(mocks.clear).toHaveBeenCalledTimes(2);
  expect(button('Broadcast approved holder launch').disabled).toBe(true);
  check('I separately approve broadcasting');
  await click('Broadcast approved holder launch');
  expect(calls.at(-1)).toMatchObject({
    action: 'submit',
    submitApproved: true,
  });
  expect(JSON.stringify(calls)).not.toContain('synthetic mint pass');
  expect(JSON.stringify(calls)).not.toContain('synthetic wallet pass');
});
it('invalidates signing when a wallet cap changes and never unlocks without both consents', async () => {
  await prepare();
  consent();
  input('Holder 1 maximum quote spend', '0.2');
  expect(button('Approve and sign complete holder launch').disabled).toBe(true);
  await click('Approve and sign complete holder launch');
  expect(mocks.sign).not.toHaveBeenCalled();
  await click('Use saved review limits');
  check('I approve signing');
  expect(button('Approve and sign complete holder launch').disabled).toBe(true);
  expect(mocks.wallet).not.toHaveBeenCalled();
});
it('keeps expired recovery available and does not reinterpret absence as successful creation', async () => {
  saved = {
    ...saved,
    state: 'cancelled',
    receipt: {
      kind: 'expired-unobserved',
      packetSha256: saved.review.sha256,
      contextSha256: saved.review.contextSha256,
      network: 'mainnet',
      commitment: 'finalized',
      networkFeeUnresolved: true,
      mintAbsent: true,
      finalizedBlockHeight: '1033',
      mintObservedSlot: '2001',
    },
  };
  await click('Reload saved holder launch');
  expect(container.textContent).toContain('network fees remain unresolved');
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('retains one signed copy after registration failure and retries registration without resigning', async () => {
  await prepare();
  consent();
  let failed = true;
  beforeResponse = async (action) => {
    if (action === 'register' && failed) {
      failed = false;
      throw new Error('lost response');
    }
  };
  await click('Approve and sign complete holder launch');
  expect(button('Save existing signed holder packet')).toBeTruthy();
  expect(mocks.sign).toHaveBeenCalledTimes(1);
  await click('Save existing signed holder packet');
  expect(mocks.sign).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Status: signed');
});
it('stops before unlocking if the stored vault changes during approval', async () => {
  await prepare();
  consent();
  beforeResponse = async (action) => {
    if (action === 'approve')
      localStorage.setItem('test-vault', 'changed envelope');
  };
  await click('Approve and sign complete holder launch');
  expect(mocks.wallet).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(container.textContent).toContain('stored vault changed');
});
it('remounts on draft change and aborts an approval before unlocking', async () => {
  await prepare();
  consent();
  let release!: () => void;
  beforeResponse = async (action) => {
    if (action === 'approve')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  await act(async () =>
    button('Approve and sign complete holder launch').click(),
  );
  for (let i = 0; i < 200 && !release; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  expect(release).toBeTruthy();
  await act(async () =>
    root.render(
      <PumpHolderLaunchReview
        project={{ ...f.project, updatedAt: '2026-10-15T00:00:00Z' }}
        releaseId={f.releaseId}
      />,
    ),
  );
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(mocks.wallet).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('renders HTML provider errors as a plain service message and does not sign', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  await click('Reload saved holder launch');
  expect(container.textContent).toContain('Launch service is unavailable');
  expect(container.textContent).not.toContain('Unexpected token');
  expect(mocks.sign).not.toHaveBeenCalled();
});

for (const token22 of [false, true])
  it(`uses observed stock precision for all wallet caps (Token-2022=${token22})`, async () => {
    f = await pumpHolderClientFixture(window.location.origin, true, token22);
    saved = JSON.parse(JSON.stringify(f.launch));
    localStorage.setItem(
      'mint:' + f.project.id,
      JSON.stringify({
        projectId: f.project.id,
        mint: f.launch.review.input.create.mint,
        encrypted: 'synthetic envelope',
      }),
    );
    await act(async () =>
      root.render(
        <PumpHolderLaunchReview project={f.project} releaseId={f.releaseId} />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await prepare();
    expect(calls.at(-1)).toMatchObject({
      developerMaximumQuoteCostRaw: '100000000',
    });
    expect(container.textContent).toContain('TSLAX');
    consent();
    await click('Approve and sign complete holder launch');
    expect(mocks.sign).toHaveBeenCalledTimes(1);
  });

it('uses saved quote budgets with explicit minimum outputs instead of percentage caps', async () => {
  f = await pumpHolderClientFixture(window.location.origin, false, false, true);
  saved = JSON.parse(JSON.stringify(f.launch));
  localStorage.setItem(
    'mint:' + f.project.id,
    JSON.stringify({
      projectId: f.project.id,
      mint: f.launch.review.input.create.mint,
      encrypted: 'synthetic envelope',
    }),
  );
  await act(async () =>
    root.render(
      <PumpHolderLaunchReview project={f.project} releaseId={f.releaseId} />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await prepare();
  expect(calls.at(-1)).toMatchObject({
    holderLimits: [
      {
        address: f.launch.review.input.holders[0].address,
        feeAndRentLimitRaw: '10000000',
        minimumTokenOutputRaw: '1',
      },
      {
        address: f.launch.review.input.holders[1].address,
        feeAndRentLimitRaw: '10000000',
        minimumTokenOutputRaw: '1',
      },
      {
        address: f.launch.review.input.holders[2].address,
        feeAndRentLimitRaw: '0',
      },
    ],
  });
  expect(container.textContent).toContain('Saved quote budget');
  consent();
  await click('Approve and sign complete holder launch');
  expect(mocks.sign).toHaveBeenCalledTimes(1);
});

it('explains every missing target requirement and keeps the read button closed', async () => {
  await act(async () =>
    root.render(
      <PumpHolderLaunchReview
        project={{
          ...f.project,
          payer: undefined,
          document: {
            ...f.project.document!,
            plan: { ...f.project.document!.plan, scheduled: true },
          },
        }}
        releaseId=""
      />,
    ),
  );
  expect(button('Read current holder targets').disabled).toBe(true);
  expect(container.textContent).toContain('Save a verified deployer wallet.');
  expect(container.textContent).toContain(
    'Publish and select the approved metadata release.',
  );
  expect(container.textContent).toContain('Use an unscheduled launch plan.');
  expect(
    button('Read current holder targets').getAttribute('aria-describedby'),
  ).toBeTruthy();
});
it('accepts backup file before passphrase but only decrypts on explicit Restore', async () => {
  localStorage.clear();
  await act(async () =>
    root.render(
      <PumpHolderLaunchReview
        project={{ ...f.project, id: 'restore-project' }}
        releaseId={f.releaseId}
      />,
    ),
  );
  const file = {
    size: 20,
    text: async () =>
      JSON.stringify({ projectId: 'restore-project', mint: 'synthetic' }),
  };
  const field = container.querySelector('input[type=file]')!;
  Object.defineProperty(field, 'files', { value: [file] });
  await act(async () => {
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(mocks.mint).not.toHaveBeenCalled();
  expect(button('Restore selected mint backup').disabled).toBe(true);
  input('Mint backup passphrase', 'local test passphrase');
  expect(mocks.mint).not.toHaveBeenCalled();
  await click('Restore selected mint backup');
  expect(mocks.mint).toHaveBeenCalledWith(
    { projectId: 'restore-project', mint: 'synthetic' },
    'local test passphrase',
  );
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
  expect(
    container.querySelector('[aria-current="step"]')?.textContent,
  ).toContain('Mint key');
});
it('shows saved review steps while leaving signing and broadcast consent unchecked', async () => {
  await act(async () =>
    root.render(
      <PumpHolderLaunchReview
        project={f.project}
        releaseId={f.releaseId}
        savedReview={saved}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await settle();
  expect(container.textContent).toContain('Status: review');
  expect(
    container.querySelector('[aria-current="step"]')?.textContent,
  ).toContain('Mint key');
  expect(label('I approve signing').checked).toBe(false);
  expect(label('I understand simulation').checked).toBe(false);
  expect(button('Approve and sign complete holder launch').disabled).toBe(true);
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it('passes every current raw wallet limit to the complete-group endpoint and blocks competing preparation during its request', async () => {
  input('Deployer maximum', '0.01');
  input(
    'Maximum developer buy spend',
    holderDisplayRaw('100000000', f.built.quote.decimals),
  );
  await click('Read current holder targets');
  input(
    'Holder 1 maximum quote spend',
    holderDisplayRaw('100000000', f.built.quote.decimals),
  );
  input(
    'Holder 2 maximum quote spend',
    holderDisplayRaw('100000000', f.built.quote.decimals),
  );
  check('I saved');
  const fetcher = vi.mocked(fetch),
    original = fetcher.getMockImplementation()!;
  let finish!: () => void;
  fetcher.mockImplementation(async (path, init) => {
    if (typeof path === 'string' && path.includes('/groups')) {
      if (!init?.body) return Response.json({ launches: [], nextCursor: null });
      calls.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Response('fixture unavailable', { status: 503 });
    }
    return original(path, init);
  });
  await click('Open complete launch groups');
  for (let i = 0; i < 300 && !button('Simulate complete launch group'); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  await settle();
  await act(async () => button('Simulate complete launch group').click());
  expect(button('Simulate complete holder launch').disabled).toBe(true);
  expect(button('Read current holder targets').disabled).toBe(true);
  const submitted = calls.at(-1)!;
  expect(submitted).toMatchObject({
    action: 'prepare',
    projectId: f.project.id,
    mint: f.launch.review.input.create.mint,
    feeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
  });
  expect(submitted.holderLimits).toEqual(
    f.launch.review.allowances.holders.map((limit) => ({
      address: limit.address,
      feeAndRentLimitRaw: limit.feeAndRentLimitRaw,
      ...(limit.maximumQuoteCostRaw === null
        ? {}
        : { maximumQuoteCostRaw: limit.maximumQuoteCostRaw }),
    })),
  );
  await act(async () => finish());
  await settle();
  expect(button('Simulate complete holder launch').disabled).toBe(false);
  expect(container.textContent).toContain(
    'Complete launch group service is unavailable',
  );
  expect(mocks.sign).not.toHaveBeenCalled();
});
