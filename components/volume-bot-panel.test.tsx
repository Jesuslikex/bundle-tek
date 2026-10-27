import {
  captureVolumeUsdTarget,
  VOLUME_NATIVE_MINT,
} from '@/lib/volume-usd-target';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { VolumeBotPanel, type VolumeSession } from './volume-bot-panel';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  VAULT_STORAGE_KEY,
  createVault,
  encryptVault,
  generateVaultWallets,
} from '@/lib/browser-wallet-vault';
import { solanaTransferMessage } from '@/lib/solana-funding';
import { createVolumeBatchReview } from '@/lib/volume-bot-batch';
import { planVolumeSession } from '@/lib/volume-bot-plan';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROJECT = '00000000-0000-4000-8000-000000000001';
const project = {
  id: PROJECT,
  revision: 2,
  archived: false,
  updatedAt: '2026-10-17T00:00:00.000Z',
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: MINT,
      decimals: 6,
      symbol: 'TEST',
      name: 'Test',
      totalSupplyRaw: '1000000',
      source: 'fixture.test',
      observedAt: '2026-10-13T12:00:00.000Z',
    },
  },
} as unknown as ImportedTokenProject;
let address: string, encrypted: string;
let container: HTMLDivElement, root: Root;
let calls: { url: string; payload: Record<string, unknown> | null }[];
let respond: (payload: Record<string, unknown> | null) => unknown;
beforeAll(async () => {
  const vault = generateVaultWallets(
    await createVault('panel synthetic vault'),
    'solana',
    1,
  );
  address = vault.payload.wallets[0].address;
  encrypted = await encryptVault(vault);
}, 30_000);
const wallet = () =>
  ({
    chain: 'Solana',
    address,
    folderId: '',
    label: 'Volume one',
    role: 'Trader',
    archived: false,
    revision: 1,
    updatedAt: '2026-10-17T00:00:00.000Z',
  }) as unknown as WorkspaceWallet;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  cachedQuote = null;
  localStorage.setItem(VAULT_STORAGE_KEY, encrypted);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      calls.push({ url: String(url), payload });
      const answer = respond(payload) as Record<string, unknown> | null;
      if (payload?.action === 'quote-usd-target' && !answer?.quote)
        return Response.json({ quote: usdQuote(), executionAllowed: false });
      return Response.json(answer);
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const settleAuto = () =>
  act(async () => new Promise((r) => setTimeout(r, 400)));

it('estimates with the chosen settings and saves the session', async () => {
  const seedPlan = (payload: Record<string, unknown>) =>
    planVolumeSession(
      payload.terms as never,
      [{ address, lamports: '10000000000' }],
      payload.seed as string,
      payload.usdQuoteId ? usdQuote() : undefined,
    );
  respond = (payload) =>
    payload?.action === 'estimate'
      ? { plan: seedPlan(payload) }
      : payload?.action === 'create'
        ? { id: 's' }
        : { sessions: [] };
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  const mode = container.querySelector('[aria-label="Volume execution mode"]')!;
  expect(mode.textContent).toContain('Mode: Scheduled swaps');
  expect(mode.textContent).toContain('sent individually');
  expect(mode.textContent).toContain('no same-block guarantee');
  expect(mode.querySelector('details')!.open).toBe(false);
  expect(mode.textContent).toContain('local tip-budget preview');
  expect(calls.every((c) => c.payload === null)).toBe(true);
  await act(async () => (await walletCheckbox()).click());
  await settleAuto();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Round Trips'),
  );
  const estimate = calls.find((c) => c.payload?.action === 'estimate')!;
  expect(estimate.payload).toMatchObject({
    projectId: PROJECT,
    projectRevision: 2,
    terms: {
      targetVolumeLamports: '500000000',
      endCondition: 'time',
      durationSeconds: 1800,
      wave: 'tight',
      wallets: [address],
    },
  });
  expect(container.textContent).toContain('0.5 SOL');
  expect(
    container.querySelector('[aria-label="Volume Bot estimate"]')?.textContent,
  ).toContain('EstimationRound Trips');
  expect(container.textContent).toContain('Delivery: configured Solana RPC');
  expect(container.textContent).toContain(
    'does not request dedicated sandwich protection',
  );
  await act(async () =>
    ([...container.querySelectorAll('input[type=checkbox]')].at(-1) as HTMLInputElement).click(),
  );
  await act(async () => button('Run').click());
  await vi.waitFor(() =>
    expect(calls.some((c) => c.payload?.action === 'create')).toBe(true),
  );
  const create = calls.find((c) => c.payload?.action === 'create')!;
  expect(create.payload!.seed).toBe(estimate.payload!.seed);
});

