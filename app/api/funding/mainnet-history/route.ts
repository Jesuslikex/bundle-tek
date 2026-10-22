import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  mainnetFundingHistoryCursor,
  readMainnetFundingHistoryCursor,
  decodeMainnetFundingHistory,
  MAINNET_FUNDING_PROGRESS_LIMIT,
  decodeMainnetFundingProgress,
  type MainnetFundingProgress,
} from '@/lib/mainnet-funding-history';
import { mainnetFundingHistoryRecord } from '@/lib/mainnet-funding-history-server';
import type { NativeWithdrawal } from '@/lib/native-withdrawal';
import {
  createFundingRouteSource,
  decodeFundingRouteHistory,
  type FundingRouteSource,
} from '@/lib/mainnet-funding-route-history';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const from =
  'native_withdrawal_events e JOIN native_withdrawals w ON w.owner_id=e.owner_id AND w.id=e.intent_id AND w.wallet_address=e.wallet_address';
const scope =
  "e.owner_id=? AND json_extract(w.document,'$.funding.planId')=? AND (? IS NULL OR json_extract(w.document,'$.funding.revision')=?)";
const columns =
  "e.sequence,e.created_at AS eventCreatedAt,e.state,e.signature,e.failure_receipt AS failureReceipt,w.id,w.wallet_address AS wallet,w.wallet_revision AS walletRevision,w.document,CASE WHEN e.state='finalized' THEN w.receipt ELSE NULL END AS receipt,w.created_at AS createdAt";
type Row = Omit<
  NativeWithdrawal,
  'updatedAt' | 'document' | 'receipt' | 'failureReceipt'
