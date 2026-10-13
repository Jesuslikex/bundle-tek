// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import bs58 from 'bs58';
import {
  SessionEntryOutcomesPanel,
  SessionEntryOutcomes as SessionHistoryOutcomes,
} from './session-entry-outcomes';
import {
  tradeSessionTerms,
  type TradeSession,
} from '@/lib/imported-trade-session';
import type { SessionJobEvent } from '@/lib/session-preparation-job-events';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type {
  SessionEntryApproval,
  SessionEntryOutcomes,
} from '@/lib/session-entry-outcomes';
import { sessionOutcomeSummary } from '@/lib/session-outcome-summary';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const signature = bs58.encode(new Uint8Array(64).fill(12));
const time = (n: number) => `2026-10-13T00:00:0${n}.000Z`;
const eventId = 'a'.repeat(32);
function project(projectId = id(1), archived = false): ImportedTokenProject {
  return {
    id: projectId,
    revision: 1,
    archived,
    updatedAt: time(0),
    document: {
      format: 'imported-token-project-v1',
      executionAllowed: false,
      token: {
        chain: 'Solana',
        address: wallet(7),
        name: 'Fixture token',
        symbol: 'TOK',
        decimals: 6,
        totalSupplyRaw: '10000000000',
        observedAt: time(0),
        source: 'fixture.test',
      },
    },
  };
}
function session(
  projectId = id(1),
  side: 'Buy' | 'Sell' = 'Buy',
): TradeSession {
  return {
    id: id(projectId === id(1) ? 2 : 99),
    revision: 1,
    state: 'active',
    terms: tradeSessionTerms(
      {
        projectId,
        projectRevision: 1,
        side,
        entries: [
          { wallet: wallet(1), walletRevision: 1, amount: '0.000001' },
          { wallet: wallet(2), walletRevision: 2, amount: '0.002' },
          { wallet: wallet(3), walletRevision: 3, amount: '0.03' },
          { wallet: wallet(4), walletRevision: 4, amount: '0.04' },
          { wallet: wallet(5), walletRevision: 5, amount: '0.05' },
          { wallet: wallet(6), walletRevision: 6, amount: '0.06' },
        ],
        schedule: { startAt: time(0), spacingSeconds: 30 },
      },
      { chain: 'Solana', address: wallet(7), decimals: 6 },
    ),
    createdAt: time(0),
    updatedAt: time(0),
  };
}
function page(s = session()): SessionEntryOutcomes {
  return {
    projectId: s.terms.projectId,
    session: s,
    sampledAt: time(4),
    executionAllowed: false,
    missingSources: [],
    entries: s.terms.entries.map((entry) => ({
      ...entry,
      preparation: null,
      approval: null,
      receipt: null,
      receiptEvidence: 'not-applicable',
    })),
  };
}
function job(
  s: TradeSession,
  entry: number,
  state: SessionJobEvent['document']['state'],
  error: string | null = null,
): SessionJobEvent {
  return {
    id: entry.toString(16).padStart(32, '0'),
    sequence: entry,
    projectId: s.terms.projectId,
    sessionId: s.id,
    jobId: id(100 + entry),
    createdAt: time(1),
    document: {
      id: id(100 + entry),
      entry,
      state,
      attempts: state === 'queued' ? 0 : 1,
      preparationId: state === 'prepared' ? id(200 + entry) : null,
      error,
    },
  };
}
function approval(
  entry: number,
  state: SessionEntryApproval['state'],
): SessionEntryApproval {
  return {
    intentId: id(300 + entry),
    preparationId: id(200 + entry),
    state,
    signature: ['awaiting_signature', 'cancelled'].includes(state)
      ? null
      : signature,
    receiptId: state === 'finalized' ? id(400 + entry) : null,
    sha256: 'a'.repeat(64),
    observedAt: time(3),
  };
}
function receipt(s: TradeSession, entry: number): ImportedSwapReceipt {
  const terms = s.terms.entries[entry - 1];
  return {
    id: id(400 + entry),
    projectId: s.terms.projectId,
    preparationId: id(200 + entry),
    projectRevision: s.terms.projectRevision,
    walletRevision: terms.walletRevision,
    createdAt: time(2),
    document: {
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      mint: s.terms.mint,
      decimals: s.terms.decimals,
      wallet: terms.wallet,
      side: s.terms.side,
      tokenUnitsRaw: s.terms.side === 'Buy' ? '1234567' : terms.unitsRaw,
      preparationSha256: 'a'.repeat(64),
      signature,
      source: 'fixture.test',
      observedAt: time(2),
    },
  };
}
function mixed(s = session()): SessionEntryOutcomes {
  const p = page(s);
  p.entries[0].preparation = job(s, 1, 'queued');
  p.entries[0].approval = approval(1, 'awaiting_signature');
  p.entries[1].preparation = job(s, 2, 'failed', 'balance-unavailable');
  p.entries[2].preparation = job(s, 3, 'prepared');
  p.entries[2].approval = approval(3, 'finalized');
  p.entries[2].receipt = receipt(s, 3);
  p.entries[2].receiptEvidence = 'matching';
  p.entries[3].approval = approval(4, 'failed');
  p.entries[5].approval = approval(6, 'finalized');
  p.entries[5].receiptEvidence = 'contradictory';
  return p;
}
it('reconciles exact allocation progress only from matching receipts and separates unresolved states', () => {
  const p = mixed();
  const summary = sessionOutcomeSummary(p);
  expect(summary.counts).toEqual({
    verified: 1,
    awaitingSignature: 1,
    awaitingSettlement: 0,
    finalizedWithoutReceipt: 1,
    failedOrCancelled: 1,
    noApprovalRecord: 2,
    unknownApproval: 0,
  });
  expect(summary.verifiedInputRaw).toBe(p.entries[2].unitsRaw);
  expect(
    BigInt(summary.verifiedInputRaw) + BigInt(summary.unverifiedInputRaw),
  ).toBe(BigInt(p.session.terms.totalRaw));
  expect(summary.verifiedBudgetBasisPoints).toBe(
    Number(
      (BigInt(p.entries[2].unitsRaw) * 10000n) /
        BigInt(p.session.terms.totalRaw),
    ),
  );
  const missing = page();
  missing.missingSources = ['approval', 'receipts'];
  expect(sessionOutcomeSummary(missing).counts.unknownApproval).toBe(6);
  expect(sessionOutcomeSummary(missing).counts.noApprovalRecord).toBe(0);
});
it('does not count signed, submitted or missing finalized receipt allocations as verified', () => {
  const p = page();
  p.entries[0].approval = approval(1, 'signed');
  p.entries[1].approval = approval(2, 'submitted');
  p.entries[2].approval = approval(3, 'finalized');
  p.entries[2].receiptEvidence = 'unavailable';
  const summary = sessionOutcomeSummary(p);
  expect(summary.counts.awaitingSettlement).toBe(2);
  expect(summary.counts.finalizedWithoutReceipt).toBe(1);
  expect(summary.verifiedInputRaw).toBe('0');
  expect(summary.unverifiedInputRaw).toBe(p.session.terms.totalRaw);
});
it('keeps Sell allocation sums exact above the safe-number range and floors the weighted budget percentage', () => {
  const s = session();
  s.terms = tradeSessionTerms(
    {
      projectId: s.terms.projectId,
      projectRevision: 1,
      side: 'Sell',
      entries: [
        { wallet: wallet(1), walletRevision: 1, amount: '9007199254.740993' },
        { wallet: wallet(2), walletRevision: 1, amount: '0.000001' },
      ],
    },
    { chain: 'Solana', address: wallet(7), decimals: 6 },
  );
  const p = page(s);
  p.entries[0].approval = approval(1, 'finalized');
  p.entries[0].receipt = receipt(s, 1);
  p.entries[0].receiptEvidence = 'matching';
  const summary = sessionOutcomeSummary(p);
  expect(summary.verifiedInputRaw).toBe('9007199254740993');
  expect(summary.unverifiedInputRaw).toBe('1');
  expect(summary.totalInputRaw).toBe('9007199254740994');
  expect(summary.verifiedBudgetBasisPoints).toBe(9999);
});
it('rejects duplicate finalized signatures and altered receipt identities before showing aggregate progress', () => {
  const p = page();
  for (const entry of [1, 2]) {
    p.entries[entry - 1].approval = approval(entry, 'finalized');
    p.entries[entry - 1].receipt = receipt(p.session, entry);
    p.entries[entry - 1].receiptEvidence = 'matching';
  }
  expect(() => sessionOutcomeSummary(p)).toThrow('Repeated receipt');
  p.entries[1].receipt!.document.signature = bs58.encode(
    new Uint8Array(64).fill(13),
  );
  expect(() => sessionOutcomeSummary(p)).toThrow('Matching session receipt');
});
it('renders aggregate verified allocation alongside recovery evidence without calling it spend or P&L', async () => {
  await click('Open session wallet outcomes');
  await respond(0, mixed());
  const summary = container.querySelector(
    'section[aria-label="Session progress"]',
  )!;
  expect(summary.textContent).toContain(
    '1 of 6 entries have matching finalized receipts',
  );
  expect(summary.textContent).toContain('0.03 SOL');
  expect(summary.textContent).toContain('not actual all-in spend');
  expect(summary.textContent).toContain(
    'Finalized approval without matching receipt: 1',
  );
  const progress = summary.querySelector('progress')!;
  expect(progress.value).toBe(1);
  expect(progress.max).toBe(6);
});