it('signs an approved batch locally, registers it and sends each trade once', async () => {
  const bytes = Uint8Array.from([
    1,
    ...new Uint8Array(64),
    128,
    ...solanaTransferMessage(
      address,
      MINT,
      '11111111111111111111111111111111',
      1n,
    ),
    0,
  ]);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const review = await createVolumeBatchReview({
    id: '00000000-0000-4000-8000-000000000009',
    sessionId: '00000000-0000-4000-8000-000000000008',
    batch: 0,
    mint: MINT,
    decimals: 6,
    trades: [
      {
        index: 0,
        round: 0,
        side: 'Buy',
        wallet: address,
        batchOffsetMs: 0,
        inAmountRaw: '100000000',
        minimumOutRaw: '995',
        estimatedFeesLamports: '5000',
        transaction: btoa(String.fromCharCode(...bytes)),
        packetSha256: digest,
        lastValidBlockHeight: '1000',
      },
    ],
    skipped: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const session = {
    id: review.sessionId,
    projectId: PROJECT,
    state: 'active',
    createdAt: '2026-10-17T00:00:00.000Z',
    plan: { batches: 2, wallets: [address] },
    realized: { finalizedTrades: 0, volumeLamports: '0', netSolLamports: '0' },
    batches: [
      {
        id: review.id,
        batch: 0,
        state: 'review',
        expiresAt: review.expiresAt,
        review,
        trades: [],
      },
    ],
  } as unknown as VolumeSession;
  respond = () => ({ sessions: [session] });
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  expect(container.textContent).toContain('Batch 1');
  const pass = container.querySelector(
    'input[type=password]',
  ) as HTMLInputElement;
  await changeControl(pass, 'panel synthetic vault');
  await act(async () => button('Unlock wallets').click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Wallets unlocked'),
  );
  // Signing needs the explicit per-batch approval first.
  expect(button('Sign and send batch').disabled).toBe(true);
  const approval = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  await act(async () => approval.click());
  await act(async () => button('Sign and send batch').click());
  await vi.waitFor(() =>
    expect(calls.some((c) => c.payload?.action === 'send')).toBe(true),
  );
  const register = calls.find((c) => c.payload?.action === 'register')!;
  expect(register.payload).toMatchObject({
    batchId: review.id,
    consent: {
      reviewId: review.id,
      sha256: review.sha256,
      scope: 'volume-bot-batch',
    },
  });
  expect((register.payload!.transactions as string[])[0]).not.toBe(
    review.trades[0].transaction,
  );
  expect(
    calls.filter((c) => c.payload?.action === 'send').map((c) => c.payload),
  ).toEqual([{ action: 'send', batchId: review.id, index: 0 }]);
}, 30_000);

let cachedQuote: ReturnType<typeof captureVolumeUsdTarget> | null = null;
function usdQuote() {
  if (cachedQuote) return cachedQuote;
  const at = new Date().toISOString();
  return (cachedQuote = captureVolumeUsdTarget(
    {
      id: '00000000-0000-4000-8000-000000000010',
      projectId: PROJECT,
      projectRevision: 2,
      targetUsd: '100',
    },
    {
      chain: 'Solana',
      address: VOLUME_NATIVE_MINT,
      observedAt: at,
      source: 'api.dexscreener.com',
      returnedPairCount: 1,
      quoteOnlyPairCount: 0,
      executionAllowed: false,
      pairs: [
        {
          address: VOLUME_NATIVE_MINT,
          dex: 'synthetic',
          url: 'https://dexscreener.com',
          quoteSymbol: 'USDC',
          priceUsd: '200',
          liquidityUsd: 100000,
          volume24hUsd: null,
          change24h: null,
          marketCapUsd: null,
        },
      ],
    },
    Date.now(),
  ));
}
async function changeControl(
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
/** The wallet selector checkbox, not the first checkbox in the form. */
async function walletCheckbox() {
  const field = [...container.querySelectorAll('fieldset')].find(
    (f) => f.querySelector('legend')?.textContent === 'Wallets (optional)',
  )!;
  if (!field.querySelector('input[type=checkbox]'))
    await act(async () => (field.querySelector('button') as HTMLButtonElement).click());
  return field.querySelector('input[type=checkbox]') as HTMLInputElement;
}
async function openUsd() {
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () =>
    container
      .querySelector('[aria-label="Target currency"] button:last-of-type')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () => (await walletCheckbox()).click());
}
it('opens the wallet picker as a dialog that Done and Escape close', async () => {
  respond = () => ({ sessions: [] });
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  const pickerButton = () =>
    [...container.querySelectorAll('fieldset')]
      .find((f) => f.querySelector('legend')?.textContent === 'Wallets (optional)')!
      .querySelector('button') as HTMLButtonElement;
  await act(async () => pickerButton().click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.textContent).toContain('Select wallets');
  await act(async () => button('Done').click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => pickerButton().click());
  await act(async () =>
    container
      .querySelector('[role="dialog"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('warns under the form when no selected wallet can fund the schedule', async () => {
  const quote = usdQuote();
  respond = (payload) =>
    payload?.action === 'quote-usd-target'
      ? { quote, executionAllowed: false }
      : payload?.action === 'estimate'
        ? {
            plan: planVolumeSession(
              payload.terms as never,
              [{ address, lamports: '1' }],
              payload.seed as string,
              quote,
            ),
          }
        : { sessions: [] };
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () => (await walletCheckbox()).click());
  await vi.waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.payload?.action === 'estimate' &&
          (c.payload.terms as { wallets?: string[] }).wallets?.length,
      ),
    ).toBe(true),
  );
  await settleAuto();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'No wallets have sufficient balance. Minimum required per wallet:',
    ),
  );
  expect(container.textContent).toMatch(/per wallet: [\d.]+ SOL\./);
});

