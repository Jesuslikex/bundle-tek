import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { walletAddress } from '@/lib/wallet-workspace';
import { UUID } from '@/lib/wallet-operation';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import {
  inspectSupplyAction,
  supplyActionInput,
  validatedSupplyAction,
  type TokenSupplyAction,
} from '@/lib/token-supply-action';
import {
  decodeSupplyActionReceipt,
  prepareSupplyAction,
  recheckSupplyAction,
} from '@/lib/token-supply-action-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const select =
  'SELECT id,wallet_address AS wallet,wallet_revision AS walletRevision,kind,mint,state,signature,document,receipt,created_at AS createdAt,updated_at AS updatedAt FROM token_supply_actions';
type Row = Omit<TokenSupplyAction, 'document' | 'receipt'> & {
  document: string;
  receipt: string | null;
};
const parse = (row: Row): TokenSupplyAction => ({
  ...row,
  document: JSON.parse(row.document),
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
});
const ACTIVE = "('awaiting_signature','signing','signed','submitted')";

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view burns and locks.' }, 401);
  let wallet: string;
  try {
    wallet = walletAddress(
      new URL(request.url).searchParams.get('wallet'),
      'Solana',
    );
  } catch {
    return json({ error: 'Choose a valid wallet.' }, 400);
  }
  try {
    const db = getD1();
    const result = await db
      .prepare(
        select +
          ' WHERE owner_id=? AND wallet_address=? ORDER BY created_at DESC,id DESC LIMIT 25',
      )
      .bind(user.userId, wallet)
      .all<Row>();
    const rows = await Promise.all(
      result.results.map((row) => validatedSupplyAction(parse(row))),
    );
    return json({
      actions: rows,
      active:
        rows.find((r) =>
          ['awaiting_signature', 'signing', 'signed', 'submitted'].includes(
            r.state,
          ),
        ) ?? null,
    });
  } catch {
    return json({ error: 'Burn and lock history unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review burns and locks.' }, 401);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 8192);
    if (
      ![
        'prepare',
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
    return json({ error: 'Invalid burn or lock request.' }, 400);
  }
  let phase = 'storage';
  try {
    const db = getD1(),
      now = new Date().toISOString(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    const currentWallet = async (wallet: string, revision: number) =>
      !!(await db
        .prepare(
          "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0",
        )
        .bind(user.userId, wallet, revision)
        .first());
    if (body.action === 'prepare') {
      let input: ReturnType<typeof supplyActionInput>;
      try {
        input = supplyActionInput({
          kind: body.kind,
          wallet: body.wallet,
          walletRevision: body.walletRevision,
          mint: body.mint,
          percent: body.percent,
          durationSeconds: body.durationSeconds,
          lockMetadata: body.lockMetadata,
          acknowledgeIrreversible: body.acknowledgeIrreversible,
        });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Invalid burn or lock terms.',
          },
          400,
        );
      }
      if (!(await currentWallet(input.wallet, input.walletRevision)))
        return json(
          { error: 'Wallet changed or is archived. Reload the roster.' },
          409,
        );
      if (
        (await db
          .prepare(
            'SELECT intent_id FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .bind(user.userId, input.wallet)
          .first()) ||
        (await db
          .prepare(
            `SELECT id FROM token_supply_actions WHERE owner_id=? AND wallet_address=? AND state IN ${ACTIVE}`,
          )
          .bind(user.userId, input.wallet)
          .first())
      )
        return json(
          {
            error:
              'This wallet has a retained approval. Cancel its unsigned review or recover its registered signature first.',
          },
          409,
        );
      phase = 'provider';
      const document = await prepareSupplyAction(input, signal);
      phase = 'storage';
      const retained = await db
        .prepare(
          "INSERT INTO token_supply_actions (id,owner_id,wallet_address,wallet_revision,kind,mint,document,state,signature,receipt,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'awaiting_signature',NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) AND ?>? RETURNING id",
        )
        .bind(
          document.id,
          user.userId,
          document.wallet,
          document.walletRevision,
          document.kind,
          document.mint,
          JSON.stringify(document),
          now,
          now,
          user.userId,
          document.wallet,
          document.walletRevision,
          Date.parse(document.expiresAt),
          Date.now(),
        )
        .first<{ id: string }>();
      if (!retained)
        return json(
          {
            error:
              'Wallet or preparation changed before it was saved. Prepare again.',
          },
          409,
        );
      return json({
        action: {
          id: document.id,
          wallet: document.wallet,
          walletRevision: document.walletRevision,
          kind: document.kind,
          mint: document.mint,
          state: 'awaiting_signature',
          signature: null,
          document,
          receipt: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (typeof body.id !== 'string' || !UUID.test(body.id))
      return json({ error: 'Choose a saved burn or lock.' }, 400);
    const read = () =>
      db
        .prepare(select + ' WHERE owner_id=? AND id=?')
        .bind(user.userId, body.id as string)
        .first<Row>();
    const stored = await read();
    if (!stored) return json({ error: 'Burn or lock unavailable.' }, 404);
    const row = parse(stored),
      review = row.document;
    if (
      review.id !== row.id ||
      review.wallet !== row.wallet ||
      review.walletRevision !== row.walletRevision ||
      review.kind !== row.kind ||
      review.mint !== row.mint
    )
      throw new Error();
    await inspectSupplyAction(review, review.transaction, false);
    if (body.action === 'begin_signing') {
      if (
        row.state !== 'awaiting_signature' ||
        Date.parse(review.expiresAt) <= Date.now() ||
        !(await currentWallet(row.wallet, row.walletRevision))
      )
        return json(
          { error: 'A current unsigned review is required before signing.' },
          409,
        );
      const claimed = await db
        .prepare(
          "UPDATE token_supply_actions SET state='signing',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=token_supply_actions.owner_id AND w.chain='Solana' AND w.address=token_supply_actions.wallet_address AND w.revision=token_supply_actions.wallet_revision AND w.archived=0) AND ?>? RETURNING id",
        )
        .bind(
          now,
          user.userId,
          row.id,
          Date.parse(review.expiresAt),
          Date.now(),
        )
        .first<{ id: string }>();
      if (!claimed)
        return json(
          { error: 'Signing reservation changed. Reload retained history.' },
          409,
        );
    } else if (body.action === 'reject_signing') {
      if (row.state !== 'signing' || body.noSignatureVerified !== true)
        return json(
          {
            error:
              'Confirm that no signature was produced before releasing the signing reservation.',
          },
          409,
        );
      await db
        .prepare(
          "UPDATE token_supply_actions SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
        )
        .bind(now, user.userId, row.id)
        .run();
    } else if (body.action === 'cancel') {
      if (row.state !== 'awaiting_signature')
        return json(
          {
            error:
              'Only an unsigned review can be cancelled. Recover registered signatures.',
          },
          409,
        );
      await db
        .prepare(
          "UPDATE token_supply_actions SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature'",
        )
        .bind(now, user.userId, row.id)
        .run();
    } else if (body.action === 'recover') {
      if (
        !row.signature ||
        !['signed', 'submitted', 'finalized', 'failed'].includes(row.state)
      )
        return json({ error: 'No registered signature to recover.' }, 409);
      if (row.state === 'finalized' || (row.state === 'failed' && row.receipt))
        return json({ action: row });
      phase = 'provider';
      const endpoint = getSolanaRpcEndpoint('mainnet'),
        rpc = (method: string, params: unknown[]) =>
          balanceRpc(endpoint, method, params, signal, fetch);
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
      const receipt = await decodeSupplyActionReceipt(
        raw,
        review,
        row.signature,
      );
      phase = 'storage';
      await db
        .prepare(
          "UPDATE token_supply_actions SET state=?,receipt=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND state IN ('signed','submitted')",
        )
        .bind(
          receipt.failed ? 'failed' : 'finalized',
          JSON.stringify(receipt),
          new Date().toISOString(),
          user.userId,
          row.id,
          row.signature,
        )
        .run();
    } else {
      if (typeof body.transaction !== 'string')
        return json({ error: 'Exact signed packet required.' }, 400);
      const signed = await inspectSupplyAction(review, body.transaction, true);
      if (
        body.action === 'register' &&
        row.state === 'signed' &&
        row.signature === signed.signature
      )
        return json({ action: row });
      if (
        (body.action === 'register' && row.state !== 'signing') ||
        (body.action === 'submit' &&
          (row.state !== 'signed' || row.signature !== signed.signature))
      )
        return json(
          { error: 'Burn or lock state does not permit this action.' },
          409,
        );
      if (body.action === 'register')
        await db
          .prepare(
            "UPDATE token_supply_actions SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
          )
          .bind(signed.signature, now, user.userId, row.id)
          .run();
      else {
        if (
          Date.parse(review.expiresAt) <= Date.now() ||
          !(await currentWallet(row.wallet, row.walletRevision))
        )
          return json(
            {
              error:
                'Wallet or approval changed or expired. No automatic replacement.',
            },
            409,
          );
        phase = 'provider';
        await recheckSupplyAction(review, signal);
        phase = 'storage';
        const armed = await db
          .prepare(
            "UPDATE token_supply_actions SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=token_supply_actions.owner_id AND w.chain='Solana' AND w.address=token_supply_actions.wallet_address AND w.revision=token_supply_actions.wallet_revision AND w.archived=0) AND ?>? RETURNING id",
          )
          .bind(
            now,
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
        const sent = await balanceRpc(
          getSolanaRpcEndpoint('mainnet'),
          'sendTransaction',
          [
            body.transaction,
            {
              encoding: 'base64',
              skipPreflight: false,
              preflightCommitment: 'finalized',
              maxRetries: 0,
              minContextSlot: review.slot,
            },
          ],
          signal,
          fetch,
        );
        if (sent !== row.signature) throw new Error();
      }
    }
    const latest = await read();
    if (!latest) throw new Error();
    return json({ action: parse(latest) });
  } catch (error) {
    if (
      error instanceof Error &&
      /Wallet already reserved|Payer already reserved|Signature already registered|UNIQUE constraint/.test(
        error.message,
      )
    )
      return json(
        {
          error:
            'Wallet or signature is already reserved. Reload saved approvals.',
        },
        409,
      );
    if (phase === 'provider' && error instanceof Error && error.message)
      return json(
        {
          error: `${error.message} No automatic signing, replacement or retry.`,
        },
        502,
      );
    return json(
      {
        error:
          phase === 'send'
            ? 'Submission outcome is unknown. The signature remains reserved; recover it without resending.'
            : phase === 'provider'
              ? 'Burn or lock checks unavailable. No automatic signing, replacement or retry.'
              : 'Burn or lock history could not be saved. Reload its retained state before continuing.',
      },
      phase === 'storage' ? 503 : 502,
    );
  }
}
