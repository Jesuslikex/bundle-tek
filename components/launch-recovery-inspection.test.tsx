// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { LaunchRecoveryInspectionPanel } from './launch-recovery-inspection';
import {
  launchRecoveryInspectionUrl,
  type LaunchInspectionReference,
  type LaunchRecoveryInspection,
} from '@/lib/launch-recovery-inspection';

const reference: LaunchInspectionReference = {
  source: 'pump',
  reviewKind: 'create',
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'saved-project',
  mint: bs58.encode(new Uint8Array(32).fill(1)),
  createdAt: '2026-10-18T09:00:00.000Z',
  expiresAt: '2026-10-18T09:05:00.000Z',
};
const payer = bs58.encode(new Uint8Array(32).fill(2));
const signature = bs58.encode(new Uint8Array(64).fill(3));
function inspection(ref = reference): LaunchRecoveryInspection {
  return {
    format: 'launch-recovery-inspection-v1',
    reference: ref,
    inspectedAt: '2026-10-24T12:00:00.000Z',
    recordedState: 'submitted',
    name: 'Original saved token',
    symbol: 'OLD',
    payer,
    payerRevision: 7,
    projectUpdatedAt: '2026-10-18T08:00:00.000Z',
    quoteMint: bs58.encode(new Uint8Array(32).fill(4)),
    hashes:
      ref.reviewKind === 'groups'
        ? [
            { kind: 'packet', index: 0, sha256: 'a'.repeat(64) },
            { kind: 'manifest', index: null, sha256: 'b'.repeat(64) },
          ]
        : [{ kind: 'packet', index: null, sha256: 'a'.repeat(64) }],
    budgets: [
      {
        kind: 'fee-rent-limit',
        address: payer,
        raw: '1000000',
        units: 'lamports',
      },
    ],
    participants: [{ role: 'developer', address: payer, mode: 'unavailable' }],
    signature,
    signatureScope:
      ref.reviewKind === 'groups' ? 'first-group-packet' : 'single-transaction',
    receiptPresent: true,
    packetCount: 1,
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  };
}
const kinds = [
  { source: 'pump', reviewKind: 'create' },
  { source: 'pump', reviewKind: 'developer' },
  { source: 'pump', reviewKind: 'holders' },
  { source: 'pump', reviewKind: 'groups' },
  { source: 'meteora-dbc', reviewKind: 'single' },
  { source: 'stonkfun', reviewKind: 'single' },
  { source: 'launchlab', reviewKind: 'single' },
] as const;
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetcher.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(ref = reference, strict = false) {
  const panel = <LaunchRecoveryInspectionPanel reference={ref} />;
  await act(async () =>
    root.render(strict ? <StrictMode>{panel}</StrictMode> : panel),
  );
}
async function disclosure(open = true) {
  await act(async () => {
    const details = host.querySelector('details')!;
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
  });
}
async function click(label = 'Inspect saved review') {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
function defer() {
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (response: Response) => act(async () => resolve(response));
}
async function load(value = inspection(), ref = value.reference) {
  fetcher.mockResolvedValueOnce(Response.json(value));
  await render(ref);
  await disclosure();
  await click();
}

it('is collapsed/passive on mount, opening and reopening; no automatic read or project dependency', async () => {
  await render(reference, true);
  expect(host.querySelector('details')!.open).toBe(false);
  await disclosure();
  await disclosure(false);
  await disclosure();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain('without opening a current project');
  expect(host.textContent).toContain('archived or disappeared');
});
it.each(kinds)(
  'reads a bounded saved-only $source/$reviewKind inspection on explicit GET and renders original facts',
  async (kind) => {
    const ref = { ...reference, ...kind };
    await load(inspection(ref));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      launchRecoveryInspectionUrl(ref),
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      },
    );
    for (const text of [
      'Original saved token',
      ref.id,
      ref.projectId,
      ref.mint,
      payer,
      '1000000',
      'lamports',
      'a'.repeat(64),
      signature,
      'stored only; not fresh finality',
      'Present, not verified here',
    ])
      expect(host.textContent).toContain(text);
    const link = host.querySelector<HTMLAnchorElement>('a')!;
    expect(link.href).toBe(`https://solscan.io/tx/${signature}`);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(host.querySelector('img,iframe,script,form')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].some((b) =>
        /approve|sign|send|restore|renew/i.test(b.textContent!),
      ),
    ).toBe(false);
    if (kind.reviewKind === 'groups')
      expect(host.textContent).toContain('not a whole-group receipt');
  },
);
it('permits recorded state progression while retaining the original immutable reference and no finality claim', async () => {
  await load({ ...inspection(), recordedState: 'finalized' });
  expect(host.textContent).toContain(
    'finalized (stored only; not fresh finality',
  );
  expect(host.textContent).toContain('does not observe the blockchain');
});
it('shows all raw budgets in25-row pages, keeps zero/null distinct and never assumes SOL for quote units', async () => {
  const value = inspection();
  value.quoteMint = null;
  value.payerRevision = null;
  value.projectUpdatedAt = null;
  value.budgets = Array.from({ length: 26 }, (_, index) => ({
    kind: 'holder-max-quote',
    address: bs58.encode(new Uint8Array(32).fill(index + 5)),
    raw:
      index === 0
        ? null
        : index === 1
          ? '0'
          : index === 25
            ? '18446744073709551615'
            : String(index),
    units: 'raw-quote',
  }));
  await load(value);
  const list = host.querySelector('[aria-label="Saved review raw budgets"]')!;
  expect(list.querySelectorAll('li')).toHaveLength(25);
  expect(list.textContent).toContain('Unavailable raw quote units');
  expect(list.querySelectorAll('li')[1].textContent).toContain(
    '0 raw quote units',
  );
  expect(host.textContent).toContain('No quote currency is assumed');
  expect(host.textContent).not.toContain('18446744073709551615');
  await click('Next budget rows');
  expect(
    host.querySelectorAll('[aria-label="Saved review raw budgets"] li'),
  ).toHaveLength(1);
  expect(host.textContent).toContain('18446744073709551615');
  expect(host.textContent).toContain('Budget rows 26 to 26 of 26');
  await click('Previous budget rows');
  expect(list.querySelectorAll('li')).toHaveLength(25);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('escapes saved text and does not load metadata or fabricate absent signatures and receipts', async () => {
  await load({
    ...inspection(),
    name: '<img src="https://example.invalid/private"/>',
    signature: null,
    receiptPresent: false,
  });
  expect(host.textContent).toContain('<img src=');
  expect(host.querySelector('img,a')).toBeNull();
  expect(host.textContent).toContain('absence is not proof of no execution');
  expect(host.textContent).toContain(
    'does not establish that nothing was signed or sent',
  );
});
it('does not inspect unrecognized kinds or fall back to another workflow', async () => {
  await render({ ...reference, reviewKind: 'uncategorized' });
  await disclosure();
  expect(host.textContent).toContain('unrecognized review kind');
  expect(host.querySelector('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([401, 404, 403, 503])(
  'clears old results on HTTP%s and offers only appropriate fixed recovery guidance',
  async (status) => {
    await load();
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await click('Refresh saved inspection');
    expect(host.querySelector('dl')).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    const link = host.querySelector<HTMLAnchorElement>('a');
    if (status === 401) {
      expect(link?.getAttribute('href')).toBe('/sign-in');
      expect(link?.target).toBe('_blank');
      expect(link?.rel).toBe('noopener noreferrer');
    } else {
      expect(link).toBeNull();
      expect(host.textContent).toContain('original reference');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it('clears sign-in while a new manual retry is pending and never resumes automatically', async () => {
  fetcher.mockResolvedValueOnce(new Response('expired', { status: 401 }));
  await render();
  await disclosure();
  await click();
  await act(async () => vi.advanceTimersByTime(30000));
  expect(fetcher).toHaveBeenCalledOnce();
  const finish = defer();
  await click();
  expect(host.querySelector('a')).toBeNull();
  await finish(Response.json(inspection()));
  expect(host.querySelector('dl')).not.toBeNull();
});
it.each([
  { signingAllowed: true },
  { executionAllowed: true },
  { receiptVerified: true },
  { reference: { ...reference, mint: payer } },
  { signature: 'noncanonical-signature' },
  { transaction: 'forbidden-unsigned-packet' },
  {
    budgets: [
      { kind: 'fee-rent-limit', address: payer, raw: '01', units: 'lamports' },
    ],
  },
])(
  'refuses changed authority/binding, raw payloads and malformed display data (%#)',
  async (changes) => {
    await render();
    await disclosure();
    fetcher.mockResolvedValueOnce(
      Response.json({ ...inspection(), ...changes }),
    );
    await click();
    expect(host.querySelector('dl,a')).toBeNull();
    expect(host.textContent).toContain('unavailable');
    expect(host.textContent).not.toContain('forbidden-unsigned-packet');
  },
);
it('sanitizes parser and transport failures instead of displaying HTML or endpoint values', async () => {
  await render();
  await disclosure();
  fetcher.mockResolvedValueOnce(
    new Response('<html>private raw content</html>', { status: 502 }),
  );
  await click();
  expect(host.textContent).not.toContain('private raw content');
  fetcher.mockRejectedValueOnce(Error('https://secret-provider.invalid/key'));
  await click();
  expect(host.textContent).not.toContain('secret-provider');
});
it('releases a hung fetch at15seconds and ignores late success after a manual retry', async () => {
  const finish = defer();
  await render();
  await disclosure();
  await click();
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await act(async () => vi.advanceTimersByTime(15000));
  expect(signal.aborted).toBe(true);
  expect(host.textContent).toContain('took too long');
  fetcher.mockResolvedValueOnce(Response.json(inspection()));
  await click();
  const cancel = vi.fn();
  await finish(new Response(new ReadableStream({ cancel })));
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.querySelector('dl')).not.toBeNull();
});
it('releases/cancels a response-body read at15seconds with no retained result', async () => {
  const cancel = vi.fn();
  fetcher.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await render();
  await disclosure();
  await click();
  await act(async () => vi.advanceTimersByTime(15000));
  expect(cancel).toHaveBeenCalledOnce();
  expect(host.querySelector('dl')).toBeNull();
  expect(host.textContent).toContain('took too long');
});
it.each(['cancel', 'close', 'reference', 'unmount'])(
  'discards late401 after %s and never restores stale results or auth',
  async (action) => {
    const finish = defer();
    await render();
    await disclosure();
    await click();
    const signal = fetcher.mock.calls[0][1]!.signal!;
    if (action === 'cancel') await click('Cancel inspection read');
    else if (action === 'close') await disclosure(false);
    else if (action === 'reference')
      await render({ ...reference, projectId: 'different-project' });
    else {
      await act(async () => root.unmount());
      root = createRoot(host);
    }
    expect(signal.aborted).toBe(true);
    await finish(new Response('expired', { status: 401 }));
    expect(host.querySelector('dl,a')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('clears an already loaded inspection on close and reopens passively at the original reference', async () => {
  await load();
  await disclosure(false);
  expect(host.querySelector('dl')).toBeNull();
  await disclosure();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.querySelector('pre')!.textContent).toContain(reference.id);
});

it('separates the native fee allowance from creator-buy amounts and includes original holder targets', async () => {
  const ref = {
    ...reference,
    source: 'meteora-dbc' as const,
    reviewKind: 'single' as const,
  };
  const current = inspection(ref);
  current.budgets = [
    {
      kind: 'sol-spend-limit',
      address: payer,
      raw: '50000000',
      units: 'lamports',
    },
    {
      kind: 'developer-buy',
      address: payer,
      raw: '100000000',
      units: 'raw-quote',
    },
    {
      kind: 'pool-creation-fee',
      address: payer,
      raw: '123',
      units: 'lamports',
    },
    {
      kind: 'holder-quote-input',
      address: payer,
      raw: '9',
      units: 'raw-quote',
    },
    {
      kind: 'holder-token-output',
      address: payer,
      raw: '8',
      units: 'raw-token',
    },
  ];
  await load(current);
  expect(host.textContent).toContain(
    'SOL fee/rent allowance (creator buy is separate)',
  );
  expect(host.textContent).toContain('included in the venue fee allowance');
  expect(host.textContent).toContain('Holder exact quote input');
  expect(host.textContent).toContain('Holder exact token output');
  expect(host.textContent).not.toContain('SOL spending limit');
});

it('keeps keyboard position at the announced page when a boundary button becomes disabled', async () => {
  const current = inspection();
  current.budgets = Array.from({ length: 26 }, (_, i) => ({
    kind: 'holder-fee-rent-limit' as const,
    address: bs58.encode(new Uint8Array(32).fill(i + 4)),
    raw: '1',
    units: 'lamports' as const,
  }));
  await load(current);
  const next = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Next budget rows',
  )!;
  next.focus();
  await click('Next budget rows');
  const status = host.querySelector('output[aria-label="Saved budget page"]')!;
  expect(document.activeElement).toBe(status);
  expect(status.textContent).toContain('26 to 26 of 26');
  const previous = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Previous budget rows',
  )!;
  previous.focus();
  await click('Previous budget rows');
  expect(document.activeElement).toBe(status);
  expect(status.textContent).toContain('1 to 25 of 26');
});

it('shows known saved-input limits separately from unavailable allowances and retained terms', async () => {
  const holder = bs58.encode(new Uint8Array(32).fill(9));
  const current = inspection({ ...reference, reviewKind: 'holders' });
  current.participants = [
    { role: 'developer', address: payer, mode: 'exact-base-output' },
    { role: 'holder', address: holder, mode: 'exact-quote-input' },
  ];
  current.budgets = [
    {
      kind: 'developer-max-quote',
      address: payer,
      raw: null,
      units: 'raw-quote',
    },
    {
      kind: 'developer-input-max-quote',
      address: payer,
      raw: '12345',
      units: 'raw-quote',
    },
    {
      kind: 'holder-max-quote',
      address: holder,
      raw: null,
      units: 'raw-quote',
    },
    {
      kind: 'holder-input-max-quote',
      address: holder,
      raw: '22',
      units: 'raw-quote',
    },
    {
      kind: 'holder-min-output',
      address: holder,
      raw: null,
      units: 'raw-token',
    },
    {
      kind: 'holder-input-min-output',
      address: holder,
      raw: '0',
      units: 'raw-token',
    },
    {
      kind: 'terms-fee-rent-limit',
      address: payer,
      raw: '300',
      units: 'lamports',
    },
  ];
  await load(current);
  const rows = [
    ...host.querySelectorAll('[aria-label="Saved review raw budgets"] li'),
  ];
  expect(rows[0].textContent).toContain('Developer maximum quote allowance');
  expect(rows[0].textContent).toContain('Unavailable raw quote units');
  expect(rows[1].textContent).toContain(
    'Developer saved-input maximum quote cost',
  );
  expect(rows[1].textContent).toContain('12345 raw quote units');
  expect(rows[1].textContent).toContain(
    'Recorded developer intent: Exact token output requested',
  );
  expect(rows[2].textContent).toContain('Holder maximum quote allowance');
  expect(rows[2].textContent).toContain('Unavailable raw quote units');
  expect(rows[3].textContent).toContain(
    'Holder saved-input maximum quote cost',
  );
  expect(rows[3].textContent).toContain('22 raw quote units');
  expect(rows[3].textContent).toContain(
    'Recorded holder intent: Exact quote input requested',
  );
  expect(rows[4].textContent).toContain(
    'Holder minimum token output allowance',
  );
  expect(rows[4].textContent).toContain('Unavailable raw token units');
  expect(rows[5].textContent).toContain(
    'Holder saved-input minimum token output',
  );
  expect(rows[5].textContent).toContain('0 raw token units');
  expect(rows[6].textContent).toContain('Fee and rent limit from saved terms');
  expect(rows[6].textContent).toContain('300 lamports');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('distinguishes an explicit no-buy intent from unavailable intent without inferring from a zero budget', async () => {
  const inactive = bs58.encode(new Uint8Array(32).fill(8));
  const unavailable = bs58.encode(new Uint8Array(32).fill(9));
  const absent = bs58.encode(new Uint8Array(32).fill(10));
  const current = inspection({ ...reference, reviewKind: 'groups' });
  current.participants = [
    { role: 'developer', address: payer, mode: 'not-requested' },
    { role: 'holder', address: inactive, mode: 'not-requested' },
    { role: 'holder', address: unavailable, mode: 'unavailable' },
  ];
  current.budgets = [inactive, unavailable, absent].map((address) => ({
    kind: 'holder-fee-rent-limit',
    address,
    raw: '0',
    units: 'lamports',
  }));
  await load(current);
  expect(host.textContent).toContain('2 holder wallets and 1 developer wallet');
  expect(host.textContent).toContain(
    'stored requests, not executed buys or holdings',
  );
  const rows = [
    ...host.querySelectorAll('[aria-label="Saved review raw budgets"] li'),
  ];
  expect(rows[0].textContent).toContain(
    'Recorded holder intent: No buy requested in this saved review',
  );
  expect(rows[1].textContent).toContain(
    'Recorded holder intent: Unavailable; this does not establish that no buy was requested',
  );
  expect(rows[2].textContent).toContain(
    'Recorded holder intent: Unavailable; this does not establish that no buy was requested',
  );
  expect(rows[1].textContent).not.toContain(
    'No buy requested in this saved review',
  );
  expect(
    host.querySelectorAll('[aria-label="Recorded wallet intents"] li'),
  ).toHaveLength(3);
});

it('explains a409 reference/format refusal without offering an automatic fallback or generic retry advice', async () => {
  fetcher.mockResolvedValueOnce(
    new Response('private stored error', { status: 409 }),
  );
  await render();
  await disclosure();
  await click();
  expect(host.textContent).toContain(
    'original saved review reference or format cannot be inspected',
  );
  expect(host.textContent).toContain('No alternative workflow was started');
  expect(host.textContent).not.toContain('Try again manually');
  expect(host.textContent).not.toContain('private stored error');
  expect(host.querySelector('dl,a')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