it('labels the fee target as an optional tip budget', async () => {
  respond = () => ({ sessions: [] });
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  expect(container.textContent).toContain('Total tip budget for the session.');
  const fee = container.querySelector(
    '[aria-label="Fee target in SOL"]',
  ) as HTMLInputElement;
  expect(fee.getAttribute('placeholder')).toBe('0.05');
});

it('captures USD explicitly and requires an unchecked fixed-SOL acknowledgement before saving', async () => {
  const quote = usdQuote();
  respond = (payload) =>
    payload?.action === 'quote-usd-target'
      ? { quote, executionAllowed: false }
      : payload?.action === 'estimate'
        ? {
            plan: planVolumeSession(
              payload.terms as never,
              [{ address, lamports: '10000000000' }],
              payload.seed as string,
              quote,
            ),
          }
        : payload?.action === 'create'
          ? { id: 's' }
          : { sessions: [] };
  await openUsd();
  await settleAuto();
  await settle();
  expect(container.textContent).toContain('$100 converts to 0.5 SOL');
  const save = button('Run');
  expect(save.disabled).toBe(true);
  const ack = [...container.querySelectorAll('input[type=checkbox]')].at(
    -1,
  ) as HTMLInputElement;
  expect(ack.checked).toBe(false);
  await act(async () => ack.click());
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  await settle();
  expect(
    calls.find((c) => c.payload?.action === 'create')?.payload?.usdQuoteId,
  ).toBe(quote.id);
  expect(
    calls.some((c) =>
      ['register', 'send', 'prepare-batch'].includes(String(c.payload?.action)),
    ),
  ).toBe(false);
});
it('clears the shown conversion when the target changes and recaptures an expired one', async () => {
  const quote = usdQuote();
  respond = (p) =>
    p?.action === 'quote-usd-target'
      ? { quote, executionAllowed: false }
      : p?.action === 'estimate'
        ? {
            plan: planVolumeSession(
              p.terms as never,
              [{ address, lamports: '10000000000' }],
              p.seed as string,
              usdQuote(),
            ),
          }
        : { sessions: [] };
  await openUsd();
  await settleAuto();
  await settle();
  expect(container.textContent).toContain('$100 converts to 0.5 SOL');
  const input = container.querySelector(
    'input[inputmode=decimal]',
  ) as HTMLInputElement;
  await changeControl(input, '120');
  expect(container.textContent).not.toContain('$100 converts');
  const before = calls.filter(
    (c) => c.payload?.action === 'quote-usd-target',
  ).length;
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(quote.expiresAt));
  try {
    await settleAuto();
    await settle();
  } finally {
    clock.mockRestore();
  }
  expect(
    calls.filter((c) => c.payload?.action === 'quote-usd-target').length,
  ).toBeGreaterThan(before);
});
it('ignores a pending USD capture after the target draft changes', async () => {
  const quote = usdQuote();
  let resolve!: (v: unknown) => void;
  respond = (p) =>
    p?.action === 'quote-usd-target'
      ? new Promise((r) => {
          resolve = r;
        })
      : { sessions: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body ? JSON.parse(options.body as string) : null;
      calls.push({ url, payload });
      return Response.json(await respond(payload));
    }),
  );
  await openUsd();
  await act(async () => button('Capture USD conversion').click());
  await changeControl(
    container.querySelector<HTMLInputElement>('input[inputmode=decimal]')!,
    '120',
  );
  await act(async () => resolve({ quote, executionAllowed: false }));
  await settle();
  expect(container.textContent).not.toContain('$100 converts');
});

