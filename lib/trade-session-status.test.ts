import { expect, it } from 'vitest';
import {
  decodeTradeSessionStatus,
  requireCurrentSessionStatus,
} from './trade-session-status';
import { tradeSessionTerms } from './imported-trade-session';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
function fixture() {
  const date = '2026-10-11T12:00:00.000Z';
  const session = {
    id: id(2),
    revision: 1,
    state: 'active',
    terms: tradeSessionTerms(
      {
        projectId: id(1),
        projectRevision: 1,
        side: 'Buy',
        entries: [{ wallet, walletRevision: 1, amount: '0.001' }],
      },
      { chain: 'Solana', address: mint, decimals: 6 },
    ),
    createdAt: date,
    updatedAt: date,
  };
  return {
    projectId: id(1),
    executionAllowed: false,
    sessions: [session],
    controls: [
      {
        sessionId: id(2),
        projectId: id(1),
        state: 'ready',
        revision: 1,
        createdAt: date,
        updatedAt: date,
      },
    ],
    activity: [],
  };
}
it('validates a complete owner-project snapshot before committing any status', () => {
  const f = fixture();
  expect(decodeTradeSessionStatus(f, id(1)).sessions).toHaveLength(1);
  for (const value of [
    { ...f, projectId: id(3) },
    { ...f, executionAllowed: true },
    { ...f, sessions: [...f.sessions, ...f.sessions] },
    { ...f, controls: [] },
    { ...f, activity: [{ sessionId: id(3), entry: 1 }] },
  ])
    expect(() => decodeTradeSessionStatus(value, id(1))).toThrow();
});
it('accepts monotonic pause/resume and cancellation while rejecting stale or missing retained rows', () => {
  const f = fixture(),
    old = decodeTradeSessionStatus(f, id(1));
  const pause = decodeTradeSessionStatus(
    {
      ...f,
      controls: [
        {
          ...f.controls[0],
          state: 'paused',
          revision: 2,
          updatedAt: '2026-10-11T12:01:00.000Z',
        },
      ],
    },
    id(1),
  );
  expect(() =>
    requireCurrentSessionStatus(pause, old.sessions, old.controls),
  ).not.toThrow();
  expect(() =>
    requireCurrentSessionStatus(old, pause.sessions, pause.controls),
  ).toThrow();
  const cancelled = decodeTradeSessionStatus(
    {
      ...f,
      sessions: [
        {
          ...f.sessions[0],
          state: 'cancelled',
          revision: 2,
          updatedAt: '2026-10-11T12:02:00.000Z',
        },
      ],
    },
    id(1),
  );
  expect(() =>
    requireCurrentSessionStatus(cancelled, old.sessions, old.controls),
  ).not.toThrow();
  expect(() =>
    requireCurrentSessionStatus(
      { ...old, sessions: [], controls: [] },
      old.sessions,
      old.controls,
    ),
  ).toThrow();
});
it('rejects altered terms, same-revision states, identity dates and time regression', () => {
  const f = fixture(),
    old = decodeTradeSessionStatus(f, id(1));
  for (const change of [
    {
      sessions: [
        {
          ...old.sessions[0],
          terms: { ...old.sessions[0].terms, totalRaw: '999' },
        },
      ],
    },
    { sessions: [{ ...old.sessions[0], state: 'cancelled' as const }] },
    {
      controls: [{ ...old.controls[0], createdAt: '2026-10-11T11:00:00.000Z' }],
    },
  ])
    expect(() =>
      requireCurrentSessionStatus(
        { ...old, ...change },
        old.sessions,
        old.controls,
      ),
    ).toThrow();
  const newer = {
    ...old.controls[0],
    state: 'paused' as const,
    revision: 2,
    updatedAt: '2026-10-11T12:05:00.000Z',
  };
  expect(() =>
    requireCurrentSessionStatus(
      {
        ...old,
        controls: [
          {
            ...newer,
            state: 'ready',
            revision: 3,
            updatedAt: '2026-10-11T12:04:00.000Z',
          },
        ],
      },
      old.sessions,
      [newer],
    ),
  ).toThrow();
});

it('withholds approval status regressions and disappearance while accepting finalized receipt progress', () => {
  const old = decodeTradeSessionStatus(fixture(), id(1));
  const signed = {
    sessionId: id(2),
    entry: 1,
    intentId: id(4),
    state: 'signed',
    signature: '1'.repeat(88),
    receiptId: null,
  };
  const finalized = { ...signed, state: 'finalized', receiptId: id(5) };
  expect(() =>
    requireCurrentSessionStatus(
      { ...old, activity: [finalized] },
      old.sessions,
      old.controls,
      [signed],
    ),
  ).not.toThrow();
  for (const activity of [
    [],
    [signed],
    [{ ...finalized, signature: '2'.repeat(88) }],
    [{ ...finalized, state: 'failed', receiptId: null }],
  ])
    expect(() =>
      requireCurrentSessionStatus(
        { ...old, activity },
        old.sessions,
        old.controls,
        [finalized],
      ),
    ).toThrow();
});
