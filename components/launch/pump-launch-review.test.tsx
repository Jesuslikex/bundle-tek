// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PumpLaunchReview } from './pump-launch-review';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  atomicSign: vi.fn(),
  unlock: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('@/lib/pump-mint-vault', () => ({
  parsePumpMintBackup: JSON.parse,
  pumpMintStorageKey: (id: string) => 'mint:' + id,
  unlockPumpMint: mocks.unlock,
  clearMintSession: mocks.clear,
  createPumpMint: vi.fn(),
  persistPumpMint: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'test-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/pump-launch-signing', () => ({
  requirePumpSigningReview: async (_r: unknown, current: () => void) =>
    current(),
  signPumpLaunch: mocks.sign,
  decodePumpSigningInput: (input: unknown) => input,
}));
vi.mock('@/lib/pump-initial-buy-signing', () => ({
  requirePumpInitialBuySigningReview: async (
    _r: unknown,
    current: () => void,
  ) => current(),
  signPumpInitialBuy: mocks.atomicSign,
}));
const project = {
  id: 'project',
  updatedAt: '2026-10-14T00:00:00Z',
  payer: { address: 'payer', revision: 1 },
};
const plan = {
  ...DEFAULT_LAUNCH_PLAN,
  tokenName: 'Example',
  ticker: 'EX',
  developerBuy: 0,
  holdersBuy: 0,
  holdersBuyQuote: '0',
  scheduled: false,
};
const backup = {
  projectId: 'project',
  mint: 'mint',
  encrypted: 'encrypted',
  format: 'bundle-pump-mint-v1',
};
let container: HTMLDivElement,
  root: Root,
  fetcher: ReturnType<typeof vi.fn>,
  requests: string[],
  saved: ReturnType<typeof initialReview>;
function initialReview() {
  return {
    review: {
      id: 'review',
      projectId: 'project',
      projectUpdatedAt: project.updatedAt,
      releaseId: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      sha256: 'b'.repeat(64),
      transaction: 'unsigned',
      feeAndRentLimitRaw: '50000000',
      input: {
        name: 'Example',
        symbol: 'EX',
        payer: 'payer',
        mint: 'mint',
        quoteMint: 'So11111111111111111111111111111111111111112',
        uri: window.location.origin + '/api/launch/metadata/' + 'a'.repeat(64),
      },
    },
    state: 'review',
    signature: null as string | null,
    receipt: null,
    simulation: { payerDebitRaw: '3010000', networkFeeRaw: '10000' },
  };
}

const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
const label = (text: string) =>
  [...container.querySelectorAll('label')]
    .find((b) => b.textContent?.trim().startsWith(text))!
    .querySelector('input')!;
async function click(text: string) {
  await act(async () => button(text).click());
}
function input(text: string, value: string) {
  act(() => {
    const field = label(text);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function check(text: string) {
  act(() => label(text).click());
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('mint:project', JSON.stringify(backup));
  localStorage.setItem(VAULT_STORAGE_KEY, 'encrypted payer');
  requests = [];
  saved = initialReview();
  fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ launches: [saved] });
    const b = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    requests.push(b.action);
    if (b.action === 'approve') saved = { ...saved, state: 'approved' };
    if (b.action === 'register')
      saved = { ...saved, state: 'signed', signature: '2'.repeat(88) };
    if (b.action === 'submit') saved = { ...saved, state: 'submitted' };
    return Response.json(saved);
  });
  vi.stubGlobal('fetch', fetcher);
  mocks.unlock.mockReset().mockResolvedValue({ payload: { wallets: [] } });
  mocks.sign.mockReset().mockResolvedValue({
    transaction: 'synthetic signed packet',
    signature: '2'.repeat(88),
  });
  mocks.atomicSign.mockReset().mockResolvedValue({
    transaction: 'synthetic atomic packet',
    signature: '2'.repeat(88),
  });
  mocks.clear.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PumpLaunchReview
        project={project}
        plan={plan}
        releaseId={'a'.repeat(64)}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('never prepares or signs automatically, and separates signing from broadcast consent', async () => {
  expect(fetcher.mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
  expect(button('Simulate and prepare launch').disabled).toBe(true);
  check('I saved');
  await click('Simulate and prepare launch');
  expect(requests).toEqual(['prepare']);
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  expect(button('Approve and sign creation').disabled).toBe(true);
  check('I approve signing');
  await click('Approve and sign creation');
  expect(requests).toEqual(['prepare', 'approve', 'register']);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(mocks.clear).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem('bundle.pump-signed.v1:review')).toBe(
    'synthetic signed packet',
  );
  expect(button('Broadcast approved launch').disabled).toBe(true);
  check('I approve broadcasting');
  await click('Broadcast approved launch');
  expect(requests.at(-1)).toBe('submit');
});
it('disables a stale or mismatched review while retaining recovery', async () => {
  saved.review.projectUpdatedAt = 'older';
  await click('Reload saved launch');
  expect(button('Approve and sign creation').disabled).toBe(true);
  expect(container.textContent).toContain('differs from the current draft');
});
it('does not generate new signatures when an existing packet is awaiting registration', async () => {
  saved.state = 'approved';
  localStorage.setItem('bundle.pump-signed.v1:review', 'already signed');
  await click('Reload saved launch');
  check('I saved');
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  check('I approve signing');
  expect(button('Approve and sign creation').disabled).toBe(true);
  await click('Save existing signed packet');
  expect(requests).toEqual(['register']);
  expect(mocks.sign).not.toHaveBeenCalled();
});
it('shows a safe error for an HTML gateway failure', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>private proxy details</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  await click('Reload saved launch');
  expect(container.textContent).toContain('Launch history is unavailable');
  expect(container.textContent).not.toContain('private proxy');
});

async function atomicSetup() {
  const initial = initialReview();
  let atomicSaved = {
    ...initial,
    format: 'pump-create-buy-review-v1',
    containsHolderBuys: false,
    completeLaunch: false,
    review: {
      ...initial.review,
      developerSupplyPercent: 0.1,
      input: {
        create: initial.review.input,
        transactionVersion: 1,
        tokenAmountRaw: '1000000000000',
        maximumQuoteCostRaw: '100000000',
      },
    },
    simulation: {
      ...initial.simulation,
      quoteCostRaw: '28334890',
      feeAndRentDebitRaw: '5010000',
    },
  };
  const payloads: Record<string, unknown>[] = [];
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ launches: [], nextCursor: null });
    expect(path).toContain('/api/launch/pump/initial-buy');
    if (init?.body) {
      const b = JSON.parse(
        typeof init.body === 'string' ? init.body : '{}',
      ) as Record<string, unknown>;
      payloads.push(b);
      requests.push(String(b.action));
      if (b.action === 'approve')
        atomicSaved = { ...atomicSaved, state: 'approved' };
      if (b.action === 'register')
        atomicSaved = {
          ...atomicSaved,
          state: 'signed',
          signature: '2'.repeat(88),
        };
      if (b.action === 'submit')
        atomicSaved = { ...atomicSaved, state: 'submitted' };
    }
    return Response.json(atomicSaved);
  });
  await act(async () =>
    root.render(
      <PumpLaunchReview
        project={project}
        plan={{ ...plan, developerBuy: 0.1, holdersBuy: 0 }}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  return { payloads, getSaved: () => atomicSaved };
}
it('requires the separate quote cap, exact atomic scope and limits consent before dual signing, then distinct broadcast consent', async () => {
  const { payloads } = await atomicSetup();
  expect(fetcher.mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
  expect(container.textContent).toContain('No holder buys are included');
  check('I saved');
  await click('Simulate and prepare launch');
  expect(fetcher.mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
  expect(container.textContent).toContain('positive maximum quote spend');
  input('Maximum developer buy spend', '0.1');
  await click('Simulate and prepare launch');
  expect(payloads[0]).toMatchObject({
    action: 'prepare',
    maximumQuoteCostRaw: '100000000',
    feeAndRentLimitRaw: '50000000',
  });
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  check('I approve signing');
  expect(button('Approve and sign creation with developer buy').disabled).toBe(
    true,
  );
  check('I understand');
  await click('Approve and sign creation with developer buy');
  expect(payloads[1]).toMatchObject({
    action: 'approve',
    approvedScope: 'create-and-developer-buy',
    acknowledgeSimulationLimits: true,
    approved: true,
  });
  expect(mocks.atomicSign).toHaveBeenCalledOnce();
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.clear).toHaveBeenCalledTimes(2);
  expect(requests).toEqual(['prepare', 'approve', 'register']);
  expect(button('Broadcast approved launch').disabled).toBe(true);
  check('I approve broadcasting');
  await click('Broadcast approved launch');
  expect(payloads.at(-1)).toMatchObject({
    action: 'submit',
    approved: true,
    approvedScope: 'create-and-developer-buy',
    acknowledgeSimulationLimits: true,
  });
});
it('invalidates atomic consent when quote caps change and blocks schedules', async () => {
  await atomicSetup();
  check('I saved');
  input('Maximum developer buy spend', '0.1');
  await click('Simulate and prepare launch');
  check('I approve signing');
  check('I understand');
  input('Maximum developer buy spend', '0.2');
  expect(label('I approve signing').checked).toBe(false);
  expect(label('I understand').checked).toBe(false);
  expect(button('Approve and sign creation with developer buy').disabled).toBe(
    true,
  );
  expect(container.textContent).toContain('differs from the current draft');
  await act(async () =>
    root.render(
      <PumpLaunchReview
        project={project}
        plan={{ ...plan, developerBuy: 0.1, scheduled: true }}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  expect(button('Simulate and prepare launch').disabled).toBe(true);
});
it('rejects excess quote precision and prevents a stale async sign after project context changes', async () => {
  await atomicSetup();
  check('I saved');
  input('Maximum developer buy spend', '0.0000000001');
  await click('Simulate and prepare launch');
  expect(fetcher.mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
  expect(container.textContent).toContain('asset precision');
  input('Maximum developer buy spend', '0.1');
  await click('Simulate and prepare launch');
  input('Mint backup passphrase', 'mint password');
  input('Deployer vault passphrase', 'payer password');
  check('I approve signing');
  check('I understand');
  let resolve!: () => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = () =>
          r(
            Response.json({
              ...initialReview(),
              format: 'pump-create-buy-review-v1',
              containsHolderBuys: false,
              completeLaunch: false,
              review: {
                ...initialReview().review,
                developerSupplyPercent: 0.1,
                input: {
                  create: initialReview().review.input,
                  transactionVersion: 1,
                  tokenAmountRaw: '1000000000000',
                  maximumQuoteCostRaw: '100000000',
                },
              },
              state: 'approved',
            }),
          );
      }),
  );
  act(() => button('Approve and sign creation with developer buy').click());
  await act(async () =>
    root.render(
      <PumpLaunchReview
        project={{ ...project, updatedAt: 'changed' }}
        plan={{ ...plan, developerBuy: 0.1 }}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  await act(async () => resolve());
  expect(mocks.atomicSign).not.toHaveBeenCalled();
  expect(mocks.unlock).not.toHaveBeenCalled();
});

it('invalidates a prepared review when the fee/rent allowance changes', async () => {
  check('I saved');
  await click('Simulate and prepare launch');
  input('Maximum network fee and rent', '0.01');
  expect(button('Approve and sign creation').disabled).toBe(true);
  expect(label('I approve signing').disabled).toBe(true);
  expect(container.textContent).toContain('differs from the current draft');
});

it('routes a holder plan to the complete holder flow instead of omitting its buys', async () => {
  await act(async () =>
    root.render(
      <PumpLaunchReview
        project={project}
        plan={{ ...plan, developerBuy: 0.1, holdersBuy: 20 }}
        releaseId={'a'.repeat(64)}
      />,
    ),
  );
  expect(container.textContent).toContain('Create coin with holder buys');
  expect(
    container.querySelector('[aria-label="Saved launch recovery"]'),
  ).not.toBeNull();
  expect(
    button('Approve and sign creation with developer buy'),
  ).toBeUndefined();
  expect(container.textContent).toContain(
    'Save the complete unscheduled holder selection',
  );
  expect(fetcher.mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
});

it('renders an expired unobserved recovery without calling it a finalized failure', async () => {
  fetcher.mockImplementation(async () =>
    Response.json({
      launches: [
        {
          ...saved,
          state: 'cancelled',
          receipt: {
            kind: 'expired-unobserved',
            mintAbsent: true,
            networkFeeUnresolved: true,
            finalizedBlockHeight: '1033',
          },
        },
      ],
    }),
  );
  await click('Reload saved launch');
  expect(container.textContent).toContain('network fees remain unresolved');
  expect(
    container.querySelector('[aria-label="Saved launch recovery"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain('Finalized transaction failure');
});

it('opens an unsigned history review in the real review screen without approving or signing it', async () => {
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.body) throw new Error('Opening a review must not mutate it.');
    return Response.json({
      launches:
        path.includes('initial-buy') || path.includes('holders') ? [] : [saved],
      nextCursor: null,
    });
  });
  await click('Reload all saved launches');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Open create only review: review"]',
      )!
      .click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  expect(container.textContent).toContain('Status: review');
  expect(container.textContent).toContain('Return to current launch');
  expect(label('I approve signing').checked).toBe(false);
  expect(button('Approve and sign creation').disabled).toBe(true);
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});