it('discards an in-flight estimate when settings change', async () => {
  let resolve!: (v: unknown) => void;
  let pending: Record<string, unknown> | null = null;
  respond = (p) => {
    if (p?.action === 'estimate') {
      pending = p;
      return new Promise((r) => {
        resolve = r;
      });
    }
    if (p?.action === 'quote-usd-target')
      return { quote: usdQuote(), executionAllowed: false };
    return { sessions: [] };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body ? JSON.parse(options.body as string) : null;
      calls.push({ url, payload });
      return Response.json(await respond(payload));
    }),
  );
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () => (await walletCheckbox()).click());
  await settleAuto();
  await changeControl(
    container.querySelector<HTMLInputElement>('input[inputmode=decimal]')!,
    '2',
  );
  const request = pending! as Record<string, unknown>;
  await act(async () =>
    resolve({
      plan: planVolumeSession(
        request.terms as never,
        [{ address, lamports: '10000000000' }],
        request.seed as string,
        request.usdQuoteId ? usdQuote() : undefined,
      ),
    }),
  );
  await settle();
  expect(container.textContent).not.toContain('Round Trips');
  expect(button('Run')).toBeUndefined();
});

async function openSolTiming() {
  respond = (payload) =>
    payload?.action === 'estimate'
      ? {
          plan: planVolumeSession(
            payload.terms as never,
            [{ address, lamports: '10000000000' }],
            payload.seed as string,
            usdQuote(),
          ),
        }
      : { sessions: [] };
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () => (await walletCheckbox()).click());
}
async function setSessionTime(hours: string, minutes: string, seconds: string) {
  for (const [unit, value] of [
    ['hours', hours],
    ['minutes', minutes],
    ['seconds', seconds],
  ])
    await changeControl(
      container.querySelector<HTMLInputElement>(
        `[aria-label="Session duration: ${unit}"]`,
      )!,
      value,
    );
}

