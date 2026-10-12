import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  ACCOUNT_COST_LIMIT,
  summarizeAccountCosts,
  type AccountCostEntry,
} from '@/lib/account-costs';
import { importedTradeReceipt } from '@/lib/imported-trade-ledger';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from '@/lib/warmup-lot-performance';
import { validatedSwapFailure } from '@/lib/swap-failure';
import { validatedNativeWithdrawal } from '@/lib/native-withdrawal';
import { transactionSignature } from '@/lib/tracked-wallet-transaction';
import type { WarmupSigningReview } from '@/lib/warmup-signing';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
type Stored = Record<string, unknown> & { document: string };
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view account costs.' }, 401);
  try {
    const db = getD1();
    const queries = [
      `SELECT r.id,r.project_id AS projectId,r.preparation_id AS preparationId,r.project_revision AS projectRevision,r.wallet_revision AS walletRevision,r.created_at AS createdAt,r.document,p.document AS projectDocument FROM imported_swap_receipts r LEFT JOIN imported_token_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id WHERE r.owner_id=? LIMIT ?`,
      `SELECT id,plan_id AS planId,signature,document,plan_revision AS planRevision,wallet_revision AS walletRevision,cycle,wallet_address AS wallet,json_extract(document,'$.mint') AS mint,json_extract(document,'$.acquiredRaw') AS acquiredRaw,COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw')) AS remainingRaw,json_extract(document,'$.decimals') AS decimals,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.wallet')=wallet_address AND json_extract(document,'$.signature')=signature THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_buy_receipts WHERE owner_id=? LIMIT ?`,
      `SELECT id,plan_id AS planId,signature,document,buy_receipt_id AS buyId,consumed_raw AS consumedRaw,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.signature')=signature AND json_extract(document,'$.consumedRaw')=consumed_raw AND json_extract(document,'$.buyReceiptId')=buy_receipt_id THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_sell_receipts WHERE owner_id=? LIMIT ?`,
      ...['imported_swap_signing_intents', 'warmup_signing_intents'].map(
        (table) =>
          `SELECT id,wallet_address AS wallet,signature,state,document,failure_receipt AS failureReceipt FROM ${table} WHERE owner_id=? AND state IN ('signed','submitted','failed','finalized') LIMIT ?`,
      ),
      `SELECT id,wallet_address AS wallet,wallet_revision AS walletRevision,state,signature,document,receipt,failure_receipt AS failureReceipt,created_at AS createdAt,updated_at AS updatedAt FROM native_withdrawals WHERE owner_id=? AND state IN ('signed','submitted','failed','finalized') LIMIT ?`,
    ];
    const results = await db.batch(
      queries.map((q) =>
        db.prepare(q).bind(user.userId, ACCOUNT_COST_LIMIT + 1),
      ),
    );
    if (
      results.some((r) => !r.success || r.results.length > ACCOUNT_COST_LIMIT)
    )
      throw new Error('Incomplete snapshot.');
    const entries: AccountCostEntry[] = [];
    const coverage = {
      pendingCount: 0,
      missingFailureCount: 0,
      missingFinalizedCount: 0,
    };
    const add = (
      category: AccountCostEntry['category'],
      signature: string,
      feeLamports: string,
      outcome: AccountCostEntry['outcome'],
    ) => {
      transactionSignature(signature);
      entries.push({ category, signature, feeLamports, outcome });
    };
    for (const row of results[0].results as Stored[]) {
      const token = JSON.parse(row.projectDocument as string).token;
      if (token.chain !== 'Solana') throw new Error();
      const r = importedTradeReceipt(
        { ...row, document: JSON.parse(row.document) },
        row.projectId as string,
        token.address,
        token.decimals,
      );
      add(
        'Imported swaps',
        r.document.signature,
        r.document.networkFeeLamports,
        'success',
      );
    }
    const buys = (results[1].results as Stored[]).map((row) => ({
      ...row,
      document: JSON.parse(row.document),
    })) as unknown as (PerformanceBuy & { planId: string })[];
    const sells = (results[2].results as Stored[]).map((row) => ({
      ...row,
      document: JSON.parse(row.document),
    })) as unknown as (PerformanceSell & { planId: string })[];
    for (const planId of new Set([...buys, ...sells].map((r) => r.planId))) {
      const b = buys.filter((r) => r.planId === planId),
        s = sells.filter((r) => r.planId === planId);
      warmupLotPerformance(
        b,
        s,
        b.map((r) => r.id),
      );
    }
    for (const row of [...buys, ...sells])
      add(
        'Warmup swaps',
        row.document.signature,
        row.document.networkFeeLamports,
        'success',
      );
    const successfulSignatures = new Map(
      entries.map((e) => [e.signature, e.category]),
    );
    for (const [index, category] of [
      [3, 'Imported swaps'],
      [4, 'Warmup swaps'],
    ] as const) {
      for (const row of results[index].results as Stored[]) {
        const review = JSON.parse(row.document) as WarmupSigningReview;
        const signature = transactionSignature(row.signature);
        if (
          review.id !== row.id ||
          review.wallet !== row.wallet ||
          review.network !== 'mainnet'
        )
          throw new Error();
        if (row.state === 'failed') {
          if (row.failureReceipt === null) coverage.missingFailureCount++;
          else {
            const f = validatedSwapFailure(
              JSON.parse(row.failureReceipt as string),
              review,
              signature,
            );
            add(category, signature, f.networkFeeLamports, 'failed');
          }
        } else {
          if (row.failureReceipt !== null) throw new Error();
          if (row.state === 'finalized') {
            if (successfulSignatures.get(signature) !== category)
              coverage.missingFinalizedCount++;
          } else coverage.pendingCount++;
        }
      }
    }
    for (const stored of results[5].results as Stored[]) {
      const row = await validatedNativeWithdrawal({
        ...stored,
        document: JSON.parse(stored.document),
        receipt:
          stored.receipt === null ? null : JSON.parse(stored.receipt as string),
        failureReceipt:
          stored.failureReceipt === null
            ? null
            : JSON.parse(stored.failureReceipt as string),
      });
      if (row.state === 'finalized')
        add(
          'Withdrawals',
          row.signature!,
          row.receipt!.networkFeeLamports,
          'success',
        );
      else if (row.state === 'failed') {
        if (row.failureReceipt)
          add(
            'Withdrawals',
            row.signature!,
            row.failureReceipt.networkFeeLamports,
            'failed',
          );
        else coverage.missingFailureCount++;
      } else coverage.pendingCount++;
    }
    return json(
      summarizeAccountCosts(entries, coverage, new Date().toISOString()),
    );
  } catch {
    return json(
      { error: 'Account costs unavailable. No partial totals are shown.' },
      503,
    );
  }
}