> & {
  sequence: number;
  eventCreatedAt: string;
  document: string;
  receipt: string | null;
  failureReceipt: string | null;
};
const project = (row: Row, id: string, revision: number | null) =>
  mainnetFundingHistoryRecord(
    {
      sequence: row.sequence,
      createdAt: row.eventCreatedAt,
      withdrawal: {
        id: row.id,
        wallet: row.wallet,
        walletRevision: row.walletRevision,
        state: row.state,
        signature: row.signature,
        document: JSON.parse(row.document),
        receipt: row.receipt ? JSON.parse(row.receipt) : null,
        failureReceipt: row.failureReceipt
          ? JSON.parse(row.failureReceipt)
          : null,
        createdAt: row.createdAt,
        updatedAt: row.eventCreatedAt,
      },
    },
    id,
    revision,
  );

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read mainnet funding history.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id'),
    requestedRevision = params.get('revision'),
    cursor = params.get('cursor');
  let revision: number | null = null,
    sequence: number | null = null;
  try {
    if (!id || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error();
    if (requestedRevision !== null) {
      if (
        !/^[1-9]\d{0,9}$/.test(requestedRevision) ||
        Number(requestedRevision) >= 1e9
      )
        throw new Error();
      revision = Number(requestedRevision);
    }
    if (cursor !== null)
      sequence = readMainnetFundingHistoryCursor(cursor, id, revision);
  } catch {
    return json(
      {
        error:
          'Choose a saved funding plan, revision and matching history cursor.',
      },
      400,
    );
  }
  try {
    const db = getD1();
    const saved = await db
      .prepare(
        "SELECT revision,archived,document,updated_at AS updatedAt,json_extract(document,'$.name') AS name FROM funding_plans WHERE owner_id=? AND id=?",
      )
      .bind(user.userId, id)
      .first<{
        revision: number;
        archived: number;
        name: string;
        document: string;
        updatedAt: string;
      }>();
    if (!saved) return json({ error: 'Saved funding plan not found.' }, 404);
    const anchor =
      sequence === null
        ? null
        : await db
            .prepare(
              `SELECT e.sequence,e.created_at AS createdAt FROM ${from} WHERE ${scope} AND e.sequence=?`,
            )
            .bind(user.userId, id, revision, revision, sequence)
            .first<{ sequence: number; createdAt: string }>();
    if (sequence !== null && !anchor)
      return json({ error: 'Mainnet funding cursor unavailable.' }, 400);
    const progressRevision = revision ?? saved.revision;
    const [historyResult, progressResult] = await Promise.allSettled([
      db
        .prepare(
          `SELECT ${columns} FROM ${from} WHERE ${scope} AND (? IS NULL OR e.created_at<? OR (e.created_at=? AND e.sequence<?)) ORDER BY e.created_at DESC,e.sequence DESC LIMIT 51`,
        )
        .bind(
          user.userId,
          id,
          revision,
          revision,
          anchor?.createdAt ?? null,
          anchor?.createdAt ?? '',
          anchor?.createdAt ?? '',
          anchor?.sequence ?? 0,
        )
        .all<Row>(),
      db
        .prepare(
          `SELECT ${columns} FROM ${from} WHERE ${scope} AND e.sequence=(SELECT MAX(last.sequence) FROM native_withdrawal_events last WHERE last.owner_id=w.owner_id AND last.intent_id=w.id AND last.wallet_address=w.wallet_address) AND NOT EXISTS(SELECT 1 FROM native_withdrawals newer WHERE newer.owner_id=w.owner_id AND json_extract(newer.document,'$.funding.planId')=json_extract(w.document,'$.funding.planId') AND json_extract(newer.document,'$.funding.revision')=json_extract(w.document,'$.funding.revision') AND json_extract(newer.document,'$.funding.item')=json_extract(w.document,'$.funding.item') AND json_extract(newer.document,'$.funding.leg') IS json_extract(w.document,'$.funding.leg') AND (newer.created_at>w.created_at OR (newer.created_at=w.created_at AND newer.id>w.id))) ORDER BY json_extract(w.document,'$.funding.item'),COALESCE(json_extract(w.document,'$.funding.leg'),0) LIMIT ${MAINNET_FUNDING_PROGRESS_LIMIT + 1}`,
        )
        .bind(user.userId, id, progressRevision, progressRevision)
        .all<Row>(),
    ]);
    if (historyResult.status !== 'fulfilled')
      throw new Error('History storage unavailable.');
    const history = historyResult.value;
    const events = await Promise.all(
      history.results.slice(0, 50).map((row) => project(row, id!, revision)),
    );
    let progress: MainnetFundingProgress;
    try {
      if (progressResult.status !== 'fulfilled')
        throw new Error('Progress storage unavailable.');
      const records = await Promise.all(
        progressResult.value.results.map((row) =>
          project(row, id!, progressRevision),
        ),
      );
      progress = decodeMainnetFundingProgress(
        { revision: progressRevision, records },
        id!,
        progressRevision,
      );
    } catch {
      // An unavailable summary is not an empty/zero-delivery summary.
      progress = {
        revision: progressRevision,
        records: null,
        unavailable: true,
      };
    }
    const result = decodeMainnetFundingHistory(
      {
        id,
        name: saved.name,
        currentRevision: saved.revision,
        archived: Boolean(saved.archived),
        revision,
        executionAllowed: false,
        events,
        progress,
        nextCursor:
          history.results.length > 50
            ? mainnetFundingHistoryCursor(
                id!,
                revision,
                events.at(-1)!.sequence,
              )
            : null,
      },
      id!,
      revision,
    );
    let routeSource: FundingRouteSource | null = null;
    if (progressRevision <= saved.revision && !progress.unavailable) {
      try {
        routeSource = await createFundingRouteSource(
          {
            id: id!,
            revision: saved.revision,
            archived: Boolean(saved.archived),
            updatedAt: saved.updatedAt,
            document: JSON.parse(saved.document),
          },
          progressRevision,
        );
        await decodeFundingRouteHistory(routeSource, result);
      } catch {
        routeSource = null;
        // Missing/unsupported saved route does not erase validated captured transitions.
      }
    }
    return json({ ...result, routeSource });
  } catch {
    return json(
      {
        error:
          'Mainnet funding history is unavailable or its retained evidence is inconsistent.',
      },
      503,
    );
  }
}
