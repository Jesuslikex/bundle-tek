import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { walletAddress } from '@/lib/wallet-workspace';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import {
  decodeCreatorFeeClaimReceipt,
  inspectCreatorFeeClaim,
  type CreatorFeeClaimReview,
} from '@/lib/pump-creator-fees';
import {
  claimQuoteMints,
  prepareCreatorFeeClaim,
  recheckCreatorFeeClaim,
  scanCreatorFees,
} from '@/lib/pump-creator-fees-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const ACTIONS = ['scan', 'prepare', 'submit', 'recover'];

// Pump.fun creator fee claims. Keys never reach the server: it scans vaults, builds and
// simulates one unsigned packet, and later sends the browser-signed packet exactly once.
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to claim creator fees.' }, 401);
  let body: Record<string, unknown>;
  let quotes: string[];
  try {
    body = await walletRequest(request, 16384);
    if (!ACTIONS.includes(String(body.action))) throw new Error();
    quotes = claimQuoteMints(body.quoteMint);
  } catch {
    return json({ error: 'Invalid creator fee request.' }, 400);
  }
  let phase = 'storage';
  try {
    const db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    const currentWallet = async (wallet: string, revision?: number) =>
      !!(await db
        .prepare(
          "SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND (? IS NULL OR revision=?) AND archived=0",
        )
        .bind(user.userId, wallet, revision ?? null, revision ?? null)
        .first());
    // A claim changes the wallet's balance, which would invalidate other retained approvals.
    const reserved = async (wallet: string) =>
      !!(await db
        .prepare(
          'SELECT intent_id FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
        )
        .bind(user.userId, wallet)
        .first());
    const busy = json(
      {
        error:
          'This wallet has a retained approval. Finish or cancel it before claiming creator fees.',
      },
      409,
    );
    if (body.action === 'scan' || body.action === 'prepare') {
      let wallet: string,
        revision: number | undefined,
        select: string[] = [];
      try {
        wallet = walletAddress(body.wallet, 'Solana');
        if (body.action === 'prepare') {
          revision = Number(body.walletRevision);
          if (
            !Number.isSafeInteger(revision) ||
            revision < 1 ||
            !Array.isArray(body.select) ||
            !body.select.length ||
            body.select.length > 6 ||
            body.select.some(
              (s) =>
                typeof s !== 'string' ||
                !/^(pump-sol|pump-token|amm-token):[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(
                  s,
                ),
            )
          )
            throw new Error();
          select = body.select as string[];
        }
      } catch {
        return json(
          {
            error: 'Choose a current wallet and up to six creator fee vaults.',
          },
          400,
        );
      }
      if (!(await currentWallet(wallet, revision)))
        return json(
          { error: 'Wallet changed or is archived. Reload the roster.' },
          409,
        );
      phase = 'provider';
      if (body.action === 'scan')
        return json({ scan: await scanCreatorFees(wallet, quotes, signal) });
      phase = 'storage';
      if (await reserved(wallet)) return busy;
      phase = 'provider';
      const review = await prepareCreatorFeeClaim(
        { wallet, walletRevision: revision!, select },
        quotes,
        signal,
      );
      return json({ review });
    }
    const review = body.review as CreatorFeeClaimReview;
    if (body.action === 'recover') {
      if (
        typeof body.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature)
      )
        return json({ error: 'Exact claim signature required.' }, 400);
      try {
        await inspectCreatorFeeClaim(review, review?.transaction, false);
      } catch {
        return json({ error: 'Creator fee review differs.' }, 400);
      }
      if (!(await currentWallet(review.wallet)))
        return json({ error: 'Wallet is not in your workspace.' }, 409);
      phase = 'provider';
      const endpoint = getSolanaRpcEndpoint('mainnet'),
        rpc = (method: string, params: unknown[]) =>
          balanceRpc(endpoint, method, params, signal, fetch);
      if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
        throw new Error();
      const raw = await rpc('getTransaction', [
        body.signature,
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
              'Finalized outcome unavailable yet. Check again; do not resend.',
          },
          409,
        );
      return json({
        receipt: await decodeCreatorFeeClaimReceipt(
          raw,
          review,
          body.signature,
          new URL(endpoint).hostname,
        ),
      });
    }
    // submit: exactly one send of the browser-signed reviewed packet.
    let signature: string;
    try {
      const signed = await inspectCreatorFeeClaim(
        review,
        body.transaction as string,
        true,
      );
      signature = signed.signature!;
    } catch {
      return json({ error: 'Exact signed creator fee packet required.' }, 400);
    }
    if (
      Date.parse(review.expiresAt) <= Date.now() ||
      !(await currentWallet(review.wallet, review.walletRevision))
    )
      return json(
        {
          error:
            'Wallet or claim approval changed or expired. Prepare a new claim.',
        },
        409,
      );
    if (await reserved(review.wallet)) return busy;
    phase = 'provider';
    await recheckCreatorFeeClaim(review, signal);
    phase = 'send';
    const sent = await balanceRpc(
      getSolanaRpcEndpoint('mainnet'),
      'sendTransaction',
      [
        body.transaction,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
          minContextSlot: review.slot,
        },
      ],
      signal,
      fetch,
    );
    if (sent !== signature) throw new Error();
    return json({ signature });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return json(
      {
        error:
          phase === 'send'
            ? 'Submission outcome is unknown. Check the signature before preparing another claim.'
            : phase === 'provider'
              ? /^(Creator fee|Selected creator|Too many vaults|WSOL receiving|Choose)/.test(
                  message,
                )
                ? message
                : 'Creator fee checks unavailable. Nothing was signed or sent.'
              : 'Workspace unavailable. Reload and try again.',
      },
      phase === 'storage' ? 503 : 502,
    );
  }
}