it('switches to Bundle mode, hides the wave control and sends no intensity', async () => {
  await openSolTiming();
  await act(async () => button('Delay').click());
  expect(container.querySelector('[aria-label="Wave intensity"]')).not.toBeNull();
  const bundle = container.querySelector<HTMLInputElement>(
    'input[type="radio"][value="Bundle"]',
  )!;
  await act(async () => bundle.click());
  expect(bundle.checked).toBe(true);
  expect(container.querySelector('[aria-label="Wave intensity"]')).toBeNull();
  expect(container.textContent).toContain('same block');
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Fixed amount in SOL"]')!,
    '0.1',
  );
  await settleAuto();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('buys and sells land in the same block'),
  );
  const estimated = calls.find((call) => call.payload?.action === 'estimate')!
    .payload!.terms as Record<string, unknown>;
  expect(estimated).toMatchObject({ mode: 'Bundle' });
  expect(estimated.waveIntensityTenths).toBeUndefined();
});

it('sends a fee target only when one is entered', async () => {
  await openSolTiming();
  await settleAuto();
  await vi.waitFor(() =>
    expect(calls.some((call) => call.payload?.action === 'estimate')).toBe(true),
  );
  expect(
    (
      calls.find((call) => call.payload?.action === 'estimate')!.payload!
        .terms as Record<string, unknown>
    ).feeTargetLamports,
  ).toBeUndefined();
  await changeControl(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Fee target in SOL"]',
    )!,
    '0.00025',
  );
  await settleAuto();
  await vi.waitFor(() =>
    expect(
      calls.filter((call) => call.payload?.action === 'estimate').length,
    ).toBeGreaterThan(1),
  );
  expect(
    (
      calls.filter((call) => call.payload?.action === 'estimate').at(-1)!
        .payload!.terms as Record<string, unknown>
    ).feeTargetLamports,
  ).toBe('250000');
});

it('sends the amount per trade only in Delay mode, and requires it there', async () => {
  await openSolTiming();
  // Duration mode carries no amount at all, matching Proxima's payload.
  expect(button('Fixed')).toBeUndefined();
  await settleAuto();
  await vi.waitFor(() =>
    expect(calls.some((call) => call.payload?.action === 'estimate')).toBe(true),
  );
  const first = calls.find((call) => call.payload?.action === 'estimate')!
    .payload!.terms as Record<string, unknown>;
  expect(first).not.toHaveProperty('amount');
  expect(first).not.toHaveProperty('delayMinMs');

  // Delay mode reveals the control with Fixed already ticked, as Proxima does,
  // and refuses to estimate on the empty field.
  await act(async () => button('Delay').click());
  const fixed = button('Fixed');
  const random = button('Random');
  expect(fixed.getAttribute('aria-pressed')).toBe('true');
  expect(random.getAttribute('aria-pressed')).toBe('false');
  await settleAuto();
  await settle();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      'Amount per trade must be greater than 0.',
    ),
  );

  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Fixed amount in SOL"]')!,
    '0.05',
  );
  await settleAuto();
  await vi.waitFor(() =>
    expect(
      calls.filter((call) => call.payload?.action === 'estimate').length,
    ).toBeGreaterThan(1),
  );
  expect(
    (
      calls.filter((call) => call.payload?.action === 'estimate').at(-1)!.payload!
        .terms as Record<string, unknown>
    ).amount,
  ).toEqual({ kind: 'fixed', lamports: '50000000' });

  await act(async () => random.click());
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum amount in SOL"]')!,
    '0.05',
  );
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Maximum amount in SOL"]')!,
    '0.15',
  );
  await settleAuto();
  await vi.waitFor(() =>
    expect(
      calls.filter((call) => call.payload?.action === 'estimate').length,
    ).toBeGreaterThan(2),
  );
  expect(
    (
      calls.filter((call) => call.payload?.action === 'estimate').at(-1)!.payload!
        .terms as Record<string, unknown>
    ).amount,
  ).toEqual({ kind: 'range', minLamports: '50000000', maxLamports: '150000000' });
});

