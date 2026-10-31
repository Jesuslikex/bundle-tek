import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import { env } from '@/lib/server-env';
import {
  CLEANUP_MAX_ROWS,
  isCleanupBuy,
  isCleanupSell,
  type WalletCleanupDocument,
  cleanupInput,
  cleanupRunInput,
  inspectWalletCleanup,
  uint,
  validatedWalletCleanup,
  type WalletCleanup,
} from '@/lib/wallet-cleanup';
import {
  cleanupRpc,
  decodeWalletCleanupBuyReceipt,
  decodeWalletCleanupReceipt,
  decodeWalletCleanupSellReceipt,
  prepareWalletCleanup,
  prepareWalletCleanupBuy,
  prepareWalletCleanupSells,
  recheckWalletCleanup,
  recheckWalletCleanupBuy,
  recheckWalletCleanupSell,
} from '@/lib/wallet-cleanup-server';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { walletAddress } from '@/lib/wallet-workspace';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const select =
  'SELECT id,batch_id AS batchId,wallet_address AS wallet,wallet_revision AS walletRevision,state,signature,document,receipt,failure,created_at AS createdAt,updated_at AS updatedAt FROM wallet_cleanups';
type Row = Omit<WalletCleanup, 'document' | 'receipt' | 'failure'> & {
  document: string;
  receipt: string | null;
  failure: string | null;
};
const parse = (row: Row): WalletCleanup => ({
  ...row,
  document: JSON.parse(row.document),
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
  failure: row.failure ? JSON.parse(row.failure) : null,
});
const ACTIVE = "('awaiting_signature','signing','signed','submitted')";
const currentWalletSql =
  "EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=wallet_cleanups.owner_id AND w.chain='Solana' AND w.address=wallet_cleanups.wallet_address AND w.revision=wallet_cleanups.wallet_revision AND w.archived=0)";

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view cleanups.' }, 401);
  const params = new URL(request.url).searchParams;
  let batchId = params.get('batchId');
  if (batchId !== null && !UUID.test(batchId))
    return json({ error: 'Choose a valid cleanup batch.' }, 400);
  try {
    const db = getD1();
    if (batchId === null && params.get('latest') !== null) {
      const newest = await db
        .prepare(
          'SELECT batch_id AS batchId FROM wallet_cleanups WHERE owner_id=? ORDER BY created_at DESC LIMIT 1',
        )
        .bind(user.userId)
        .first<{ batchId: string }>();
      batchId = newest?.batchId ?? null;
    }
    const result = batchId
      ? await db
          .prepare(
            select +
              ' WHERE owner_id=? AND batch_id=? ORDER BY created_at,id LIMIT 50',
          )
          .bind(user.userId, batchId)
          .all<Row>()
      : await db
          .prepare(
            select +
              ' WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 50',
          )
          .bind(user.userId)
          .all<Row>();
    return json({
      cleanups: await Promise.all(
        result.results.map((row) => validatedWalletCleanup(parse(row))),
      ),
    });
  } catch (err) {
    console.error('cleanup GET', err);
    return json({ error: 'Cleanup history unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review cleanups.' }, 401);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 8192);
    if (
      ![
        'prepare',
        'run',
        'begin_signing',
        'reject_signing',
        'register',
        'submit',
        'recover',
        'cancel',
      ].includes(String(body.action))
    )
      throw new Error();
  } catch {
    return json({ error: 'Invalid cleanup request.' }, 400);
  }
  let phase = 'storage';
  try {
    const db = getD1(),
      now = () => new Date().toISOString(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)]);
    const currentWallet = async (wallet: string, revision: number) =>
      !!(await db
        .prepare(
          "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0",
        )
        .bind(user.userId, wallet, revision)
        .first());
    const batchRows = async (batchId: string) =>
      (
        await db
          .prepare(
            select + ' WHERE owner_id=? AND batch_id=? ORDER BY created_at,id',
          )
          .bind(user.userId, batchId)
          .all<Row>()
      ).results.map(parse);

    if (body.action === 'run') {
      let input: ReturnType<typeof cleanupRunInput>;
      try {
        input = cleanupRunInput(body);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Choose cleanup wallets and a delay.',
          },
          400,
        );
      }
      const apiKey = (env as unknown as Record<string, unknown>)
        .JUPITER_API_KEY;
      if (typeof apiKey !== 'string')
        return json({ error: 'Jupiter sell routes are not configured.' }, 503);
      const revisions = new Map<string, number>();
      for (const address of new Set([
        ...input.payload.input_wallet_pubkeys,
        ...input.payload.output_wallet_pubkeys,
      ])) {
        const row = await db
          .prepare(
            "SELECT revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
          )
          .bind(user.userId, address)
          .first<{ revision: number }>();
        if (!row)
          return json(
            {
              error:
                'A cleanup wallet changed or is archived. Reload the roster.',
            },
            400,
          );
        revisions.set(address, row.revision);
      }
      const batchId = crypto.randomUUID();
      const cleanups: WalletCleanup[] = [],
        errors: { wallet: string; mint?: string; error: string }[] = [],
        empty: string[] = [];
      let remaining = 0;
      phase = 'provider';
      for (const round of input.rounds) {
        if (
          await db
            .prepare(
              `SELECT 1 FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=? UNION ALL SELECT 1 FROM wallet_cleanups WHERE owner_id=? AND wallet_address=? AND state IN ${ACTIVE} LIMIT 1`,
            )
            .bind(user.userId, round.seller, user.userId, round.seller)
            .first()
        ) {
          errors.push({
            wallet: round.seller,
            error:
              'Wallet has a retained approval. Finish or cancel it before cleanup.',
          });
          continue;
        }
        let sells: WalletCleanupDocument[];
        try {
          const result = await prepareWalletCleanupSells(
            {
              batchId,
              wallet: round.seller,
              walletRevision: revisions.get(round.seller) as number,
              destination: round.buyer,
            },
            apiKey,
            signal,
          );
          remaining += result.remaining;
          for (const e of result.errors)
            errors.push({
              wallet: round.seller,
              mint: e.mint,
              error: e.error,
            });
          sells = result.sells;
        } catch (error) {
          errors.push({
            wallet: round.seller,
            error:
              error instanceof Error && /^[\w .,'-]{1,120}$/.test(error.message)
                ? error.message
                : 'Cleanup checks unavailable for this wallet.',
          });
          continue;
        }
        if (!sells.length) {
          if (!errors.some((e) => e.wallet === round.seller))
            empty.push(round.seller);
          continue;
        }
        for (const document of sells) {
          if (cleanups.length >= CLEANUP_MAX_ROWS) {
            remaining++;
            continue;
          }
          const at = now();
          try {
            const retained = await db
              .prepare(
                "INSERT INTO wallet_cleanups (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,signature,receipt,failure,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'awaiting_signature',NULL,NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) AND ?>? RETURNING id",
              )
              .bind(
                document.id,
                user.userId,
                batchId,
                document.wallet,
                document.walletRevision,
                document.destination,
                JSON.stringify(document),
                at,
                at,
                user.userId,
                document.wallet,
                document.walletRevision,
                Date.parse(document.expiresAt),
                Date.now(),
              )
              .first<{ id: string }>();
            if (!retained) throw new Error('changed');
          } catch (error) {
            errors.push({
              wallet: round.seller,
              error:
                error instanceof Error && /reserved/.test(error.message)
                  ? 'Wallet is reserved by another approval or launch.'
                  : 'Wallet or preparation changed before retention.',
            });
            break;
          }
          cleanups.push({
            id: document.id,
            batchId,
            wallet: document.wallet,
            walletRevision: document.walletRevision,
            state: 'awaiting_signature',
            signature: null,
            document,
            receipt: null,
            failure: null,
            createdAt: at,
            updatedAt: at,
          });
        }
      }
      phase = 'storage';
      return json({
        batchId,
        stage: 'sell',
        plan: input.payload,
        rounds: input.rounds,
        cleanups,
        errors,
        empty,
        remaining,
      });
    }

    if (body.action === 'prepare') {
      let input: ReturnType<typeof cleanupInput>;
      try {
        input = cleanupInput(body);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Choose cleanup wallets and a destination.',
          },
          400,
        );
      }
      if (
        !(await db
          .prepare(
            "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
          )
          .bind(user.userId, input.destination)
          .first())
      )
        return json(
          {
            error:
              'Choose a saved, unarchived Solana wallet as the cleanup destination.',
          },
          400,
        );
      const batchId = crypto.randomUUID();
      const cleanups: WalletCleanup[] = [],
        errors: { wallet: string; mint?: string; error: string }[] = [],
        empty: string[] = [];
      const eligible: typeof input.wallets = [];
      for (const wallet of input.wallets) {
        if (!(await currentWallet(wallet.address, wallet.revision))) {
          errors.push({
            wallet: wallet.address,
            error: 'Wallet changed or is archived. Reload the roster.',
          });
          continue;
        }
        if (
          await db
            .prepare(
              `SELECT 1 FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=? UNION ALL SELECT 1 FROM wallet_cleanups WHERE owner_id=? AND wallet_address=? AND state IN ${ACTIVE} LIMIT 1`,
            )
            .bind(user.userId, wallet.address, user.userId, wallet.address)
            .first()
        ) {
          errors.push({
            wallet: wallet.address,
            error:
              'Wallet has a retained approval. Finish or cancel it before cleanup.',
          });
          continue;
        }
        eligible.push(wallet);
      }
      const stage = body.stage === 'sell' ? 'sell' : 'close';
      if (
        body.stage !== undefined &&
        body.stage !== 'sell' &&
        body.stage !== 'close'
      )
        return json({ error: 'Choose the sell or close cleanup stage.' }, 400);
      let mint: string | undefined;
      if (body.mint !== undefined)
        try {
          if (stage !== 'sell') throw new Error();
          mint = walletAddress(body.mint, 'Solana');
        } catch {
          return json({ error: 'Choose one token to sell.' }, 400);
        }
      const apiKey = (env as unknown as Record<string, unknown>)
        .JUPITER_API_KEY;
      if (stage === 'sell' && typeof apiKey !== 'string')
        return json({ error: 'Jupiter sell routes are not configured.' }, 503);
      // Prepare together so every review in the batch shares a fresh lifetime.
      phase = 'provider';
      let remaining = 0;
      const prepared = await Promise.allSettled(
        eligible.map(async (wallet): Promise<WalletCleanupDocument[]> => {
          const context = {
            batchId,
            wallet: wallet.address,
            walletRevision: wallet.revision,
            destination: input.destination,
          };
          if (stage === 'close') {
            const document = await prepareWalletCleanup(
              { ...context, keepLamports: input.keepLamports },
              signal,
            );
            return document ? [document] : [];
          }
          const result = await prepareWalletCleanupSells(
            mint ? { ...context, mint } : context,
            apiKey as string,
            signal,
          );
          remaining += result.remaining;
          for (const e of result.errors)
            errors.push({
              wallet: wallet.address,
              mint: e.mint,
              error: e.error,
            });
          return result.sells;
        }),
      );
      phase = 'storage';
      for (const [index, wallet] of eligible.entries()) {
        const outcome = prepared[index];
        if (outcome.status === 'rejected') {
          const error = outcome.reason;
          errors.push({
            wallet: wallet.address,
            error:
              error instanceof Error && /^[\w .,'-]{1,120}$/.test(error.message)
                ? error.message
                : 'Cleanup checks unavailable for this wallet.',
          });
          continue;
        }
        if (!outcome.value.length) {
          if (!errors.some((e) => e.wallet === wallet.address))
            empty.push(wallet.address);
          continue;
        }
        for (const document of outcome.value) {
          if (cleanups.length >= CLEANUP_MAX_ROWS) {
            remaining++;
            continue;
          }
          const at = now();
          try {
            const retained = await db
              .prepare(
                "INSERT INTO wallet_cleanups (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,signature,receipt,failure,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'awaiting_signature',NULL,NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) AND ?>? RETURNING id",
              )
              .bind(
                document.id,
                user.userId,
                batchId,
                document.wallet,
                document.walletRevision,
                document.destination,
                JSON.stringify(document),
                at,
                at,
                user.userId,
                document.wallet,
                document.walletRevision,
                Date.parse(document.expiresAt),
                Date.now(),
              )
              .first<{ id: string }>();
            if (!retained) throw new Error('changed');
          } catch (error) {
            errors.push({
              wallet: wallet.address,
              error:
                error instanceof Error && /reserved/.test(error.message)
                  ? 'Wallet is reserved by another approval or launch.'
                  : 'Wallet or preparation changed before retention.',
            });
            break;
          }
          cleanups.push({
            id: document.id,
            batchId,
            wallet: document.wallet,
            walletRevision: document.walletRevision,
            state: 'awaiting_signature',
            signature: null,
            document,
            receipt: null,
            failure: null,
            createdAt: at,
            updatedAt: at,
          });
        }
      }
      return json({ batchId, stage, cleanups, errors, empty, remaining });
    }

    if (body.action === 'begin_signing' || body.action === 'cancel') {
      if (typeof body.batchId !== 'string' || !UUID.test(body.batchId))
        return json({ error: 'Choose a saved cleanup batch.' }, 400);
      let rows = await batchRows(body.batchId);
      if (!rows.length)
        return json({ error: 'Cleanup batch unavailable.' }, 404);
      // An expired buy-back is re-quoted in place before inspection: its sell
      // already landed, so re-running the batch would sell from an emptied
      // seller and lose the buy-back.
      if (body.action === 'begin_signing') {
        for (const row of rows) {
          if (row.state !== 'awaiting_signature') continue;
          if (!isCleanupBuy(row.document)) continue;
          if (Date.parse(row.document.expiresAt) > Date.now()) continue;
          const buyKey = (env as unknown as Record<string, unknown>)
            .JUPITER_API_KEY;
          const fresh = await prepareWalletCleanupBuy(
            {
              batchId: row.batchId,
              wallet: row.wallet,
              walletRevision: row.walletRevision,
              mint: row.document.mint,
              lamports: BigInt(row.document.amountInLamports),
            },
            typeof buyKey === 'string' ? buyKey : undefined,
            signal,
          );
          // Keep the row's identity: the document is re-quoted in place.
          fresh.id = row.id;
          fresh.batchId = row.batchId;
          await db
            .prepare(
              "UPDATE wallet_cleanups SET document=?,updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature'",
            )
            .bind(JSON.stringify(fresh), now(), user.userId, row.id)
            .run();
        }
        rows = await batchRows(body.batchId);
      }
      for (const row of rows)
        await inspectWalletCleanup(
          row.document,
          row.document.transaction,
          false,
        );
      if (body.action === 'cancel') {
        await db
          .prepare(
            "UPDATE wallet_cleanups SET state='cancelled',updated_at=? WHERE owner_id=? AND batch_id=? AND state='awaiting_signature'",
          )
          .bind(now(), user.userId, body.batchId)
          .run();
        return json({ cleanups: await batchRows(body.batchId) });
      }
      const pending = rows.filter((r) => r.state === 'awaiting_signature');
      if (
        !pending.length ||
        pending.some((r) => Date.parse(r.document.expiresAt) <= Date.now())
      )
        return json(
          {
            error:
              'Every unsigned cleanup in this batch must still be current. Prepare again.',
          },
          409,
        );
      const ids = pending.map((r) => r.id);
      // One statement so the whole reviewed batch moves to signing together.
      const claimed = await db
        .prepare(
          `UPDATE wallet_cleanups SET state='signing',updated_at=? WHERE owner_id=? AND batch_id=? AND state='awaiting_signature' AND id IN (SELECT value FROM json_each(?)) AND ${currentWalletSql} AND json_extract(document,'$.expiresAt')>? RETURNING id`,
        )
        .bind(now(), user.userId, body.batchId, JSON.stringify(ids), now())
        .all<{ id: string }>();
      if (claimed.results.length !== ids.length) {
        await db
          .prepare(
            "UPDATE wallet_cleanups SET state='cancelled',updated_at=? WHERE owner_id=? AND id IN (SELECT value FROM json_each(?)) AND state='signing' AND signature IS NULL",
          )
          .bind(
            now(),
            user.userId,
            JSON.stringify(claimed.results.map((r) => r.id)),
          )
          .run();
        return json(
          {
            error: 'A wallet in this batch changed or expired. Prepare again.',
          },
          409,
        );
      }
      return json({ cleanups: await batchRows(body.batchId) });
    }

    if (typeof body.id !== 'string' || !UUID.test(body.id))
      return json({ error: 'Choose a saved cleanup.' }, 400);
    const read = async () => {
      const stored = await db
        .prepare(select + ' WHERE owner_id=? AND id=?')
        .bind(user.userId, body.id as string)
        .first<Row>();
      return stored ? parse(stored) : null;
    };
    const row = await read();
    if (!row) return json({ error: 'Cleanup unavailable.' }, 404);
    const review = row.document;
    if (
      review.id !== row.id ||
      review.wallet !== row.wallet ||
      review.walletRevision !== row.walletRevision
    )
      throw new Error();
    await inspectWalletCleanup(review, review.transaction, false);

    if (body.action === 'reject_signing') {
      if (row.state !== 'signing' || body.noSignatureVerified !== true)
        return json(
          {
            error:
              'Verify that no signature was produced before releasing a signing reservation.',
          },
          409,
        );
      await db
        .prepare(
          isCleanupBuy(row.document)
            ? "UPDATE wallet_cleanups SET state='awaiting_signature',updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL"
            : "UPDATE wallet_cleanups SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
        )
        .bind(now(), user.userId, row.id)
        .run();
    } else if (body.action === 'recover') {
      if (
        !row.signature ||
        !['signed', 'submitted', 'failed', 'finalized'].includes(row.state) ||
        (row.state === 'failed' && row.failure)
      )
        return json({ cleanup: row });
      phase = 'provider';
      const { rpc, source } = cleanupRpc(signal);
      if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
        throw new Error();
      const raw = await rpc('getTransaction', [
        row.signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (raw === null)
        return json(
          {
            error:
              'Finalized outcome unavailable. Keep this signature reserved; do not resend.',
          },
          409,
        );
      const outcome = isCleanupBuy(review)
        ? await decodeWalletCleanupBuyReceipt(
            raw,
            review,
            row.signature,
            source,
          )
        : isCleanupSell(review)
          ? await decodeWalletCleanupSellReceipt(
              raw,
              review,
              row.signature,
              source,
            )
          : await decodeWalletCleanupReceipt(raw, review, row.signature, source);
      const failed = 'failed' in outcome;
      phase = 'storage';
      await db
        .prepare(
          "UPDATE wallet_cleanups SET state=?,receipt=?,failure=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND state IN ('signed','submitted')",
        )
        .bind(
          failed ? 'failed' : 'finalized',
          failed ? null : JSON.stringify(outcome),
          failed ? JSON.stringify(outcome) : null,
          now(),
          user.userId,
          row.id,
          row.signature,
        )
        .run();
      // Buy-back leg: the paired buyer spends the SOL the sell just delivered.
      if (
        !failed &&
        isCleanupSell(review) &&
        'deliveredLamports' in outcome
      ) {
        const delivered = uint(outcome.deliveredLamports);
        const alreadyBought = await db
          .prepare(
            "SELECT 1 FROM wallet_cleanups WHERE owner_id=? AND batch_id=? AND json_extract(document,'$.format')='wallet-cleanup-buy-v1' AND state NOT IN ('cancelled','failed') LIMIT 1",
          )
          .bind(user.userId, row.batchId)
          .first();
        if (delivered > 0n && !alreadyBought) {
          const buyer = review.destination;
          const buyerRow = await db
            .prepare(
              "SELECT revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
            )
            .bind(user.userId, buyer)
            .first<{ revision: number }>();
          if (buyerRow) {
            const buyKey = (env as unknown as Record<string, unknown>)
              .JUPITER_API_KEY;
            try {
              const buy = await prepareWalletCleanupBuy(
                {
                  batchId: row.batchId,
                  wallet: buyer,
                  walletRevision: buyerRow.revision,
                  mint: review.mint,
                  lamports: delivered,
                },
                typeof buyKey === 'string' ? buyKey : undefined,
                signal,
              );
              await db
                .prepare(
                  "INSERT INTO wallet_cleanups (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,signature,receipt,failure,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'awaiting_signature',NULL,NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) RETURNING id",
                )
                .bind(
                  buy.id,
                  user.userId,
                  row.batchId,
                  buyer,
                  buyerRow.revision,
                  buy.mint,
                  JSON.stringify(buy),
                  now(),
                  now(),
                  user.userId,
                  buyer,
                  buyerRow.revision,
                )
                .first<{ id: string }>();
            } catch (error) {
              console.error('cleanup buy failed', error);
              // The sell stands even when the buy-back cannot be prepared.
            }
          }
        }
      }
    } else {
      if (typeof body.transaction !== 'string')
        return json({ error: 'Exact signed cleanup packet required.' }, 400);
      const signed = await inspectWalletCleanup(review, body.transaction, true);
      if (
        body.action === 'register' &&
        row.state === 'signed' &&
        row.signature === signed.signature
      )
        return json({ cleanup: row });
      if (
        (body.action === 'register' && row.state !== 'signing') ||
        (body.action === 'submit' &&
          (row.state !== 'signed' || row.signature !== signed.signature))
      )
        return json(
          { error: 'Cleanup state does not permit this action.' },
          409,
        );
      if (body.action === 'register')
        await db
          .prepare(
            "UPDATE wallet_cleanups SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
          )
          .bind(signed.signature, now(), user.userId, row.id)
          .run();
      else {
        if (
          Date.parse(review.expiresAt) <= Date.now() ||
          !(await currentWallet(row.wallet, row.walletRevision))
        )
          return json(
            {
              error:
                'Wallet or cleanup approval changed or expired. No automatic replacement.',
            },
            409,
          );
        phase = 'provider';
        await (isCleanupBuy(review)
          ? recheckWalletCleanupBuy(review, signal)
          : isCleanupSell(review)
            ? recheckWalletCleanupSell(review, signal)
            : recheckWalletCleanup(review, signal));
        phase = 'storage';
        const armed = await db
          .prepare(
            `UPDATE wallet_cleanups SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND ${currentWalletSql} AND ?>? RETURNING id`,
          )
          .bind(
            now(),
            user.userId,
            row.id,
            row.signature,
            Date.parse(review.expiresAt),
            Date.now(),
          )
          .first<{ id: string }>();
        if (!armed)
          return json(
            {
              error:
                'Submission was already reserved. Recover the existing signature.',
            },
            409,
          );
        phase = 'send';
        const { rpc } = cleanupRpc(signal);
        const sent = await rpc('sendTransaction', [
          body.transaction,
          {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'finalized',
            maxRetries: 0,
            minContextSlot: review.slot,
          },
        ]);
        if (sent !== row.signature) throw new Error();
      }
    }
    const latest = await read();
    if (!latest) throw new Error();
    return json({ cleanup: latest });
  } catch (error) {
    console.error('cleanup action failed', phase, error);
    if (
      error instanceof Error &&
      /reserved|Signature already registered/.test(error.message)
    )
      return json(
        { error: 'Wallet or signature is already reserved. Reload cleanups.' },
        409,
      );
    return json(
      {
        error:
          phase === 'send'
            ? 'Cleanup submission outcome is unknown. The signature remains reserved; recover it without resending.'
            : phase === 'provider'
              ? 'Cleanup checks or finalized receipt unavailable. No automatic signing, replacement or retry.'
              : 'Cleanup history could not be saved. Reload its retained state before continuing.',
      },
      phase === 'storage' ? 503 : 502,
    );
  }
}