let container: HTMLDivElement;
let root: Root;
let saved: TradeSession;
let recover: Mock<(entry: number, intentId: string) => void>;
let reviewBuy: Mock<(receipt: ImportedSwapReceipt) => void>;
let requests: {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}[];
async function render(
  s = saved,
  revision = 1,
  recoveryDisabled = false,
  sellDisabled = false,
) {
  await act(async () =>
    root.render(
      <SessionEntryOutcomesPanel
        session={s}
        revision={revision}
        onRecover={recover}
        onReviewBuy={reviewBuy}
        recoveryDisabled={recoveryDisabled}
        sellDisabled={sellDisabled}
      />,
    ),
  );
}
function button(name: string) {
  const b = [...container.querySelectorAll('button')].find((value) =>
    value.textContent?.includes(name),
  );
  if (!b) throw new Error('Button missing: ' + name);
  return b;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function respond(index: number, value: unknown, status = 200) {
  await act(async () =>
    requests[index].resolve(Response.json(value, { status })),
  );
}
function row(entry: number) {
  return container.querySelector<HTMLElement>(
    `article[aria-label="Saved wallet entry ${entry}"]`,
  )!;
}
beforeEach(async () => {
  requests = [];
  saved = session();
  recover = vi.fn<(entry: number, intentId: string) => void>();
  reviewBuy = vi.fn<(receipt: ImportedSwapReceipt) => void>();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) =>
          requests.push({ url, init, resolve, reject }),
        ),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('demand-loads one read-only snapshot and keeps every saved wallet through mixed retained states', async () => {
  expect(fetch).not.toHaveBeenCalled();
  await click('Open session');
  expect(requests).toHaveLength(1);
  const request = requests[0];
  const url = new URL(request.url, 'http://test');
  expect(url.pathname).toBe('/api/imported-projects/session-entry-outcomes');
  expect(url.searchParams.get('projectId')).toBe(saved.terms.projectId);
  expect(url.searchParams.get('sessionId')).toBe(saved.id);
  expect(request.init.method).toBe('GET');
  expect(request.init.cache).toBe('no-store');
  expect(request.init.body).toBeUndefined();
  expect(container.querySelectorAll('ol > li')).toHaveLength(6);
  expect(row(6).textContent).toContain('Outcomes are unknown');
  await respond(0, mixed());
  expect(container.querySelectorAll('ol > li')).toHaveLength(6);
  for (const entry of saved.terms.entries) {
    expect(row(entry.entry).textContent).toContain(entry.wallet);
    expect(row(entry.entry).textContent).toContain(
      `Saved Buy input: ${entry.amount} SOL`,
    );
    expect(row(entry.entry).textContent).toContain(
      `Exact input: ${entry.unitsRaw} lamports`,
    );
  }
  expect(row(1).textContent).toContain('Unsigned preparation queued (queued)');
  expect(row(2).textContent).toContain('Preparation failed (failed)');
  expect(row(2).textContent).toContain('Recorded attempts: 1/3');
  expect(row(2).textContent).toContain(time(1));
  expect(row(2).textContent).toContain('balance-unavailable');
  expect(row(2).textContent).toContain(
    'Insufficient or unsupported balance evidence',
  );
  expect(row(2).textContent).not.toContain('insufficient SOL');
  expect(row(3).textContent).toContain(
    'Matching finalized Buy receipt: 1.234567 tokens acquired',
  );
  expect(row(3).textContent).toContain('1234567 token atomic units');
  expect(row(3).textContent).toContain(signature);
  expect(row(4).textContent).toContain(
    'does not establish a finalized transaction failure',
  );
  expect(row(5).textContent).toContain('prior attempts are unknown');
  expect(row(6).textContent).toContain('Receipt evidence is contradictory');
  expect(row(6).textContent).not.toContain('tokens acquired');
  expect(container.textContent).toContain(
    `Retained snapshot sampled (UTC): ${time(4)}`,
  );
  expect(container.textContent).toContain(
    'separate from historical timeline events',
  );
  expect(container.textContent).not.toContain('executionSkipped');
});

it('passes only captured approvals and matching finalized Buy receipts to existing review callbacks', async () => {
  await click('Open session');
  const p = mixed();
  await respond(0, p);
  expect([...row(2).querySelectorAll('button')]).toHaveLength(0);
  expect([...row(5).querySelectorAll('button')]).toHaveLength(0);
  await click('Review saved approval for entry 1');
  expect(recover).toHaveBeenLastCalledWith(1, id(301));
  await click('Review saved approval for entry 4');
  expect(recover).toHaveBeenLastCalledWith(4, id(304));
  await click('Review sell of acquired tokens for entry 3');
  expect(reviewBuy).toHaveBeenCalledExactlyOnceWith(p.entries[2].receipt);
  expect(row(6).querySelectorAll('button')).toHaveLength(1);
  await render(saved, 1, true, true);
  expect(requests).toHaveLength(1);
  expect(button('Review saved approval for entry 3').disabled).toBe(true);
  expect(button('Review sell of acquired tokens for entry 3').disabled).toBe(
    true,
  );
  await click('Review saved approval for entry 3');
  await click('Review sell of acquired tokens for entry 3');
  expect(recover).toHaveBeenCalledTimes(2);
  expect(reviewBuy).toHaveBeenCalledTimes(1);
});

it('uses token denomination and exact saved Sell amounts without a buy-receipt sell handoff', async () => {
  saved = session(id(1), 'Sell');
  await render();
  await click('Open session');
  await respond(0, mixed(saved));
  expect(row(1).textContent).toContain('Saved Sell input: 0.000001 tokens');
  expect(row(1).textContent).toContain('Exact input: 1 token atomic units');
  expect(row(3).textContent).toContain(
    'Matching finalized Sell receipt: 0.03 tokens sold',
  );
  expect(row(3).textContent).toContain(
    'Exact token amount: 30000 token atomic units',
  );
  expect(container.textContent).not.toContain('Review sell of acquired tokens');
  expect(reviewBuy).not.toHaveBeenCalled();
});

it('discloses incomplete source coverage, unknown prior attempts and retained cancellation separately', async () => {
  await click('Open session');
  const p = page();
  p.missingSources = ['preparation', 'approval', 'receipts'];
  p.session = {
    ...p.session,
    state: 'cancelled',
    revision: 2,
    updatedAt: time(3),
  };
  await respond(0, p);
  expect(container.textContent).toContain(
    'Unavailable sources: preparation, approval, receipts',
  );
  expect(container.textContent).toContain('Saved session state: cancelled');
  expect(row(1).textContent).toContain(
    'Preparation source unavailable; prior attempts are unknown',
  );
  expect(row(1).textContent).toContain(
    'Approval source unavailable; prior approvals are unknown',
  );
  expect(row(1).textContent).toContain('Receipt source unavailable');
  expect(container.querySelectorAll('ol button')).toHaveLength(0);
  expect(container.textContent).not.toContain('Not approved');
  expect(container.textContent).not.toContain('skipped');
  expect(recover).not.toHaveBeenCalled();
  expect(reviewBuy).not.toHaveBeenCalled();
});

it.each([
  'owner',
  'entry-wallet',
  'session',
  'terms',
  'receipt-wallet',
  'receipt-amount',
] as const)(
  'withholds mismatched %s response evidence and callbacks',
  async (mismatch) => {
    await click('Open session');
    const p = mixed();
    if (mismatch === 'owner') p.projectId = id(999);
    if (mismatch === 'entry-wallet') p.entries[0].wallet = wallet(8);
    if (mismatch === 'session') p.session.id = id(999);
    if (mismatch === 'terms') p.entries[0].unitsRaw = '999';
    if (mismatch === 'receipt-wallet')
      p.entries[2].receipt!.document.wallet = wallet(8);
    if (mismatch === 'receipt-amount')
      p.entries[2].receipt!.document.tokenUnitsRaw = '0';
    await respond(0, p);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelectorAll('ol > li')).toHaveLength(6);
    expect(container.querySelectorAll('ol button')).toHaveLength(0);
    expect(row(3).textContent).not.toContain('Matching finalized');
    expect(row(3).textContent).toContain('Outcomes are unknown');
    expect(recover).not.toHaveBeenCalled();
    expect(reviewBuy).not.toHaveBeenCalled();
  },
);

