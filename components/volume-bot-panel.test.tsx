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
  localStorage.setItem(VAULT_STORAGE_KEY, encrypted);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const payload = options.body
        ? (JSON.parse(options.body as string) as Record<string, unknown>)
        : null;
      calls.push({ url: String(url), payload });
      return Response.json(respond(payload));
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

it('estimates with the chosen settings and saves the session', async () => {
  const seedPlan = (seed: string) =>
    planVolumeSession(
      {
        targetVolumeLamports: '1000000000',
        durationSeconds: 1800,
        delayMinMs: 5000,
        delayMaxMs: 20000,
        amount: { kind: 'auto' },
        wave: 'tight',
        wallets: [address],
      },
      [{ address, lamports: '10000000000' }],
      seed,
    );
  respond = (payload) =>
    payload?.action === 'estimate'
      ? { plan: seedPlan(payload.seed as string) }
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
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await act(async () => button('Estimate').click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Round trips'),
  );
  const estimate = calls.find((c) => c.payload?.action === 'estimate')!;
  expect(estimate.payload).toMatchObject({
    projectId: PROJECT,
    projectRevision: 2,
    terms: {
      targetVolumeLamports: '1000000000',
      durationSeconds: 1800,
      delayMinMs: 5000,
      delayMaxMs: 20000,
      amount: { kind: 'auto' },
      wave: 'tight',
      wallets: [address],
    },
  });
  expect(container.textContent).toContain('1 SOL');
  expect(
    container.querySelector('[aria-label="Volume Bot estimate"]')?.textContent,
  ).toContain('Execution modeScheduled swaps');
  expect(container.textContent).toContain('Delivery: configured Solana RPC');
  expect(container.textContent).toContain(
    'does not request dedicated sandwich protection',
  );
  await act(async () => button('Save session and reserve wallets').click());
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

function usdQuote() {
  const at = new Date().toISOString();
  return captureVolumeUsdTarget(
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
  );
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
async function openUsd() {
  await act(async () =>
    root.render(
      <VolumeBotPanel project={project} wallets={[wallet()]} locked={false} />,
    ),
  );
  await act(async () => button('Open Volume Bot').click());
  await settle();
  await changeControl(
    Array.from(container.querySelectorAll('select')).find((select) =>
      select.querySelector('option[value="USD"]'),
    )!,
    'USD',
  );
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
}
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
  expect(button('Estimate').disabled).toBe(true);
  expect(calls.some((c) => c.payload?.action === 'quote-usd-target')).toBe(
    false,
  );
  await act(async () => button('Capture USD conversion').click());
  await settle();
  expect(container.textContent).toContain('$100 converts to 0.5 SOL');
  await act(async () => button('Estimate').click());
  await settle();
  const save = button('Save session and reserve wallets');
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
it('clears captured conversion when the target changes and refuses expired conversion', async () => {
  const quote = usdQuote();
  respond = (p) =>
    p?.action === 'quote-usd-target'
      ? { quote, executionAllowed: false }
      : { sessions: [] };
  await openUsd();
  await act(async () => button('Capture USD conversion').click());
  await settle();
  const input = container.querySelector(
    'input[inputmode=decimal]',
  ) as HTMLInputElement;
  await changeControl(input, '120');
  expect(container.textContent).not.toContain('$100 converts');
  expect(button('Estimate').disabled).toBe(true);
  await changeControl(input, '100');
  await act(async () => button('Capture USD conversion').click());
  await settle();
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(quote.expiresAt));
  try {
    await act(async () => button('Estimate').click());
    await settle();
    expect(container.textContent).toContain('Capture a fresh USD conversion');
  } finally {
    clock.mockRestore();
  }
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
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
  expect(button('Estimate').disabled).toBe(true);
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
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
  await act(async () => button('Estimate').click());
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
      ),
    }),
  );
  await settle();
  expect(container.textContent).not.toContain('Round trips');
  expect(button('Save session and reserve wallets')).toBeUndefined();
});

