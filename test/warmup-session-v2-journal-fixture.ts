import { readFileSync } from 'node:fs';
import { warmupSessionV2ConsentFixture } from './warmup-session-v2-consent-fixture';
import { retainWalletWarmupV2Consent } from '@/lib/wallet-warmup-session-v2-consent';
import {
  retainWalletWarmupV2Journal,
  appendWalletWarmupV2Journal,
} from '@/lib/wallet-warmup-session-v2-journal';
import { loadWalletWarmupProgress } from '@/lib/wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from '@/lib/wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from '@/lib/wallet-warmup-session-storage';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
import { reviewWalletWarmupV2Consent } from '@/lib/wallet-warmup-session-v2-consent';
import {
  retainWalletWarmupSessionConsent,
  reviewWalletWarmupSessionConsent,
} from '@/lib/wallet-warmup-session-consent';
import { retainWalletWarmupSessionJournal } from '@/lib/wallet-warmup-session-journal-storage';
export const v2JournalSignal = () => new AbortController().signal;
async function peerSelection(f: {
  db: D1Database;
  plan: { id: string; document: unknown; updatedAt: string };
}) {
  const planId = 'peer-' + crypto.randomUUID();
  await f.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'owner',
      planId,
      1,
      0,
      f.plan.updatedAt,
      JSON.stringify(f.plan.document),
    )
    .run();
  const current = await loadWalletWarmupProgress(
    f.db,
    'owner',
    planId,
    1,
    false,
    true,
  );
  const preview = reviewWalletWarmupSession(
    current.plan,
    current.progress,
    current.performance,
    Date.now(),
  );
  const review = await retainWalletWarmupSessionReview(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      planId,
      revision: 1,
      reviewedAt: preview.reviewedAt,
      reviewSha256: await digest(preview.contextKey),
    },
    true,
    v2JournalSignal(),
  );
  const selection = {
    reviewId: review.id,
    reviewSha256: review.reviewSha256,
    sessionExpiresAt: new Date(
      Date.parse(review.document.reviewedAt) + 120000,
    ).toISOString(),
  };
  return selection;
}
export async function anotherLegacyJournal(
  f: Parameters<typeof peerSelection>[0],
) {
  const selection = await peerSelection(f),
    terms = await reviewWalletWarmupSessionConsent(
      f.db,
      'owner',
      selection,
      v2JournalSignal(),
    );
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    { ...selection, id: crypto.randomUUID(), termsSha256: terms.termsSha256 },
    true,
    v2JournalSignal(),
  );
  return retainWalletWarmupSessionJournal(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
    },
    true,
    v2JournalSignal(),
  );
}
export async function anotherV2Journal(f: Parameters<typeof peerSelection>[0]) {
  const selection = await peerSelection(f);
  const terms = await reviewWalletWarmupV2Consent(
    f.db,
    'owner',
    selection,
    v2JournalSignal(),
  );
  const consent = await retainWalletWarmupV2Consent(
    f.db,
    'owner',
    { ...selection, id: crypto.randomUUID(), termsSha256: terms.termsSha256 },
    true,
    v2JournalSignal(),
  );
  return retainWalletWarmupV2Journal(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
    },
    true,
    v2JournalSignal(),
  );
}
/** Disposable native SQL, synthetic public wallet only. No provider or signed bytes. */
export async function warmupSessionV2JournalFixture(
  seed?: (
    db: D1Database,
    client: Awaited<ReturnType<typeof warmupSessionV2ConsentFixture>>['client'],
    consent: Awaited<ReturnType<typeof retainWalletWarmupV2Consent>>,
  ) => Promise<void>,
) {
  const f = await warmupSessionV2ConsentFixture();
  try {
    const consent = await retainWalletWarmupV2Consent(
      f.db,
      'owner',
      f.v2Input,
      true,
      v2JournalSignal(),
    );
    for (const name of [
      '0042_warmup_swap_preparations',
      '0045_warmup_signing_intents',
      '0124_wallet_warmup_session_journals',
      '0125_wallet_warmup_session_settlements',
      '0126_wallet_warmup_session_action_bindings',
      '0127_wallet_warmup_action_binding_freshness',
      '0128_wallet_warmup_session_preparations',
      '0129_wallet_warmup_session_packets',
      '0130_wallet_warmup_session_packet_freshness',
      '0131_wallet_warmup_session_finish_guards',
      '0133_wallet_warmup_session_v2_journals',
    ])
      for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (
          name === '0133_wallet_warmup_session_v2_journals' &&
          sql.startsWith(
            'CREATE TRIGGER wallet_warmup_session_journals_v2_insert',
          ) &&
          seed
        )
          await seed(f.db, f.client, consent);
        await f.db.prepare(sql).run();
      }
    const input = {
      id:
        (
          await f.db
            .prepare(
              'SELECT id FROM wallet_warmup_session_journals_v2 WHERE owner_id=? AND consent_id=?',
            )
            .bind('owner', consent.id)
            .first<{ id: string }>()
        )?.id ?? crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
    };
    let journal = await retainWalletWarmupV2Journal(
      f.db,
      'owner',
      input,
      true,
      v2JournalSignal(),
    );
    return {
      ...f,
      consent,
      rootInput: input,
      get journal() {
        return journal;
      },
      async append(control: 'begin-review' | 'pause' | 'resume' | 'stop') {
        const input = {
          id: crypto.randomUUID(),
          journalId: journal.id,
          version: journal.version,
          headSha256: journal.headSha256,
          control,
        };
        journal = await appendWalletWarmupV2Journal(
          f.db,
          'owner',
          input,
          v2JournalSignal(),
        );
        return { input, journal };
      },
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