it('aborts closing and obsolete project requests and ignores their late responses', async () => {
  await click('Open session');
  await click('Close session');
  expect(requests[0].init.signal?.aborted).toBe(true);
  await respond(0, mixed());
  expect(container.querySelector('ol')).toBeNull();
  await click('Open session');
  expect(requests).toHaveLength(2);
  const other = session(id(9));
  await render(other);
  expect(requests[1].init.signal?.aborted).toBe(true);
  expect(requests).toHaveLength(3);
  expect(
    new URL(requests[2].url, 'http://test').searchParams.get('projectId'),
  ).toBe(id(9));
  await respond(1, mixed());
  expect(row(3).textContent).not.toContain('Matching finalized');
  await respond(2, mixed(other));
  expect(row(3).textContent).toContain('Matching finalized');
  await act(async () => root.unmount());
  expect(container.textContent).toBe('');
  root = createRoot(container);
});

it('reloads revisions only while open and ignores an obsolete revision response', async () => {
  await render(saved, 2);
  expect(requests).toHaveLength(0);
  await click('Open session');
  await render(structuredClone(saved), 2);
  expect(requests).toHaveLength(1);
  await render(saved, 3);
  expect(requests).toHaveLength(2);
  expect(requests[0].init.signal?.aborted).toBe(true);
  await respond(0, mixed());
  expect(row(3).textContent).not.toContain('Matching finalized');
  await respond(1, page());
  expect(row(3).textContent).toContain('No retained approval record');
  await click('Close session');
  await render(saved, 4);
  expect(requests).toHaveLength(2);
  await click('Open session');
  expect(requests).toHaveLength(3);
});