async function openSolTiming() {
  respond = (payload) =>
    payload?.action === 'estimate'
      ? {
          plan: planVolumeSession(
            payload.terms as never,
            [{ address, lamports: '10000000000' }],
            payload.seed as string,
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
  await act(async () =>
    (
      container.querySelector('input[type=checkbox]') as HTMLInputElement
    ).click(),
  );
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
  await act(async () => button('Estimate').click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain('0.7 intensity'),
  );
  const estimated = calls.find(
    (call) => call.payload?.action === 'estimate',
  )!.payload!;
  expect(estimated.terms).toMatchObject({
    wave: 'big-waves',
    waveIntensityTenths: 7,
  });
  await act(async () => button('Save session and reserve wallets').click());
  await vi.waitFor(() =>
    expect(calls.some((call) => call.payload?.action === 'create')).toBe(true),
  );
  expect(
    calls.find((call) => call.payload?.action === 'create')!.payload!.terms,
  ).toEqual(estimated.terms);
  await changeControl(slider, '0.3');
  expect(button('Save session and reserve wallets')).toBeUndefined();
  expect(
    calls.some((call) =>
      ['register', 'send'].includes(String(call.payload?.action)),
    ),
  ).toBe(false);
});
it('sends exact HMS seconds and exact millisecond delays, then invalidates even an equivalent raw edit', async () => {
  await openSolTiming();
  await setSessionTime('1', '2', '3');
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum delay"]')!,
    '1.234',
  );
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Maximum delay"]')!,
    '2.345',
  );
  await act(async () => button('Estimate').click());
  await settle();
  expect(
    calls.find((c) => c.payload?.action === 'estimate')?.payload?.terms,
  ).toMatchObject({
    durationSeconds: 3723,
    delayMinMs: 1234,
    delayMaxMs: 2345,
  });
  expect(container.textContent).toContain('3,723 seconds total');
  expect(container.textContent).toContain('1h 2m 3s');
  expect(container.textContent).toContain('Schedule limit');
  expect(container.textContent).toContain('Round trips');
  await changeControl(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Session duration: minutes"]',
    )!,
    '02',
  );
  expect(container.textContent).not.toContain('Round trips');
  expect(container.textContent).toContain('3,723 seconds total');
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
    expect(button('Estimate').disabled).toBe(true);
    await act(async () => button('Estimate').click());
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
    expect(button('Estimate').disabled).toBe(false);
    await act(async () => button('Estimate').click());
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
    await changeControl(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Minimum delay"]',
      )!,
      delay,
    );
    await act(async () => button('Estimate').click());
    await settle();
    expect(container.textContent).toContain(
      'from 1 to 600 seconds with at most three decimal places',
    );
    expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
  },
);
it('refuses a reversed delay range locally before observing wallet balances', async () => {
  await openSolTiming();
  await changeControl(
    container.querySelector<HTMLInputElement>('[aria-label="Minimum delay"]')!,
    '21',
  );
  await act(async () => button('Estimate').click());
  await settle();
  expect(container.textContent).toContain(
    'maximum delay at or above the minimum',
  );
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
});
it('keeps optional trade settings collapsed and provides an explicit error recovery path', async () => {
  await openSolTiming();
  const minimum = container.querySelector<HTMLInputElement>(
    '[aria-label="Minimum delay"]',
  )!;
  const settings = minimum.closest('details')!;
  expect(settings.open).toBe(false);
  expect(
    container.querySelector('input[type=checkbox]')!.closest('details'),
  ).toBeNull();
  await changeControl(minimum, '0');
  await act(async () => button('Estimate').click());
  await settle();
  expect(calls.some((c) => c.payload?.action === 'estimate')).toBe(false);
  await act(async () => button('Edit trade settings').click());
  expect(settings.open).toBe(true);
  expect(document.activeElement).toBe(settings.querySelector('summary'));
  await changeControl(minimum, '5');
  await act(async () => button('Estimate').click());
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
  expect(container.textContent).not.toContain(
    'Save session and reserve wallets',
  );
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