it('estimates on its own after the draft settles, without the button', async () => {
  await openSolTiming();
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
  await settleAuto();
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(true);
  expect(container.textContent).toContain('Round Trips');
});

it('waits out the server gate and retries once instead of failing', async () => {
  respond = (payload) =>
    payload?.action === 'estimate'
      ? { plan: planVolumeSession(payload.terms as never, [], 'a'.repeat(32)) }
      : { sessions: [] };
  const inner = globalThis.fetch;
  let gated = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body ? JSON.parse(options.body as string) : null;
      if (payload?.action === 'estimate' && gated++ === 0)
        return Response.json({ error: 'Wait a few seconds.' }, { status: 429 });
      return inner(url, options);
    }),
  );
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await act(async () => (await walletCheckbox()).click());
  await act(async () => new Promise((r) => setTimeout(r, 3_600)));
  expect(gated).toBe(2);
  expect(container.textContent).not.toContain('Wait a few seconds.');
}, 10_000);

it('disables Bundle in Duration mode and falls back to Organic', async () => {
  await openSolTiming();
  const bundle = container.querySelector<HTMLInputElement>(
    'input[type="radio"][value="Bundle"]',
  )!;
  expect(bundle.disabled).toBe(true);
  await act(async () => button('Delay').click());
  await act(async () => bundle.click());
  expect(bundle.checked).toBe(true);
  await act(async () => button('Duration').click());
  expect(bundle.disabled).toBe(true);
  expect(
    container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="Organic"]',
    )!.checked,
  ).toBe(true);
});

it('hides the wave control in Bundle mode', async () => {
  await openSolTiming();
  await act(async () => button('Delay').click());
  expect(container.querySelector('[aria-label="Wave intensity"]')).not.toBeNull();
  const bundle = container.querySelector<HTMLInputElement>(
    'input[type="radio"][value="Bundle"]',
  )!;
  await act(async () => bundle.click());
  expect(container.querySelector('[aria-label="Wave intensity"]')).toBeNull();
  // The amount control belongs to the Delay end condition, not to the mode.
  expect(button('Fixed')).toBeDefined();
});