it('retains the previous sampled snapshot through a failed reload without reflecting server payloads', async () => {
  await click('Open session');
  await respond(0, mixed());
  await click('Reload session');
  expect(button('Review saved approval for entry 3').disabled).toBe(true);
  await respond(
    1,
    { error: 'provider-private-payload', jobs: ['raw-packet'] },
    503,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'previous snapshot remains visible',
  );
  expect(row(3).textContent).toContain('Matching finalized');
  expect(container.textContent).toContain(time(4));
  expect(container.textContent).not.toContain('provider-private-payload');
  expect(container.textContent).not.toContain('raw-packet');
  await click('Reload session');
  const p = page();
  p.sampledAt = time(5);
  p.entries[2].approval = approval(3, 'finalized');
  p.entries[2].receiptEvidence = 'unavailable';
  p.missingSources = ['receipts'];
  await respond(2, p);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(row(3).textContent).toContain(
    'Matching finalized receipt unavailable',
  );
  expect(row(3).textContent).not.toContain('tokens acquired');
  expect(container.textContent).toContain(time(5));
  expect(container.textContent).not.toContain('Review sell of acquired tokens');
});

it('times out a stalled read, allows retry and withholds a late timed-out response', async () => {
  vi.useFakeTimers();
  await click('Open session');
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(requests[0].init.signal?.aborted).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'timed out',
  );
  expect(button('Reload session').disabled).toBe(false);
  await click('Reload session');
  await respond(0, mixed());
  expect(row(3).textContent).not.toContain('Matching finalized');
  await respond(1, mixed());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(row(3).textContent).toContain('Matching finalized');
});

