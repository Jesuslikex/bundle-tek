import {
  prepareNativeWithdrawal,
  recheckNativeWithdrawal,
  decodeNativeWithdrawalReceipt,
} from '@/lib/native-withdrawal-server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { walletAddress } from '@/lib/wallet-workspace';
import { UUID } from '@/lib/wallet-operation';
import {
  WITHDRAWAL_OWNER_SCOPE_HEADER,
  withdrawalOwnerScope,
} from '@/lib/native-withdrawal-owner-scope';
import {
  withdrawalInput,
  inspectNativeWithdrawal,
  type NativeWithdrawal,
  validatedNativeWithdrawal,
} from '@/lib/native-withdrawal';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import {
  prepareTokenWithdrawal,
  recheckTokenWithdrawal,
  decodeTokenWithdrawalReceipt,
} from '@/lib/token-withdrawal-server';
import { tokenWithdrawalInput } from '@/lib/native-withdrawal';
import { fundingSelection, type FundingSelection } from '@/lib/mainnet-funding';
import {
  captureOwnedFunding,
  currentFundingGuard,
  fundingWriteGuard,
  fundingHistoryScope,
} from '@/lib/mainnet-funding-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const select =
  'SELECT id,wallet_address AS wallet,wallet_revision AS walletRevision,state,signature,document,receipt,failure_receipt AS failureReceipt,created_at AS createdAt,updated_at AS updatedAt FROM native_withdrawals';