it('reviews and saves the selected numeric wave, then invalidates review on another wave', async () => {
  await openSolTiming();
  const slider = container.querySelector<HTMLInputElement>(
    '[aria-label="Wave intensity"]',
  )!;
  expect(slider.min).toBe('0');
  expect(slider.max).toBe('1');
  expect(slider.step).toBe('0.1');
  await changeControl(slider, '0.7');
  expect(slider.getAttribute('aria-valuetext')).toBe('0.7');
  await settleAuto();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Wave intensity: 0.7'),
  );
  const estimated = calls.find(
    (call) => call.payload?.action === 'estimate',
  )!.payload!;
  expect(estimated.terms).toMatchObject({
    wave: 'big-waves',
    waveIntensityTenths: 7,
  });
  await act(async () =>
    ([...container.querySelectorAll('input[type=checkbox]')].at(-1) as HTMLInputElement).click(),
  );
  await act(async () => button('Run').click());
  await vi.waitFor(() =>
    expect(calls.some((call) => call.payload?.action === 'create')).toBe(true),
  );
  expect(
    calls.find((call) => call.payload?.action === 'create')!.payload!.terms,
  ).toEqual(estimated.terms);
  await changeControl(slider, '0.3');
  expect(button('Run')).toBeUndefined();
  expect(
    calls.some((call) =>
      ['register', 'send'].includes(String(call.payload?.action)),
    ),
  ).toBe(false);
});
it('sends an exact duration, then an exact delay pair in Delay mode', async () => {
  await openSolTiming();
  await setSessionTime('1', '2', '3');
  await settleAuto();
  await settle();
  const timed = calls.find((c) => c.payload?.action === 'estimate')?.payload
    ?.terms as Record<string, unknown>;
  expect(timed).toMatchObject({ endCondition: 'time', durationSeconds: 3723 });
  expect(timed).not.toHaveProperty('delayMinMs');
  expect(container.textContent).toContain('3,723 seconds total');
  expect(container.textContent).toContain('3,723 seconds total');

  // Delay mode swaps the duration for the pair and drops the duration field.
  await act(async () => button('Delay').click());
  expect(
    container.querySelector('[aria-label="Session duration: minutes"]'),
  ).toBeNull();
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum delay"]')!,
    '1.234',
  );
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Maximum delay"]')!,
    '2.345',
  );
  await act(async () => button('Fixed').click());
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Fixed amount in SOL"]')!,
    '0.05',
  );
  await settleAuto();
  await settle();
  const delayed = calls.filter((c) => c.payload?.action === 'estimate').at(-1)!
    .payload!.terms as Record<string, unknown>;
  expect(delayed).toMatchObject({ endCondition: 'delay', delayMinMs: 1234, delayMaxMs: 2345 });
  expect(delayed).not.toHaveProperty('durationSeconds');

  // Any edit drops the review.
  expect(container.textContent).toContain('Round Trips');
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum delay"]')!,
    '1.5',
  );
  expect(container.textContent).not.toContain('Round Trips');
  expect(
    calls.some((c) =>
      ['create', 'register', 'send'].includes(String(c.payload?.action)),
    ),
  ).toBe(false);
});
it.each([
  ['0', '0', '59'],
  ['24', '0', '1'],
  ['0', '60', '0'],
  ['0', '1.5', '0'],
  ['0', '1e2', '0'],
  ['', '', ''],
])(
  'refuses invalid/out-of-range HMS %s:%s:%s without provider work',
  async (hours, minutes, seconds) => {
    await openSolTiming();
    await setSessionTime(hours, minutes, seconds);
    await settleAuto();
    expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Session duration: minutes"]',
      )!.value,
    ).toBe(minutes);
  },
);
it.each([
  ['0', '1', '0', 60],
  ['24', '0', '0', 86400],
])(
  'keeps exact allowed duration boundary %s:%s:%s',
  async (hours, minutes, seconds, expected) => {
    await openSolTiming();
    await setSessionTime(String(hours), String(minutes), String(seconds));
      await settleAuto();
    await settle();
    expect(
      calls.find((c) => c.payload?.action === 'estimate')?.payload?.terms,
    ).toMatchObject({ durationSeconds: expected });
  },
);
it.each(['1.0004', '1e0', '0.999', '600.001'])(
  'refuses unrepresentable/out-of-range delay %s instead of rounding it',
  async (delay) => {
    await openSolTiming();
    await act(async () => button('Delay').click());
    await changeControl(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Minimum delay"]',
      )!,
      delay,
    );
    await settleAuto();
    await settle();
    expect(container.textContent).toContain(
      'from 1 to 300 seconds with at most three decimal places',
    );
    expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
  },
);
it('refuses a reversed delay range locally before observing wallet balances', async () => {
  await openSolTiming();
  await act(async () => button('Delay').click());
  await act(async () => button('Fixed').click());
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Fixed amount in SOL"]')!,
    '0.05',
  );
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum delay"]')!,
    '21',
  );
  await settleAuto();
  await settle();
  expect(container.textContent).toContain(
    'min delay and max delay that are positive with min <= max',
  );
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
});
it('keeps optional trade settings collapsed and provides an explicit error recovery path', async () => {
  await openSolTiming();
  const slider = container.querySelector<HTMLInputElement>(
    '[aria-label="Wave intensity"]',
  )!;
  const settings = slider.closest('details')!;
  expect(settings.open).toBe(false);
  expect((await walletCheckbox()).closest('details')).toBeNull();
  // The end condition and amount live in the open form, not in the settings.
  await act(async () => button('Delay').click());
  const minimum = container.querySelector<HTMLInputElement>(
    '[aria-label="Minimum delay"]',
  )!;
  expect(minimum.closest('details')).toBeNull();
  await act(async () => button('Fixed').click());
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Fixed amount in SOL"]')!,
    '0.05',
  );
  await changeControl(minimum, '0');
  await settleAuto();
  await settle();
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
  await act(async () => button('Edit trade settings').click());
  expect(settings.open).toBe(true);
  expect(document.activeElement).toBe(settings.querySelector('summary'));
  await changeControl(minimum, '5');
  await settleAuto();
  await settle();
  expect(
    container.querySelector('[aria-label="Volume Bot estimate"]'),
  ).toBeTruthy();
  expect(
    calls.some((c) =>
      ['create', 'prepare', 'sign', 'submit'].includes(
        String(c.payload?.action),
      ),
    ),
  ).toBe(false);
});