it('aborts an in-flight read on unmount', async () => {
  await click('Open session');
  await act(async () => root.unmount());
  expect(requests[0].init.signal?.aborted).toBe(true);
  await respond(0, mixed());
  expect(container.textContent).toBe('');
  root = createRoot(container);
});

async function renderHistory(
  selectedProject = project(),
  reference: { eventId?: string; sessionId?: string } = { eventId },
) {
  await act(async () =>
    root.render(
      <SessionHistoryOutcomes
        project={selectedProject}
        {...reference}
        onReviewBuy={reviewBuy}
      />,
    ),
  );
}

it('resolves an owned historical event with one demand read and shows current cancellation without rewriting its captured row', async () => {
  await renderHistory();
  expect(requests).toHaveLength(0);
  await click('Open current');
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0].url, 'http://test');
  expect(url.searchParams.get('projectId')).toBe(id(1));
  expect(url.searchParams.get('eventId')).toBe(eventId);
  expect(url.searchParams.has('sessionId')).toBe(false);
  expect(requests[0].init.method).toBe('GET');
  const p = mixed();
  p.sourceEventId = eventId;
  p.session = {
    ...p.session,
    state: 'cancelled',
    revision: 2,
    updatedAt: time(3),
  };
  await respond(0, p);
  expect(requests).toHaveLength(1);
  expect(container.querySelectorAll('ol > li')).toHaveLength(6);
  expect(container.textContent).toContain('Saved session state: cancelled');
  expect(container.textContent).toContain(
    'original historical row remains its captured event',
  );
  expect(container.textContent).toContain(time(4));
  expect(container.textContent).not.toContain('Review saved approval');
  expect(row(3).textContent).toContain('Matching finalized Buy receipt');
  await click('Review sell of acquired tokens for entry 3');
  expect(reviewBuy).toHaveBeenCalledExactlyOnceWith(p.entries[2].receipt);
  expect(recover).not.toHaveBeenCalled();
});

