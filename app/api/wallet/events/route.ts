import { ensurePulseSchema } from '@/db';
import { getSolanaRpcEndpoint, rpcCall } from '@/lib/solana-rpc';
import { assertSolanaAddress, SOLANA_SIGNATURE } from '@/lib/wallet-verification';

export const dynamic = 'force-dynamic';

type ParsedTransaction = {
  blockTime: number | null;
  meta: { err: unknown } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean } | string>; instructions: Array<{ programId?: string }> } };
};

export async function GET(request: Request) {
  try {
    const address = assertSolanaAddress(new URL(request.url).searchParams.get('address'));
    const db = await ensurePulseSchema();
    const rows = await db.prepare(`SELECT id, wallet_address AS walletAddress, network,
      event_type AS eventType, transaction_signature AS transactionSignature,
      details, created_at AS createdAt FROM wallet_audit_events
      WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 20`).bind(address).all();
    return Response.json({ events: rows.results }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to read wallet audit events' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { address?: unknown; signature?: unknown };
    const walletAddress = assertSolanaAddress(body.address);
    if (typeof body.signature !== 'string' || !SOLANA_SIGNATURE.test(body.signature)) throw new Error('Invalid transaction signature');
    const transaction = await rpcCall<ParsedTransaction | null>(getSolanaRpcEndpoint('devnet'), 'getTransaction', [body.signature, {
      commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
    }]);
    if (!transaction || transaction.meta?.err) return Response.json({ error: 'Confirmed devnet transaction not found' }, { status: 404 });
    const accountKeys = transaction.transaction.message.accountKeys;
    const walletSigned = accountKeys.some((key) => typeof key === 'string' ? key === walletAddress : key.pubkey === walletAddress && key.signer);
    const isMemo = transaction.transaction.message.instructions.some((instruction) => instruction.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    if (!walletSigned || !isMemo) return Response.json({ error: 'Transaction is not a signed PulseForge-compatible memo' }, { status: 400 });
    const db = await ensurePulseSchema();
    const createdAt = new Date().toISOString();
    await db.prepare(`INSERT OR IGNORE INTO wallet_audit_events
      (id, wallet_address, network, event_type, transaction_signature, details, created_at)
      VALUES (?, ?, 'devnet', 'memo_confirmed', ?, ?, ?)`)
      .bind(crypto.randomUUID(), walletAddress, body.signature, JSON.stringify({ blockTime: transaction.blockTime }), createdAt).run();
    return Response.json({ recorded: true, signature: body.signature, createdAt }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to record wallet event' }, { status: 400 });
  }
}
