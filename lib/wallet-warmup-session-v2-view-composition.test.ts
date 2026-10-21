import { it, expect } from 'vitest';
import {
  warmupSessionV2JournalFixture,
  v2JournalSignal,
} from '@/test/warmup-session-v2-journal-fixture';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { walletWarmupSessionView } from './wallet-warmup-session-view';
import { walletWarmupSessionRetainedView } from './wallet-warmup-session-retained-view';
import { publicWalletWarmupV2Consent } from './wallet-warmup-session-v2-public';
import {
  warmupV2Preview,
  warmupV2Saved,
  warmupV2Journal,
} from './wallet-warmup-session-v2-view';
import {
  publicWalletWarmupV2Journal,
  readWalletWarmupV2Journal,
  appendWalletWarmupV2Journal,
} from './wallet-warmup-session-v2-journal';
import { warmupV2AbsentControl } from './wallet-warmup-session-v2-view';
it('admits actual native SQL v2 consent and journal DTOs through complete source, policy and event binding', async () => {
  const f = await warmupSessionV2JournalFixture();
  try {
    const progress = await loadWalletWarmupProgress(
      f.db,
      'owner',
      f.plan.id,
      1,
      false,
      true,
    );
    const review = reviewWalletWarmupSession(
      progress.plan,
      progress.progress,
      progress.performance,
      Date.parse(f.retainedReview.reviewedAt),
    );
    const view = walletWarmupSessionView(
      { review, reviewExpiresAt: f.retainedReview.reviewExpiresAt },
      f.plan,
    );
    const retained = await walletWarmupSessionRetainedView(
      { retainedReview: f.retainedReview },
      { id: f.retainedReview.id, planId: f.plan.id },
      view.review,
    );
    const terms = await warmupV2Preview(
      {
        consentReview: await publicWalletWarmupV2Consent(
          f.db,
          'owner',
          f.v2Prepared,
          v2JournalSignal(),
        ),
      },
      f.plan,
      view,
      retained,
      f.consent.terms.sessionExpiresAt,
    );
    const consent = await warmupV2Saved(
      {
        consent: await publicWalletWarmupV2Consent(
          f.db,
          'owner',
          f.consent,
          v2JournalSignal(),
        ),
      },
      { id: f.consent.id, planId: f.plan.id, termsSha256: terms.termsSha256 },
    );
    const first = await warmupV2Journal(
      { journal: publicWalletWarmupV2Journal(f.journal) },
      consent,
      { id: f.journal.id },
    );
    const { input, journal } = await f.append('begin-review');
    const next = await warmupV2Journal(
      { journal: publicWalletWarmupV2Journal(journal, input.id) },
      consent,
      { id: first.id, previous: first, request: { kind: 'control', ...input } },
    );
    expect(next.snapshot.phase).toBe('reviewing');
    expect(next.qualificationAvailable).toBe(false);
    expect(
      await readWalletWarmupV2Journal(
        f.db,
        'owner',
        next.id,
        v2JournalSignal(),
      ),
    ).not.toBeNull();
  } finally {
    f.client.close();
  }
});
it.each(['original-first', 'stop-first'] as const)(
  'uses real SQL CAS so pending Stop and the original control cannot both commit: %s',
  async (ordering) => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const consent = await warmupV2Saved(
        {
          consent: await publicWalletWarmupV2Consent(
            f.db,
            'owner',
            f.consent,
            v2JournalSignal(),
          ),
        },
        { id: f.consent.id, planId: f.plan.id },
      );
      const original = {
        id: crypto.randomUUID(),
        journalId: f.journal.id,
        version: 0,
        headSha256: f.journal.headSha256,
        control: 'begin-review' as const,
      };
      const stop = {
        ...original,
        id: crypto.randomUUID(),
        control: 'stop' as const,
      };
      const first = ordering === 'original-first' ? original : stop,
        second = ordering === 'original-first' ? stop : original;
      const winner = await appendWalletWarmupV2Journal(
        f.db,
        'owner',
        first,
        v2JournalSignal(),
      );
      await expect(
        appendWalletWarmupV2Journal(f.db, 'owner', second, v2JournalSignal()),
      ).rejects.toThrow();
      const checked = await warmupV2Journal(
        { journal: publicWalletWarmupV2Journal(winner, first.id) },
        consent,
        { id: winner.id, request: { kind: 'control', ...first } },
      );
      expect(checked.version).toBe(1);
      if (ordering === 'original-first') {
        const recovered = await warmupV2AbsentControl(
          { journal: publicWalletWarmupV2Journal(winner, stop.id) },
          consent,
          { kind: 'control', ...stop },
        );
        expect(recovered.snapshot.phase).toBe('reviewing');
      } else expect(checked.snapshot.stopped).toBe(true);
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_journal_events_v2',
          )
          .first(),
      ).toEqual({ n: 1 });
    } finally {
      f.client.close();
    }
  },
);
it('publishes no parent timestamp for a foreign owner or changed source hash', async () => {
  const f = await warmupSessionV2JournalFixture();
  try {
    await expect(
      publicWalletWarmupV2Consent(
        f.db,
        'foreign',
        f.consent,
        v2JournalSignal(),
      ),
    ).rejects.toThrow('source review changed');
    await expect(
      publicWalletWarmupV2Consent(
        f.db,
        'owner',
        {
          ...f.consent,
          terms: { ...f.consent.terms, reviewSha256: '0'.repeat(64) },
        },
        v2JournalSignal(),
      ),
    ).rejects.toThrow('source review changed');
  } finally {
    f.client.close();
  }
});
it('lets both contenders reach INSERT with the same observed head and commits only one under real SQL guards', async () => {
  const f = await warmupSessionV2JournalFixture();
  try {
    let arrivals = 0,
      release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = {
      batch: f.db.batch.bind(f.db),
      prepare(sql: string) {
        const original = f.db.prepare(sql);
        if (
          !sql.startsWith('INSERT INTO wallet_warmup_session_journal_events_v2')
        )
          return original;
        return {
          bind(...args: unknown[]) {
            const bound = original.bind(...args);
            return {
              async run() {
                arrivals++;
                if (arrivals === 2) release();
                await gate;
                return bound.run();
              },
            };
          },
        };
      },
    } as D1Database;
    const input = {
      journalId: f.journal.id,
      version: 0,
      headSha256: f.journal.headSha256,
    };
    const results = await Promise.allSettled([
      appendWalletWarmupV2Journal(
        db,
        'owner',
        { ...input, id: crypto.randomUUID(), control: 'begin-review' },
        v2JournalSignal(),
      ),
      appendWalletWarmupV2Journal(
        db,
        'owner',
        { ...input, id: crypto.randomUUID(), control: 'stop' },
        v2JournalSignal(),
      ),
    ]);
    expect(arrivals).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await f.db
        .prepare(
          'SELECT count(*) AS n FROM wallet_warmup_session_journal_events_v2',
        )
        .first(),
    ).toEqual({ n: 1 });
    expect(
      (
        await readWalletWarmupV2Journal(
          f.db,
          'owner',
          f.journal.id,
          v2JournalSignal(),
        )
      )?.version,
    ).toBe(1);
  } finally {
    f.client.close();
  }
});