it('previews same-block tips locally, invalidates edits and returns to scheduled swaps', async () => {
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  const mode = Array.from(container.querySelectorAll('select')).find((select) =>
    select.querySelector('option[value="bundle"]'),
  )!;
  await changeControl(mode, 'bundle');
  expect(container.textContent).toContain(
    'Running this mode is not available yet',
  );
  await act(async () => button('Preview bundle budget').click());
  expect(button('Preview bundle budget').disabled).toBe(true);
  expect(container.textContent).toContain('Select at least one wallet');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => button('Preview bundle budget').click());
  expect(
    container.querySelector('[aria-label="Bundle budget preview"]')
      ?.textContent,
  ).toContain('10 bundles, 20 trades');
  expect(container.textContent).toContain('0.0001 SOL');
  expect(button('Run')).toBeUndefined();
  expect(calls.every((c) => c.payload === null)).toBe(true);
  const tips = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent === 'Total session tip limit (SOL)',
  )!;
  await changeControl(
    container.querySelector<HTMLInputElement>(`[id="${tips.htmlFor}"]`)!,
    '0.000001',
  );
  expect(
    container.querySelector('[aria-label="Bundle budget preview"]'),
  ).toBeNull();
  await act(async () => button('Preview bundle budget').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'session tip budget from',
  );
  await changeControl(mode, 'scheduled');
  await settle();
  expect(container.textContent).toContain('Mode: Scheduled swaps');
  expect(calls.every((c) => c.payload === null)).toBe(true);
});

it.each(['project', 'revision', 'archive'] as const)(
  'removes a same-block preview when the containing %s changes',
  async (change) => {
    respond = () => ({ sessions: [] });
    await act(async () =>
      root.render(
        <VolumeBotPanel
          project={project}
          wallets={[wallet()]}
          locked={false}
        />,
      ),
    );
    await act(async () => button('Open Volume Bot').click());
    await settle();
    const mode = [...container.querySelectorAll('select')].find((select) =>
      select.querySelector('option[value="bundle"]'),
    )!;
    await changeControl(mode, 'bundle');
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    await act(async () => button('Preview bundle budget').click());
    expect(
      container.querySelector('[aria-label="Bundle budget preview"]'),
    ).not.toBeNull();
    const changed = {
      ...project,
      ...(change === 'project'
        ? { id: '00000000-0000-4000-8000-000000000002' }
        : change === 'revision'
          ? { revision: project.revision + 1 }
          : { archived: true }),
    };
    await act(async () =>
      root.render(
        <VolumeBotPanel
          project={changed}
          wallets={[wallet()]}
          locked={false}
        />,
      ),
    );
    expect(
      container.querySelector('[aria-label="Bundle budget preview"]'),
    ).toBeNull();
    expect(button('Preview bundle budget').disabled).toBe(true);
    expect(calls.every((call) => call.payload === null)).toBe(true);
  },
);
