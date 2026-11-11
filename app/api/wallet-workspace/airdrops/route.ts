import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { walletAddress } from '@/lib/wallet-workspace';
import { UUID } from '@/lib/wallet-operation';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import {
  airdropCreateInput,
  inspectAirdrop,
  validatedAirdropAction,
  type TokenAirdropAction,
} from '@/lib/token-airdrop';
import {
  decodeAirdropReceipt,
  prepareAirdrop,
  recheckAirdrop,
  type AirdropPrepareInput,
} from '@/lib/token-airdrop-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const select =
  'SELECT id,airdrop_id AS airdropId,wallet_address AS wallet,wallet_revision AS walletRevision,kind,mint,state,signature,document,receipt,created_at AS createdAt,updated_at AS updatedAt FROM token_airdrop_actions';
type Row = Omit<TokenAirdropAction, 'document' | 'receipt'> & {
  document: string;
  receipt: string | null;
};
const parse = (row: Row): TokenAirdropAction => ({
  ...row,
  document: JSON.parse(row.document),
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
});
const ACTIVE = "('awaiting_signature','signing','signed','submitted')";

/** `?wallet=` lists the airdrops a wallet created; `?airdrop=` lists every step of one airdrop. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view airdrops.' }, 401);
  const params = new URL(request.url).searchParams,
    airdrop = params.get('airdrop');
  let wallet = '';
  try {
    if (airdrop === null)
      wallet = walletAddress(params.get('wallet'), 'Solana');
    else if (!UUID.test(airdrop)) throw new Error();
  } catch {
    return json({ error: 'Choose a valid wallet or airdrop.' }, 400);
  }
  try {
    const db = getD1();
    const result =
      airdrop === null
        ? await db
            .prepare(
              select +
                " WHERE owner_id=? AND wallet_address=? AND kind='create' ORDER BY created_at DESC,id DESC LIMIT 10",
            )
            .bind(user.userId, wallet)
            .all<Row>()
        : await db
            .prepare(
              select +
                ' WHERE owner_id=? AND airdrop_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
            )
            .bind(user.userId, airdrop)
            .all<Row>();
    return json({
      actions: await Promise.all(
        result.results.map((row) => validatedAirdropAction(parse(row))),
      ),
    });
  } catch {
    return json({ error: 'Airdrop history unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review airdrops.' }, 401);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 8192);
    if (
      ![
        'prepare_create',
        'prepare_claim',
        'prepare_clawback',
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
    return json({ error: 'Invalid airdrop request.' }, 400);
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
    if (String(body.action).startsWith('prepare_')) {
      let input: AirdropPrepareInput;
      try {
        if (body.action === 'prepare_create')
          input = {
            kind: 'create',
            ...airdropCreateInput({
              wallet: body.wallet,
              walletRevision: body.walletRevision,
              mint: body.mint,
              percent: body.percent,
              recipients: body.recipients,
              acknowledgeAirdrop: body.acknowledgeAirdrop,
            }),
          };
        else {
          if (typeof body.airdropId !== 'string' || !UUID.test(body.airdropId))
            throw new Error('Choose a created airdrop.');
          if (
            !Number.isSafeInteger(body.walletRevision) ||
            Number(body.walletRevision) < 1
          )
            throw new Error('Choose the current wallet revision.');
          const stored = await db
            .prepare(
              select +
                " WHERE owner_id=? AND id=? AND kind='create' AND state='finalized'",
            )
            .bind(user.userId, body.airdropId)
            .first<Row>();
          if (!stored)
            throw new Error(
              'That airdrop is not finalized yet. Recover its create step first.',
            );
          input = {
            kind: body.action === 'prepare_claim' ? 'claim' : 'clawback',
            wallet: walletAddress(body.wallet, 'Solana'),
            walletRevision: Number(body.walletRevision),
            parent: (await validatedAirdropAction(parse(stored))).document,
          };
        }
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error && error.message
                ? error.message
                : 'Invalid airdrop terms.',
          },
          400,
        );
      }
      if (!(await currentWallet(input.wallet, input.walletRevision)))
        return json(
          { error: 'Wallet changed or is archived. Reload the roster.' },
          409,
        );
      if (input.kind === 'create')
        for (const recipient of input.recipients)
          if (
            !(await db
              .prepare(
                "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
              )
              .bind(user.userId, recipient)
              .first())
          )
            return json(
              {
                error:
                  'Every output wallet must be a current wallet in this workspace, because each one signs its own claim.',
              },
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
            `SELECT id FROM token_airdrop_actions WHERE owner_id=? AND wallet_address=? AND state IN ${ACTIVE}`,
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
      const document = await prepareAirdrop(input, signal);
      phase = 'storage';
      const retained = await db
        .prepare(
          "INSERT INTO token_airdrop_actions (id,owner_id,wallet_address,wallet_revision,kind,airdrop_id,mint,document,state,signature,receipt,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'awaiting_signature',NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) AND ?>? RETURNING id",
        )
        .bind(
          document.id,
          user.userId,
          document.wallet,
          document.walletRevision,
          document.kind,
          document.terms.airdropId,
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
          airdropId: document.terms.airdropId,
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
      return json({ error: 'Choose a saved airdrop step.' }, 400);
    const read = () =>
      db
        .prepare(select + ' WHERE owner_id=? AND id=?')
        .bind(user.userId, body.id as string)
        .first<Row>();
    const stored = await read();
    if (!stored) return json({ error: 'Airdrop step unavailable.' }, 404);
    const row = parse(stored),
      review = row.document;
    if (
      review.id !== row.id ||
      review.wallet !== row.wallet ||
      review.walletRevision !== row.walletRevision ||
      review.kind !== row.kind ||
      review.mint !== row.mint ||
      review.terms?.airdropId !== row.airdropId
    )
      throw new Error();
    await inspectAirdrop(review, review.transaction, false);
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
          "UPDATE token_airdrop_actions SET state='signing',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=token_airdrop_actions.owner_id AND w.chain='Solana' AND w.address=token_airdrop_actions.wallet_address AND w.revision=token_airdrop_actions.wallet_revision AND w.archived=0) AND ?>? RETURNING id",
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
          "UPDATE token_airdrop_actions SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
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
          "UPDATE token_airdrop_actions SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature'",
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
      const outcome = () =>
        rpc('getTransaction', [
          row.signature,
          {
            encoding: 'base64',
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          },
        ]);
      let raw = await outcome();
      if (raw === null) {
        // Once finalized block height has passed the packet's last valid height it can never land.
        const height = BigInt(
          (await rpc('getBlockHeight', [{ commitment: 'finalized' }])) as
            | number
            | string,
        );
        if (height > BigInt(review.lastValidBlockHeight)) raw = await outcome();
        else
          return json(
            {
              error:
                'Finalized outcome unavailable. Keep this signature reserved; do not resend.',
            },
            409,
          );
        if (raw === null) {
          phase = 'storage';
          await db
            .prepare(
              "UPDATE token_airdrop_actions SET state='failed',updated_at=? WHERE owner_id=? AND id=? AND signature=? AND state IN ('signed','submitted')",
            )
            .bind(new Date().toISOString(), user.userId, row.id, row.signature)
            .run();
          const expired = await read();
          if (!expired) throw new Error();
          return json({ action: parse(expired) });
        }
      }
      const receipt = await decodeAirdropReceipt(raw, review, row.signature);
      phase = 'storage';
      await db
        .prepare(
          "UPDATE token_airdrop_actions SET state=?,receipt=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND state IN ('signed','submitted')",
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
      const signed = await inspectAirdrop(review, body.transaction, true);
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
          { error: 'Airdrop state does not permit this action.' },
          409,
        );
      if (body.action === 'register')
        await db
          .prepare(
            "UPDATE token_airdrop_actions SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
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
        await recheckAirdrop(review, signal);
        phase = 'storage';
        const armed = await db
          .prepare(
            "UPDATE token_airdrop_actions SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=token_airdrop_actions.owner_id AND w.chain='Solana' AND w.address=token_airdrop_actions.wallet_address AND w.revision=token_airdrop_actions.wallet_revision AND w.archived=0) AND ?>? RETURNING id",
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
      /Wallet already reserved|Wallet reserved by|Wallet held by|Signature already registered|UNIQUE constraint/.test(
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
              ? 'Airdrop checks unavailable. No automatic signing, replacement or retry.'
              : 'Airdrop history could not be saved. Reload its retained state before continuing.',
      },
      phase === 'storage' ? 503 : 502,
    );
  }
}
