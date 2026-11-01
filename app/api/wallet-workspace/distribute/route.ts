import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  distributionRequest,
  distributionRpc,
  distributionStatuses,
  prepareDistribution,
  submitDistribution,
} from '@/lib/sol-distribution-server';
import {
  batchSigners,
  isSolanaAddress,
  validateBatch,
  type DistributionBatch,
} from '@/lib/sol-distribution';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

/** Every address must be one of this owner's current Solana workspace wallets. */
async function ownsAll(ownerId: string, addresses: string[]) {
  const unique = [...new Set(addresses)];
  const owned = new Set<string>();
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    const rows = await getD1()
      .prepare(
        `SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (${part.map(() => '?').join(',')})`,
      )
      .bind(ownerId, ...part)
      .all<{ address: string }>();
    for (const row of rows.results) owned.add(row.address);
  }
  return unique.every((a) => owned.has(a));
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to move SOL between wallets.' }, 401);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 65536);
    if (!['prepare', 'submit', 'status'].includes(String(body.action)))
      throw new Error();
  } catch {
    return json({ error: 'Invalid distribution request.' }, 400);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
  const rpc = distributionRpc(signal);
  try {
    if (body.action === 'status') {
      const signatures = body.signatures;
      if (
        !Array.isArray(signatures) ||
        !signatures.length ||
        signatures.length > 20 ||
        !signatures.every(
          (s) =>
            typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s),
        )
      )
        return json({ error: 'Invalid signatures.' }, 400);
      return json({
        statuses: await distributionStatuses(signatures as string[], rpc),
      });
    }
    if (body.action === 'prepare') {
      let input;
      try {
        input = distributionRequest(body);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
      const addresses =
        input.mode === 'fund'
          ? [input.funder, ...input.transfers.map((t) => t.address)]
          : [input.funder, ...input.wallets];
      if (!(await ownsAll(user.userId, addresses)))
        return json({ error: 'Use only your own saved Solana wallets.' }, 403);
      return json({ prepared: await prepareDistribution(input, rpc) });
    }
    const batch = body.batch as DistributionBatch;
    try {
      validateBatch(batch);
      if (
        typeof body.transaction !== 'string' ||
        body.transaction.length > 2000
      )
        throw new Error('Invalid transaction.');
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
    const clean: DistributionBatch = {
      mode: batch.mode,
      funder: batch.funder,
      blockhash: batch.blockhash,
      transfers: batch.transfers.map((t) => ({
        address: t.address,
        lamports: t.lamports,
      })),
    };
    if (
      !isSolanaAddress(clean.funder) ||
      !(await ownsAll(user.userId, [
        ...batchSigners(clean),
        ...clean.transfers.map((t) => t.address),
      ]))
    )
      return json({ error: 'Use only your own saved Solana wallets.' }, 403);
    return json({
      signature: await submitDistribution(clean, body.transaction, rpc),
    });
  } catch (err) {
    console.error('distribute', body.action, err);
    const message = err instanceof Error ? err.message : '';
    const known =
      /rent minimum|too low|no SOL|plain wallet|simulation|network fees|differs|invalid|not Solana mainnet/i.test(
        message,
      );
    return json(
      { error: known ? message : 'Solana RPC unavailable. Try again.' },
      known ? 409 : 503,
    );
  }
}
