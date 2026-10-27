import { NextResponse } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';

export const dynamic = 'force-dynamic';

type Row = {
  wallet_address: string;
  volume: number;
  pnl: number;
  launches: number;
};

/**
 * Per-wallet trade metrics for the roster columns.
 *
 * Volume is the absolute native movement of every finalized warm-up buy and
 * sell; P&L is the signed net of the same movements; launches counts distinct
 * warm-up plans the wallet took part in. Sells carry no wallet column, so they
 * are attributed through the buy receipt they consume.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });

  const db = await getD1();
  const result = await db
    .prepare(
      `SELECT wallet_address,
              SUM(ABS(native)) AS volume,
              SUM(native) AS pnl,
              COUNT(DISTINCT launch_key) AS launches
         FROM (
           SELECT wallet_address, plan_id AS launch_key,
                  CAST(json_extract(document, '$.nativeChangeRaw') AS INTEGER) AS native
             FROM warmup_buy_receipts
            WHERE owner_id = ?
           UNION ALL
           SELECT b.wallet_address, b.plan_id AS launch_key,
                  CAST(json_extract(s.document, '$.nativeChangeRaw') AS INTEGER) AS native
             FROM warmup_sell_receipts s
             JOIN warmup_buy_receipts b ON b.id = s.buy_receipt_id
            WHERE b.owner_id = ?
           UNION ALL
           SELECT wallet_address, NULL AS launch_key,
                  CAST(json_extract(receipt, '$.nativeChangeLamports') AS INTEGER) AS native
             FROM wallet_cleanups
            WHERE owner_id = ? AND receipt IS NOT NULL
         )
        GROUP BY wallet_address`,
    )
    .bind(user.userId, user.userId, user.userId)
    .all<Row>();

  const metrics: Record<string, { volume: number; pnl: number; launches: number }> = {};
  for (const row of result.results ?? []) {
    metrics[row.wallet_address] = {
      volume: row.volume ?? 0,
      pnl: row.pnl ?? 0,
      launches: row.launches ?? 0,
    };
  }

  return NextResponse.json({ metrics });
}
