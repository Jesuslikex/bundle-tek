import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { warmupJournalClientFixture } from '@/test/warmup-session-journal-client-fixture';
import { warmupSessionConsentFixture } from '@/test/warmup-session-consent-fixture';
import { installWarmupSessionFinishGuards } from '@/test/warmup-session-finish-guard-fixture';
import { retainWalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import {
  retainWalletWarmupSessionJournal,
  appendWalletWarmupSessionJournal,
} from './wallet-warmup-session-journal-storage';
import { publicWalletWarmupSessionJournal as project } from './wallet-warmup-session-journal-public';
import { warmupConsentSaved } from './wallet-warmup-session-consent-view';
import {
  warmupJournalContext,
  warmupJournalView,
  warmupJournalRequest,
  warmupJournalRequestBody,
  readWarmupJournalResponse,
} from './wallet-warmup-session-journal-view';
afterEach(() => vi.unstubAllGlobals());
it('admits an exact historical non-authorizing snapshot and a cryptographically bound control receipt', async () => {
  const f = await warmupJournalClientFixture(),
    j = f.root(),
    request = f.request(j);
  expect(await warmupJournalView({ journal: j }, f.context)).toEqual(j);
  const paused = await f.apply(
    j,
    request as Extract<typeof request, { kind: 'control' }>,
  );
  expect(
    await warmupJournalView({ journal: paused }, f.context, {
      id: j.id,
      request,
      requireReceipt: true,
    }),
  ).toEqual(paused);
});
it.each([
  'owner-context',
  'terms',
  'plan',
  'revision',
  'finish',
  'effective',
  'source-expiry',
  'capability',
  'extra',
  'wallet',
  'duplicate-wallet',
  'reserve',
  'buy-budget',
  'count',
  'recovery-flag',
  'phase',
] as const)(
  'refuses changed %s metadata instead of showing another approval or fabricated progress',
  async (kind) => {
    const f = await warmupJournalClientFixture(),
      j = f.root();
    if (kind === 'owner-context') j.consentId = crypto.randomUUID();
    if (kind === 'terms') j.termsSha256 = 'f'.repeat(64);
    if (kind === 'plan') j.snapshot.planId = 'other-plan';
    if (kind === 'revision') j.snapshot.planRevision++;
    if (kind === 'finish')
      j.sessionExpiresAt = new Date(
        Date.parse(j.sessionExpiresAt) + 1000,
      ).toISOString();
    if (kind === 'effective') j.effectiveReviewExpiresAt = j.sessionExpiresAt;
    if (kind === 'source-expiry')
      j.snapshot.sourceReviewExpiresAt = j.sessionExpiresAt;
    if (kind === 'capability') Object.assign(j, { signingAllowed: true });
    if (kind === 'extra') Object.assign(j, { sourceDocument: 'private' });
    if (kind === 'wallet')
      j.snapshot.wallets[0].wallet = '11111111111111111111111111111111';
    if (kind === 'duplicate-wallet')
      j.snapshot.wallets.push(structuredClone(j.snapshot.wallets[0]));
    if (kind === 'reserve')
      j.snapshot.wallets[0].remainingReserveLamports = '0';
    if (kind === 'buy-budget')
      j.snapshot.wallets[0].recordedFurtherBuySpendLamports = '99999999999';
    if (kind === 'count') j.snapshot.completedActions = 1;
    if (kind === 'recovery-flag') j.recoveryRequired = true;
    if (kind === 'phase') j.snapshot.phase = 'complete';
    await expect(warmupJournalView({ journal: j }, f.context)).rejects.toThrow(
      'Saved session status',
    );
  },
);
it('binds a pending action to the approved wallet, side, mint, cycle, revision and schedule', async () => {
  const f = await warmupJournalClientFixture(),
    j = f.root(),
    original = f.context.actions[0];
  j.version = 1;
  j.recoveryRequired = true;
  j.snapshot.phase = 'in-flight';
  j.snapshot.pending = {
    state: 'reviewing',
    action: {
      id: original.id,
      side: original.side,
      cycle: original.cycle,
      wallet: original.wallet,
      walletRevision: original.walletRevision,
      mint: original.mint,
      scheduledAt: original.scheduledAt,
    },
  };
  expect(
    (await warmupJournalView({ journal: j }, f.context)).snapshot.pending,
  ).not.toBeNull();
  j.snapshot.pending.action.cycle++;
  await expect(warmupJournalView({ journal: j }, f.context)).rejects.toThrow();
});
it.each([
  'id',
  'operation',
  'version',
  'hash',
  'predecessor',
  'unexpected',
] as const)('refuses a %s control receipt mismatch', async (kind) => {
  const f = await warmupJournalClientFixture(),
    j = f.root(),
    request = f.request(j) as Extract<
      ReturnType<typeof f.request>,
      { kind: 'control' }
    >,
    next = await f.apply(j, request);
  if (kind === 'id') next.commandReceipt!.id = crypto.randomUUID();
  if (kind === 'operation') next.commandReceipt!.operation = 'stop';
  if (kind === 'version') next.commandReceipt!.version++;
  if (kind === 'hash') {
    next.headSha256 = 'b'.repeat(64);
    next.commandReceipt!.headSha256 = next.headSha256;
  }
  if (kind === 'predecessor') request.expectedHeadSha256 = 'b'.repeat(64);
  await expect(
    warmupJournalView(
      { journal: next },
      f.context,
      kind === 'unexpected' ? {} : { request, requireReceipt: true },
    ),
  ).rejects.toThrow();
});
it('allows an unconfirmed GET receipt but never treats it as a successful control POST', async () => {
  const f = await warmupJournalClientFixture(),
    j = f.root(),
    request = f.request(j);
  expect(
    (await warmupJournalView({ journal: j }, f.context, { request }))
      .commandReceipt,
  ).toBeNull();
  await expect(
    warmupJournalView({ journal: j }, f.context, {
      request,
      requireReceipt: true,
    }),
  ).rejects.toThrow();
});
it('refuses a regressed version, replaced head or reopened stopped state', async () => {
  const f = await warmupJournalClientFixture(),
    j = f.root(),
    request = f.request(j, 'stop') as Extract<
      ReturnType<typeof f.request>,
      { kind: 'control' }
    >,
    stopped = await f.apply(j, request);
  const plain = { ...stopped, commandReceipt: null };
  await expect(
    warmupJournalView({ journal: j }, f.context, { previous: plain }),
  ).rejects.toThrow();
  const replaced = { ...plain, headSha256: 'f'.repeat(64) };
  await expect(
    warmupJournalView({ journal: replaced }, f.context, { previous: plain }),
  ).rejects.toThrow();
  const reopened = structuredClone(plain);
  reopened.version++;
  reopened.snapshot.stopped = false;
  reopened.snapshot.phase = 'review-required';
  await expect(
    warmupJournalView({ journal: reopened }, f.context, { previous: plain }),
  ).rejects.toThrow();
});
it('bounds and binds local reminders and emits only the permitted history request body', async () => {
  const f = await warmupJournalClientFixture(),
    request = f.request(f.root());
  expect(warmupJournalRequest(request, f.context)).toEqual(request);
  expect(warmupJournalRequestBody(request)).toMatchObject({
    operation: 'control',
    control: 'pause',
  });
  for (const changed of [
    { ...request, termsSha256: 'a'.repeat(64) },
    { ...request, control: 'submitted' },
    { ...request, owner: 'other' },
    { ...request, extra: 'x'.repeat(3000) },
  ])
    expect(() => warmupJournalRequest(changed, f.context)).toThrow();
});
it('refuses HTML, malformed JSON, oversized streams and cancelled reads with a fixed error', async () => {
  const signal = new AbortController().signal;
  for (const response of [
    new Response('<html>PRIVATE_PROVIDER_DETAIL'),
    new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(65537), {
      headers: { 'content-type': 'application/json' },
    }),
  ])
    await expect(readWarmupJournalResponse(response, signal)).rejects.toThrow(
      'Saved session status',
    );
  const abort = new AbortController();
  abort.abort();
  await expect(
    readWarmupJournalResponse(Response.json({}), abort.signal),
  ).rejects.toThrow();
});
it('composes the actual owned SQL journal and control projection with client admission', async () => {
  const f = await warmupSessionConsentFixture();
  try {
    for (const name of [
      '0124_wallet_warmup_session_journals',
      '0125_wallet_warmup_session_settlements',
    ])
      for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await f.db.prepare(sql).run();
    await installWarmupSessionFinishGuards(f.db);
    const signal = new AbortController().signal;
    const saved = await retainWalletWarmupSessionConsent(
      f.db,
      'owner',
      f.input,
      true,
      signal,
    );
    const consent = await warmupConsentSaved(
      { consent: { ...saved, reviewCreatedAt: f.retainedReview.createdAt } },
      { id: saved.id, planId: f.plan.id },
    );
    const context = warmupJournalContext(consent);
    const journal = await retainWalletWarmupSessionJournal(
      f.db,
      'owner',
      {
        id: crypto.randomUUID(),
        consentId: saved.id,
        termsSha256: saved.termsSha256,
      },
      true,
      signal,
    );
    const dto = await warmupJournalView({ journal: project(journal) }, context);
    const request = warmupJournalRequest(
      {
        format: 'warmup-journal-request-v1',
        kind: 'control',
        id: crypto.randomUUID(),
        consentId: saved.id,
        termsSha256: saved.termsSha256,
        journalId: dto.id,
        control: 'pause',
        expectedVersion: dto.version,
        expectedHeadSha256: dto.headSha256,
      },
      context,
    );
    if (request.kind !== 'control') throw Error('Wrong fixture request');
    const paused = await appendWalletWarmupSessionJournal(
      f.db,
      'owner',
      {
        id: request.id,
        journalId: dto.id,
        expectedVersion: request.expectedVersion,
        expectedHeadSha256: request.expectedHeadSha256,
        command: { operation: request.control },
      },
      signal,
    );
    expect(
      (
        await warmupJournalView(
          { journal: project(paused, request.id) },
          context,
          { request, requireReceipt: true },
        )
      ).snapshot.paused,
    ).toBe(true);
  } finally {
    f.client.close();
  }
});
