import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warmupSessionProviderFixture } from '@/test/warmup-session-provider-fixture';
import { prepareWalletWarmupSessionAction } from '@/lib/wallet-warmup-session-preparation';
import { createWalletWarmupSessionProvider } from '@/lib/wallet-warmup-session-provider';
import { prepareSolanaSwap } from '@/lib/warmup-swap-quote';
import { readWalletWarmupSessionConsent } from '@/lib/wallet-warmup-session-consent';
import { warmupConsentSaved } from '@/lib/wallet-warmup-session-consent-view';
import {
  warmupJournalContext,
  warmupJournalView,
} from '@/lib/wallet-warmup-session-journal-view';
import { publicWalletWarmupSessionJournal } from '@/lib/wallet-warmup-session-journal-public';
import { warmupPreparationRecoveryView } from '@/lib/wallet-warmup-session-preparation-recovery-view';
import { warmupPreparationRequestBody } from '@/lib/wallet-warmup-session-preparation-request';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
  getDb: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    mocks.getDb();
    return mocks.db;
  },
}));
import { GET } from './route';
import type { readWalletWarmupSessionPreparationRecovery } from '@/lib/wallet-warmup-session-preparation-recovery';
type Recovery = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupSessionPreparationRecovery>>
>;
let f: Awaited<ReturnType<typeof warmupSessionProviderFixture>>,
  selection: {
    id: string;
    journalId: string;
    version: number;
    headSha256: string;
  };
let statements: string[];
const url =
  'http://localhost/api/wallet-workspace/warmup/session-preparations/recovery';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  f = await warmupSessionProviderFixture();
  const { id, journalId, version, headSha256 } = f.input();
  selection = { id, journalId, version, headSha256 };
  await prepareWalletWarmupSessionAction(
    f.db,
    'owner',
    selection,
    new AbortController().signal,
    createWalletWarmupSessionProvider(f.db, 'owner', 'synthetic-key', {
      quote: (input, key, signal) =>
        prepareSolanaSwap(input, key, signal, async (inputUrl) =>
          Response.json(
            f.quote(
              new URL(
                typeof inputUrl === 'string'
                  ? inputUrl
                  : inputUrl instanceof URL
                    ? inputUrl.href
                    : inputUrl.url,
              ),
            ),
          ),
        ),
      simulate: async (order) => f.simulation(order),
      now: f.clock,
    }),
    f.clock,
  );
  statements = [];
  mocks.user = { userId: 'owner' };
  mocks.getDb.mockClear();
  mocks.db = {
    prepare: (sql: string) => {
      statements.push(sql);
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      return f.db.prepare(sql);
    },
  } as unknown as D1Database;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Recovery must not call a provider');
    }),
  );
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const get = (suffix = '?id=' + selection.id, signal?: AbortSignal) =>
  GET(new Request(url + suffix, { signal }));