type Row = Omit<NativeWithdrawal, 'document' | 'receipt' | 'failureReceipt'> & {
  document: string;
  receipt: string | null;
  failureReceipt: string | null;
};
const parse = (row: Row): NativeWithdrawal => ({
  ...row,
  document: JSON.parse(row.document),
  receipt: row.receipt ? JSON.parse(row.receipt) : null,
  failureReceipt: row.failureReceipt ? JSON.parse(row.failureReceipt) : null,
});
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view withdrawals.' }, 401);
  let ownerScope: string;
  try {
    ownerScope = await withdrawalOwnerScope(user.userId);
  } catch {
    return json({ error: 'Withdrawal account scope unavailable.' }, 503);
  }
  const scopedJson = (value: unknown, status = 200) => {
    const response = json(value, status);
    response.headers.set(WITHDRAWAL_OWNER_SCOPE_HEADER, ownerScope);
    return response;
  };
  const expectedScope = request.headers.get(WITHDRAWAL_OWNER_SCOPE_HEADER);
  if (expectedScope !== null && expectedScope !== ownerScope)
    return scopedJson({ error: 'Signed-in account changed.' }, 409);
  const params = new URL(request.url).searchParams,
    cursor = params.get('cursor'),
    exactId = params.get('withdrawalId');
  let wallet: string;
  let funding: FundingSelection | undefined;
  try {
    wallet = walletAddress(params.get('wallet'), 'Solana');
    if (cursor !== null && !UUID.test(cursor)) throw new Error();
    if (
      exactId !== null &&
      (!UUID.test(exactId) ||
        cursor !== null ||
        expectedScope === null ||
        ['wallet', 'withdrawalId', 'planId', 'revision', 'item', 'leg'].some(
          (key) => params.getAll(key).length > 1,
        ) ||
        (params.has('leg') && !params.has('planId')))
    )
      throw new Error();
    if (params.has('planId') || params.has('revision') || params.has('item'))
      funding = fundingSelection({
        planId: params.get('planId'),
        revision: Number(params.get('revision')),
        item: Number(params.get('item')),
        ...(params.has('leg') ? { leg: Number(params.get('leg')) } : {}),
      });
  } catch {
    return scopedJson(
      { error: 'Choose a valid withdrawal wallet and cursor.' },
      400,
    );
  }
  try {
    const scope = fundingHistoryScope(funding);
    const db = getD1();
    if (exactId) {
      const exact = await db
        .prepare(
          select +
            ' WHERE owner_id=? AND wallet_address=? AND id=?' +
            scope.sql,
        )
        .bind(user.userId, wallet, exactId, ...scope.bindings)
        .first<Row>();
      if (!exact) return scopedJson({ error: 'Withdrawal unavailable.' }, 404);
      return scopedJson({
        withdrawal: await validatedNativeWithdrawal(parse(exact)),
      });
    }
    const anchor = cursor
      ? await db
          .prepare(
            select +
              ' WHERE owner_id=? AND wallet_address=? AND id=?' +
              scope.sql,
          )
          .bind(user.userId, wallet, cursor, ...scope.bindings)
          .first<Row>()
      : null;
    if (cursor && !anchor)
      return scopedJson({ error: 'Withdrawal cursor unavailable.' }, 400);
    const result = await db
      .prepare(
        select +
          ' WHERE owner_id=? AND wallet_address=?' +
          scope.sql +
          ' AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 51',
      )
      .bind(
        user.userId,
        wallet,
        ...scope.bindings,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.id ?? '',
      )
      .all<Row>();
    const active = await db
      .prepare(
        select +
          " WHERE owner_id=? AND wallet_address=? AND state IN ('awaiting_signature','signing','signed','submitted')" +
          scope.sql +
          ' LIMIT 1',
      )
      .bind(user.userId, wallet, ...scope.bindings)
      .first<Row>();
    const rows = await Promise.all(
      result.results
        .slice(0, 50)
        .map((row) => validatedNativeWithdrawal(parse(row))),
    );
    return scopedJson({
      withdrawals: rows,
      active: active ? await validatedNativeWithdrawal(parse(active)) : null,
      nextCursor: result.results.length > 50 ? rows.at(-1)!.id : null,
    });
  } catch {
    return scopedJson({ error: 'Withdrawal history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review withdrawals.' }, 401);
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
    if (body.funding !== undefined) {
      if (body.action !== 'prepare') throw new Error();
      fundingSelection(body.funding);
    }
  } catch {
    return json({ error: 'Invalid withdrawal request.' }, 400);
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
      let input:
        | ReturnType<typeof withdrawalInput>
        | ReturnType<typeof tokenWithdrawalInput>;
      let tokenInput: ReturnType<typeof tokenWithdrawalInput> | undefined;
      try {
        tokenInput =
          body.mint !== undefined
            ? tokenWithdrawalInput(
                body.wallet,
                body.recipient,
                body.amount,
                body.walletRevision,
                body.mint,
                body.decimals,
              )
            : undefined;
        input =
          tokenInput ??
          withdrawalInput(
            body.wallet,
            body.recipient,
            body.amount,
            body.walletRevision,
          );
      } catch {
        return json(
          {
            error:
              'Choose a current wallet, different recipient and exact positive asset amount with valid token precision.',
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
        await db
          .prepare(
            'SELECT intent_id FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .bind(user.userId, input.wallet)
          .first()
      )
        return json(
          {
            error:
              'This wallet has a retained approval. Cancel its unsigned review or recover its registered signature first.',
          },
          409,
        );
      phase = 'funding';
      const selectedFunding =
        body.funding === undefined ? undefined : fundingSelection(body.funding);
      const fundingGuard = selectedFunding
        ? await captureOwnedFunding(
            db,
            user.userId,
            selectedFunding,
            tokenInput
              ? {
                  ...input,
                  token: {
                    mint: tokenInput.mint,
                    decimals: tokenInput.decimals,
                  },
                }
              : input,
          )
        : undefined;
      const fundingWrite = fundingWriteGuard(user.userId, fundingGuard);
      const duplicateScope = fundingHistoryScope(selectedFunding);
      const duplicateSql = selectedFunding
        ? ` AND NOT EXISTS(SELECT 1 FROM native_withdrawals WHERE owner_id=?${duplicateScope.sql} AND (state NOT IN ('cancelled','failed') OR (state='failed' AND failure_receipt IS NULL)))`
        : '';
      const duplicateBindings = selectedFunding
        ? [user.userId, ...duplicateScope.bindings]
        : [];
      if (
        selectedFunding &&
        (await db
          .prepare(
            'SELECT id FROM native_withdrawals WHERE owner_id=?' +
              duplicateScope.sql +
              " AND (state NOT IN ('cancelled','failed') OR (state='failed' AND failure_receipt IS NULL)) LIMIT 1",
          )
          .bind(...duplicateBindings)
          .first())
      )
        return json(
          {
            error:
              'This saved funding recipient already has a retained transfer. Reload its history and recover the existing signature.',
          },
          409,
        );
      const legBefore =
        fundingGuard?.capture.leg !== undefined && fundingGuard.capture.leg > 1
          ? fundingHistoryScope({
              ...fundingGuard.capture,
              leg: fundingGuard.capture.leg - 1,
            })
          : undefined;
      if (
        legBefore &&
        !(await db
          .prepare(
            "SELECT 1 FROM native_withdrawals WHERE owner_id=? AND state='finalized'" +
              legBefore.sql,
          )
          .bind(user.userId, ...legBefore.bindings)
          .first())
      )
        return json(
          {
            error:
              'Finalize the previous proxy leg for this recipient before preparing the next one.',
          },
          409,
        );
      phase = 'provider';
      const document = tokenInput
        ? await prepareTokenWithdrawal(tokenInput, signal)
        : await prepareNativeWithdrawal(input, signal);
      if (fundingGuard) document.funding = fundingGuard.capture;
      phase = 'storage';
      if (!(await currentWallet(input.wallet, input.walletRevision)))
        return json(
          { error: 'Wallet changed during preparation. Reload the roster.' },
          409,
        );
      const retained = await db
        .prepare(
          "INSERT INTO native_withdrawals (id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) SELECT ?,?,?,?,?,'awaiting_signature',NULL,NULL,?,? WHERE EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0) AND ?>?" +
            fundingWrite.sql +
            duplicateSql +
            ' RETURNING id',
        )
        .bind(
          document.id,
          user.userId,
          document.wallet,
          document.walletRevision,
          JSON.stringify(document),
          now,
          now,
          user.userId,
          input.wallet,
          input.walletRevision,
          Date.parse(document.expiresAt),
          Date.now(),
          ...fundingWrite.bindings,
          ...duplicateBindings,
        )
        .first<{ id: string }>();
      if (!retained)
        return json(
          {
            error:
              'Wallet or preparation changed before retention. Reload the roster.',
          },
          409,
        );
      return json({
        withdrawal: {
          id: document.id,
          wallet: document.wallet,
          walletRevision: document.walletRevision,
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
      return json({ error: 'Choose a saved withdrawal.' }, 400);
    const read = () =>
      db
        .prepare(select + ' WHERE owner_id=? AND id=?')
        .bind(user.userId, body.id as string)
        .first<Row>();
    const stored = await read();
    if (!stored) return json({ error: 'Withdrawal unavailable.' }, 404);
    const row = parse(stored),
      review = row.document;
    if (
      review.id !== row.id ||
      review.wallet !== row.wallet ||
      review.walletRevision !== row.walletRevision
    )
      throw new Error();
    await inspectNativeWithdrawal(review, review.transaction, false);
    if (body.action === 'begin_signing') {
      if (
        row.state !== 'awaiting_signature' ||
        Date.parse(review.expiresAt) <= Date.now() ||
        !(await currentWallet(row.wallet, row.walletRevision))
      )
        return json(
          { error: 'Current unsigned withdrawal required before signing.' },
          409,
        );
      phase = 'funding';
      const fundingWrite = fundingWriteGuard(
        user.userId,
        await currentFundingGuard(db, user.userId, review),
      );
      phase = 'storage';
      const claimed = await db
        .prepare(
          "UPDATE native_withdrawals SET state='signing',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=native_withdrawals.owner_id AND w.chain='Solana' AND w.address=native_withdrawals.wallet_address AND w.revision=native_withdrawals.wallet_revision AND w.archived=0) AND EXISTS(SELECT 1 FROM solana_execution_reservations r WHERE r.owner_id=native_withdrawals.owner_id AND r.wallet_address=native_withdrawals.wallet_address AND r.scope='withdrawal' AND r.intent_id=native_withdrawals.id AND r.state='awaiting_signature') AND ?>?" +
            fundingWrite.sql +
            ' RETURNING id',
        )
        .bind(
          now,
          user.userId,
          row.id,
          Date.parse(review.expiresAt),
          Date.now(),
          ...fundingWrite.bindings,
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
              'Verify that no signature was produced before releasing a signing reservation.',
          },
          409,
        );
      await db
        .prepare(
          "UPDATE native_withdrawals SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
        )
        .bind(now, user.userId, row.id)
        .run();
    } else if (body.action === 'cancel') {
      if (row.state !== 'awaiting_signature')
        return json(
          {
            error:
              'Only an unsigned withdrawal can be cancelled. Recover registered signatures.',
          },
          409,
        );
      await db
        .prepare(
          "UPDATE native_withdrawals SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature'",
        )
        .bind(now, user.userId, row.id)
        .run();
    } else if (body.action === 'recover') {
      if (
        !row.signature ||
        !['signed', 'submitted', 'finalized', 'failed'].includes(row.state)
      )
        return json(
          { error: 'No registered withdrawal signature to recover.' },
          409,
        );
      if (
        row.state === 'finalized' ||
        (row.state === 'failed' && row.failureReceipt)
      )
        return json({ withdrawal: row });
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
      const receipt = await (
        review.token
          ? decodeTokenWithdrawalReceipt
          : decodeNativeWithdrawalReceipt
      )(raw, review, row.signature);
      const failed = 'failed' in receipt;
      if (row.state === 'failed' && !failed)
        throw new Error('Retained failure outcome differs.');
      const outcomeRecordedAt = new Date().toISOString();
      phase = 'storage';
      await db
        .prepare(
          "UPDATE native_withdrawals SET state=?,receipt=?,failure_receipt=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND (state IN ('signed','submitted') OR (state='failed' AND failure_receipt IS NULL))",
        )
        .bind(
          failed ? 'failed' : 'finalized',
          failed ? null : JSON.stringify(receipt),
          failed ? JSON.stringify(receipt) : null,
          outcomeRecordedAt,
          user.userId,
          row.id,
          row.signature,
        )
        .run();
    } else {
      if (typeof body.transaction !== 'string')
        return json({ error: 'Exact signed withdrawal packet required.' }, 400);
      const signed = await inspectNativeWithdrawal(
        review,
        body.transaction,
        true,
      );
      if (
        body.action === 'register' &&
        row.state === 'signed' &&
        row.signature === signed.signature
      )
        return json({ withdrawal: row });
      if (
        (body.action === 'register' && row.state !== 'signing') ||
        (body.action === 'submit' &&
          (row.state !== 'signed' || row.signature !== signed.signature))
      )
        return json(
          { error: 'Withdrawal state does not permit this action.' },
          409,
        );
      if (
        body.action === 'submit' &&
        (Date.parse(review.expiresAt) <= Date.now() ||
          !(await currentWallet(row.wallet, row.walletRevision)))
      )
        return json(
          {
            error:
              'Wallet or withdrawal approval changed or expired. No automatic replacement.',
          },
          409,
        );
      if (body.action === 'register')
        await db
          .prepare(
            "UPDATE native_withdrawals SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='signing' AND signature IS NULL",
          )
          .bind(signed.signature, now, user.userId, row.id)
          .run();
      else {
        phase = 'funding';
        await currentFundingGuard(db, user.userId, review);
        phase = 'provider';
        await (review.token ? recheckTokenWithdrawal : recheckNativeWithdrawal)(
          review,
          signal,
        );
        phase = 'storage';
        if (!(await currentWallet(row.wallet, row.walletRevision)))
          return json({ error: 'Wallet changed before submission.' }, 409);
        phase = 'funding';
        const fundingWrite = fundingWriteGuard(
          user.userId,
          await currentFundingGuard(db, user.userId, review),
        );
        phase = 'storage';
        const armed = await db
          .prepare(
            "UPDATE native_withdrawals SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=native_withdrawals.owner_id AND w.chain='Solana' AND w.address=native_withdrawals.wallet_address AND w.revision=native_withdrawals.wallet_revision AND w.archived=0) AND EXISTS(SELECT 1 FROM solana_execution_reservations r WHERE r.owner_id=native_withdrawals.owner_id AND r.wallet_address=native_withdrawals.wallet_address AND r.scope='withdrawal' AND r.intent_id=native_withdrawals.id AND r.state='signed') AND ?>?" +
              fundingWrite.sql +
              ' RETURNING id',
          )
          .bind(
            now,
            user.userId,
            row.id,
            row.signature,
            Date.parse(review.expiresAt),
            Date.now(),
            ...fundingWrite.bindings,
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
    return json({ withdrawal: parse(latest) });
  } catch (error) {
    if (phase === 'funding')
      return json(
        {
          error:
            'Saved funding draft changed, is not due or differs from this transfer. Recover any retained signature.',
        },
        409,
      );
    if (
      error instanceof Error &&
      /Wallet already reserved|Signature already registered/.test(error.message)
    )
      return json(
        {
          error:
            'Wallet or signature is already reserved. Reload saved approvals.',
        },
        409,
      );
    return json(
      {
        error:
          phase === 'send'
            ? 'Withdrawal submission outcome is unknown. The signature remains reserved; recover it without resending.'
            : phase === 'provider'
              ? 'Withdrawal checks or finalized receipt unavailable. No automatic signing, replacement or retry.'
              : 'Withdrawal history could not be saved. Reload its retained state before continuing.',
      },
      phase === 'storage' ? 503 : 502,
    );
  }
}
