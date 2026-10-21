import { readFileSync } from 'node:fs';
import { warmupSessionProviderFixture } from './warmup-session-provider-fixture';
import { anotherV2Journal } from './warmup-session-v2-journal-fixture';
import { appendWalletWarmupV2Journal } from '@/lib/wallet-warmup-session-v2-journal';
export async function warmupV2AttemptProviderFixture(reserve = '0.01') {
  const f = await warmupSessionProviderFixture(reserve);
  try {
    await f.append('stop');
    for (const name of [
      '0132_wallet_warmup_session_v2_consents',
      '0133_wallet_warmup_session_v2_journals',
      '0134_wallet_warmup_session_v2_attempts',
    ])
      for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await f.db.prepare(sql).run();
    let journal = await anotherV2Journal(f);
    async function control(
      control: 'begin-review' | 'pause' | 'resume' | 'stop',
    ) {
      journal = await appendWalletWarmupV2Journal(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId: journal.id,
          version: journal.version,
          headSha256: journal.headSha256,
          control,
        },
        new AbortController().signal,
      );
      return journal;
    }
    await control('begin-review');
    return {
      ...f,
      get v2Journal() {
        return journal;
      },
      control,
      input: () => ({
        id: crypto.randomUUID(),
        journalId: journal.id,
        version: journal.version,
        headSha256: journal.headSha256,
        previewRequested: true,
      }),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
/** Synthetic saved-buy read-model capture; never a funded receipt. */
export async function warmupV2SavedBuyAttemptProviderFixture(
  nullRemaining = false,
) {
  const f = await warmupV2AttemptProviderFixture();
  try {
    await f.control('stop');
    const planId = f.v2Journal.manifest.planId;
    await f.db
      .prepare(
        'INSERT INTO warmup_buy_receipts(owner_id,plan_id,id,plan_revision,wallet_revision,cycle,wallet_address,signature,remaining_raw,document,preparation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        planId,
        f.packets.buy.receiptId,
        1,
        1,
        1,
        f.packets.wallet,
        f.packets.buy.signature,
        '101',
        JSON.stringify(f.packets.buyDocument),
        f.packets.buy.preparation.id,
        new Date().toISOString(),
      )
      .run();
    const { loadWalletWarmupProgress } =
      await import('@/lib/wallet-warmup-progress-server');
    const { reviewWalletWarmupSession } =
      await import('@/lib/wallet-warmup-session-review');
    const { retainWalletWarmupSessionReview } =
      await import('@/lib/wallet-warmup-session-storage');
    const { walletWarmupSessionDigest } =
      await import('@/lib/wallet-warmup-session-digest');
    const { reviewWalletWarmupV2Consent, retainWalletWarmupV2Consent } =
      await import('@/lib/wallet-warmup-session-v2-consent');
    const { retainWalletWarmupV2Journal } =
      await import('@/lib/wallet-warmup-session-v2-journal');
    const signal = new AbortController().signal;
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
        reviewSha256: await walletWarmupSessionDigest(preview.contextKey),
      },
      true,
      signal,
    );
    const selection = {
      reviewId: review.id,
      reviewSha256: review.reviewSha256,
      sessionExpiresAt: new Date(
        Date.parse(review.document.reviewedAt) + 120000,
      ).toISOString(),
    };
    const terms = await reviewWalletWarmupV2Consent(
      f.db,
      'owner',
      selection,
      signal,
    );
    const consent = await retainWalletWarmupV2Consent(
      f.db,
      'owner',
      { ...selection, id: crypto.randomUUID(), termsSha256: terms.termsSha256 },
      true,
      signal,
    );
    let journal = await retainWalletWarmupV2Journal(
      f.db,
      'owner',
      {
        id: crypto.randomUUID(),
        consentId: consent.id,
        termsSha256: consent.termsSha256,
      },
      true,
      signal,
    );
    const action = journal.manifest.actions[0];
    if (action.side !== 'Sell' || action.source.kind !== 'saved-buy')
      throw Error('Synthetic saved-buy Sell required');
    const wait = Math.max(0, Date.parse(action.scheduledAt) - Date.now() + 25);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    journal = await appendWalletWarmupV2Journal(
      f.db,
      'owner',
      {
        id: crypto.randomUUID(),
        journalId: journal.id,
        version: journal.version,
        headSha256: journal.headSha256,
        control: 'begin-review',
      },
      signal,
    );
    if (nullRemaining)
      await f.db
        .prepare(
          'UPDATE warmup_buy_receipts SET remaining_raw=NULL WHERE plan_id=?',
        )
        .bind(planId)
        .run();
    return {
      ...f,
      v2Journal: journal,
      input: () => ({
        id: crypto.randomUUID(),
        journalId: journal.id,
        version: journal.version,
        headSha256: journal.headSha256,
        previewRequested: true,
      }),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
