import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  getSolanaRpcEndpoint,
  rpcCall,
  requireConsistentSolanaSlots,
} from '@/lib/solana-rpc';
import { validateSolanaTrackedWallet as validateTrackedWallet } from '@/lib/tracked-wallet';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to inspect tracked wallets.' }, 401);
  let wallet;
  try {
    const params = new URL(request.url).searchParams;
    wallet = validateTrackedWallet({
      address: params.get('address'),
      network: params.get('network'),
      label: '',
    });
  } catch {
    return json({ error: 'Invalid Solana wallet or network.' }, 400);
  }
  try {
    const owned = await getD1()
      .prepare(
        `SELECT address FROM tracked_wallets WHERE owner_id = ? AND address = ? AND network = ? AND archived = 0`,
      )
      .bind(user.userId, wallet.address, wallet.network)
      .first();
    if (!owned)
      return json(
        { error: 'Save this address to your active tracker first.' },
        404,
      );
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
  try {
    const endpoint = getSolanaRpcEndpoint(wallet.network);
    const balance = await rpcCall<{ context: { slot: number }; value: number }>(
      endpoint,
      'getBalance',
      [wallet.address, { commitment: 'confirmed' }],
    );
    const slot = requireConsistentSolanaSlots([balance.context.slot]);
    if (!Number.isSafeInteger(balance.value) || balance.value < 0)
      throw new Error('Invalid balance');
    const signatures = await rpcCall<
      Array<{
        signature: string;
        slot: number;
        blockTime: number | null;
        err: unknown;
      }>
    >(endpoint, 'getSignaturesForAddress', [
      wallet.address,
      { commitment: 'confirmed', limit: 12, minContextSlot: slot },
    ]);
    if (
      !Array.isArray(signatures) ||
      signatures.some(
        (s) =>
          !s ||
          typeof s.signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.signature) ||
          !Number.isSafeInteger(s.slot) ||
          s.slot < 0 ||
          s.err === undefined ||
          !(
            s.blockTime === null ||
            (Number.isSafeInteger(s.blockTime) && s.blockTime >= 0)
          ),
      )
    )
      throw new Error('Invalid signatures');
    return json({
      observation: {
        address: wallet.address,
        network: wallet.network,
        observedAt: new Date().toISOString(),
        slot,
        balanceSol: balance.value / 1_000_000_000,
        signatures: signatures.map((s) => ({
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime,
          failed: s.err !== null,
        })),
      },
      limitations:
        'Latest 12 signature records only. No transaction decoding, trade attribution, USD valuation or streaming.',
    });
  } catch {
    return json(
      { error: 'Solana RPC observation unavailable. Try refreshing later.' },
      502,
    );
  }
}