it.each(['event', 'missing-event', 'project'] as const)(
  'withholds a history wrapper response with mismatched %s scope',
  async (mismatch) => {
    await renderHistory();
    await click('Open current');
    const p = mixed(mismatch === 'project' ? session(id(9)) : saved);
    if (mismatch !== 'missing-event')
      p.sourceEventId = mismatch === 'event' ? 'b'.repeat(32) : eventId;
    await respond(0, p);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('ol')).toBeNull();
    expect(container.textContent).not.toContain(signature);
    expect(container.textContent).not.toContain(
      'Review sell of acquired tokens',
    );
    expect(reviewBuy).not.toHaveBeenCalled();
  },
);

it('binds a session UUID reference and rejects a different returned session before rendering outcomes', async () => {
  await renderHistory(project(), { sessionId: saved.id });
  await click('Open current');
  const url = new URL(requests[0].url, 'http://test');
  expect(url.searchParams.get('sessionId')).toBe(saved.id);
  expect(url.searchParams.has('eventId')).toBe(false);
  const wrong = mixed();
  wrong.session.id = id(998);
  await respond(0, wrong);
  expect(container.querySelector('ol')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'reference differs',
  );
  await click('Reload session');
  await respond(1, mixed());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelectorAll('ol > li')).toHaveLength(6);
  expect(container.textContent).not.toContain('Review saved approval');
});

it('disables matching Buy receipt review for an archived project without discarding retained evidence', async () => {
  await renderHistory();
  await click('Open current');
  const p = mixed();
  p.sourceEventId = eventId;
  await respond(0, p);
  await renderHistory(project(id(1), true));
  expect(requests).toHaveLength(1);
  expect(row(3).textContent).toContain('Matching finalized Buy receipt');
  expect(button('Review sell of acquired tokens for entry 3').disabled).toBe(
    true,
  );
  await click('Review sell of acquired tokens for entry 3');
  expect(reviewBuy).not.toHaveBeenCalled();
  await renderHistory(project());
  expect(button('Review sell of acquired tokens for entry 3').disabled).toBe(
    false,
  );
  await click('Review sell of acquired tokens for entry 3');
  expect(reviewBuy).toHaveBeenCalledExactlyOnceWith(p.entries[2].receipt);
});

it.each([
  {},
  { eventId, sessionId: id(2) },
  { eventId: 'A'.repeat(32) },
  { sessionId: 'not-a-uuid' },
])(
  'rejects invalid or ambiguous history references before fetching: %j',
  async (reference) => {
    await renderHistory(project(), reference);
    expect(button('Open current').disabled).toBe(true);
    await click('Open current');
    expect(requests).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'exactly one valid',
    );
  },
);

it('aborts obsolete historical event reads, ignores their late data and stops the current read on close', async () => {
  await renderHistory();
  await click('Open current');
  const nextEvent = 'b'.repeat(32);
  await renderHistory(project(), { eventId: nextEvent });
  expect(requests[0].init.signal?.aborted).toBe(true);
  expect(requests).toHaveLength(2);
  const late = mixed();
  late.sourceEventId = eventId;
  await respond(0, late);
  expect(container.querySelector('ol')).toBeNull();
  expect(
    new URL(requests[1].url, 'http://test').searchParams.get('eventId'),
  ).toBe(nextEvent);
  await click('Close current');
  expect(requests[1].init.signal?.aborted).toBe(true);
  const current = mixed();
  current.sourceEventId = nextEvent;
  await respond(1, current);
  expect(container.querySelector('ol')).toBeNull();
  await click('Open current');
  expect(requests).toHaveLength(3);
  await respond(2, current);
  expect(container.querySelectorAll('ol > li')).toHaveLength(6);
});
