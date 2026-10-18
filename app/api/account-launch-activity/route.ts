import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  ACCOUNT_LAUNCH_ACTIVITY_LIMIT,
  validatedAccountLaunchActivity,
  type AccountLaunchActivityItem,
} from '@/lib/account-launch-activity';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

type Counts = {
  savedGroups: number;
  finalizedGroups: number;
  awaitingReview: number;
  finalizationEvidenceMissing: number;
};

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view saved launch activity.' }, 401);
  if (new URL(request.url).search)
    return json({ error: 'Unsupported launch activity query.' }, 400);

  try {
    const db = getD1();
    // Counts and the recent sample come from one owner-scoped D1 snapshot.
    const [counts, recent] = await db.batch([
      db
        .prepare(
          `SELECT COUNT(*) AS savedGroups,
            COALESCE(SUM(CASE WHEN r.state='finalized' AND c.state='finalized' THEN 1 ELSE 0 END),0) AS finalizedGroups,
            COALESCE(SUM(CASE WHEN r.state='review' THEN 1 ELSE 0 END),0) AS awaitingReview,
            COALESCE(SUM(CASE WHEN r.state='finalized' AND (c.review_id IS NULL OR c.state<>'finalized') THEN 1 ELSE 0 END),0) AS finalizationEvidenceMissing
          FROM pump_launch_reviews r
          LEFT JOIN pump_group_broadcast_closures c
            ON c.owner_id=r.owner_id AND c.review_id=r.id AND c.receipt=r.receipt
          WHERE r.owner_id=? AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'`,
        )
        .bind(user.userId),
      db
        .prepare(
          `SELECT r.id,r.mint,r.state,r.created_at AS createdAt,
            c.state AS settlementState,c.created_at AS settledAt
          FROM pump_launch_reviews r
          LEFT JOIN pump_group_broadcast_closures c
            ON c.owner_id=r.owner_id AND c.review_id=r.id AND c.receipt=r.receipt
          WHERE r.owner_id=? AND json_extract(r.review,'$.format')='pump-launch-group-review-v1'
          ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
        )
        .bind(user.userId, ACCOUNT_LAUNCH_ACTIVITY_LIMIT),
    ]);
    if (!counts.success || !recent.success || counts.results.length !== 1)
      throw new Error('Incomplete launch activity snapshot.');
    const summary = counts.results[0] as Counts;
    const activity = validatedAccountLaunchActivity({
      observedAt: new Date().toISOString(),
      savedGroups: summary.savedGroups,
      finalizedGroups: summary.finalizedGroups,
      awaitingReview: summary.awaitingReview,
      finalizationEvidenceMissing: summary.finalizationEvidenceMissing,
      recent: recent.results as AccountLaunchActivityItem[],
    });
    return json(activity);
  } catch {
    return json(
      {
        error:
          'Saved launch activity could not be checked completely. No partial counts are shown.',
      },
      503,
    );
  }
}