it('verifies the complete journal once during current-action discovery', async () => {
  const response = await get('?journalId=' + selection.journalId);
  expect(response.status).toBe(200);
  expect(
    statements.filter((sql) => sql.includes('SELECT j.*,h.version')),
  ).toHaveLength(1);
  const { recovery } = (await response.json()) as { recovery: Recovery };
  expect(recovery.originalJournal.headSha256).toBe(selection.headSha256);
  expect(recovery.currentJournal.snapshot.pending?.action.id).toBe(
    recovery.originalJournal.snapshot.pending?.action.id,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('returns only whitelisted original/current views from read-only SQL, without packet bytes or provider calls', async () => {
  const before = await f.count(),
    response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as { recovery: Recovery };
  expect(Object.keys(value)).toEqual(['recovery']);
  expect(Object.keys(value.recovery).sort()).toEqual([
    'currentJournal',
    'originalJournal',
    'preparation',
    'readOnly',
  ]);
  expect(value.recovery).toMatchObject({
    readOnly: true,
    originalJournal: {
      version: selection.version,
      headSha256: selection.headSha256,
    },
    preparation: {
      id: selection.id,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
      instructionsVerified: false,
    },
  });
  for (const j of [
    value.recovery.originalJournal,
    value.recovery.currentJournal,
  ]) {
    expect(j).not.toHaveProperty('events');
    expect(j).not.toHaveProperty('sourceDocument');
    expect(j).not.toHaveProperty('plan');
  }
  expect(JSON.stringify(value)).not.toContain(
    f.packets.buy.approval.transaction,
  );
  expect(JSON.stringify(value)).not.toContain('owner_id');
  expect(await f.count()).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
  expect(statements.length).toBeGreaterThan(1);
});
it('reconstructs the earlier reviewing prefix after Stop and expiry without renewing any deadline', async () => {
  await f.append('stop');
  f.advance(180000);
  vi.setSystemTime(f.clock());
  const response = await get();
  expect(response.status).toBe(200);
  const { recovery: r } = (await response.json()) as { recovery: Recovery };
  expect(r.currentJournal.snapshot.stopped).toBe(true);
  expect(r.currentJournal.version).toBeGreaterThan(r.originalJournal.version);
  expect(r.originalJournal.snapshot.stopped).toBe(false);
  expect(r.originalJournal.snapshot.pending?.state).toBe('reviewing');
  expect(r.originalJournal.snapshot.sourceReviewFresh).toBe(false);
  expect(r.originalJournal.headSha256).toBe(selection.headSha256);
  expect(r.originalJournal.effectiveReviewExpiresAt).toBe(
    r.currentJournal.effectiveReviewExpiresAt,
  );
  expect(Date.parse(r.originalJournal.effectiveReviewExpiresAt)).toBeLessThan(
    Date.now(),
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('finds the authenticated current action after expiry without knowing its preparation ID', async () => {
  await f.append('stop');
  f.advance(180000);
  vi.setSystemTime(f.clock());
  const response = await get('?journalId=' + selection.journalId);
  expect(response.status).toBe(200);
  const value = (await response.json()) as { recovery: Recovery };
  expect(value.recovery.preparation.id).toBe(selection.id);
  expect(value.recovery.originalJournal.headSha256).toBe(selection.headSha256);
  expect(value.recovery.currentJournal.snapshot.stopped).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses ambiguous ID/journal selection before database access', async () => {
  expect(
    (await get('?id=' + selection.id + '&journalId=' + selection.journalId))
      .status,
  ).toBe(400);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('cannot discover another owners journal or a missing journal', async () => {
  mocks.user = { userId: 'other' };
  const foreign = await get('?journalId=' + selection.journalId);
  expect(foreign.status).toBe(404);
  mocks.user = { userId: 'owner' };
  const missing = await get('?journalId=00000000-0000-4000-8000-000000000099');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual(await foreign.json());
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps archived and revised current plan/wallet state from destroying historical display recovery', async () => {
  await f.db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=revision+1')
    .run();
  await f.db
    .prepare('UPDATE workspace_wallets SET archived=1,revision=revision+1')
    .run();
  expect((await get()).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});
it('composes the real SQL recovery DTO with exact client admission and a permanently read-only reminder', async () => {
  const signal = new AbortController().signal,
    saved = await readWalletWarmupSessionConsent(
      f.db,
      'owner',
      f.rootInput.consentId,
      signal,
    );
  if (!saved) throw Error('Missing fixture consent');
  const consent = await warmupConsentSaved(
      { consent: { ...saved, reviewCreatedAt: f.retainedReview.createdAt } },
      { id: saved.id, planId: f.plan.id },
    ),
    context = warmupJournalContext(consent);
  const original = await warmupJournalView(
    { journal: publicWalletWarmupSessionJournal(f.journal) },
    context,
  );
  const value = await (await get()).json(),
    admitted = await warmupPreparationRecoveryView(
      value,
      { id: selection.id, journal: original },
      context,
    );
  expect(admitted.request.recovered).toBe(true);
  expect(admitted.preparation.packetAvailability).toBe('retained');
  expect(() => warmupPreparationRequestBody(admitted.request)).toThrow(
    'read-only',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('authenticates before database access', async () => {
  mocks.user = null;
  expect((await get()).status).toBe(401);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
for (const suffix of [
  '',
  '?id=bad',
  '?id=' + 'A'.repeat(36),
  '?id=00000000-0000-4000-8000-000000000001&id=00000000-0000-4000-8000-000000000002',
  '?id=00000000-0000-4000-8000-000000000001&version=1',
  '?other=1',
])
  it(`rejects invalid recovery selection ${suffix}`, async () => {
    expect((await get(suffix)).status).toBe(400);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
it('returns indistinguishable absence for foreign and missing IDs', async () => {
  mocks.user = { userId: 'other' };
  const foreign = await get(),
    a = await foreign.json();
  expect(foreign.status).toBe(404);
  mocks.user = { userId: 'owner' };
  const missing = await get('?id=00000000-0000-4000-8000-000000000099');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual(a);
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses a damaged later event instead of silently replaying only the apparently intact prefix', async () => {
  await f.append('pause');
  await f.append('resume');
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_journal_events_no_update')
    .run();
  await f.db
    .prepare(
      "UPDATE wallet_warmup_session_journal_events SET document='{}' WHERE version=3",
    )
    .run();
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('SQLITE');
  expect(fetch).not.toHaveBeenCalled();
});
it('handles cancellation before any DB read', async () => {
  const c = new AbortController();
  c.abort();
  expect((await get(undefined, c.signal)).status).toBe(408);
  expect(mocks.getDb).not.toHaveBeenCalled();
});
it('sanitizes a database HTML/error failure without returning a partial context', async () => {
  mocks.db = {
    prepare: () => {
      throw Error('<html>private database path</html>');
    },
  } as unknown as D1Database;
  const response = await get();
  expect(response.status).toBe(503);
  const value = await response.json();
  expect(value).not.toHaveProperty('recovery');
  expect(JSON.stringify(value)).not.toContain('private database path');
});
