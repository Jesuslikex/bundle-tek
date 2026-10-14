import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { address, isOffCurveAddress } from '@solana/kit';
import {
  PumpPreflightError,
  type OwnedPumpTerms,
} from '@/lib/owned-pump-preflight';
import {
  preparePumpInitialBuyReview,
  actPumpInitialBuyReview,
  listPumpInitialBuyReviews,
} from '@/lib/pump-initial-buy-review';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read launch reviews.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || projectId.length > 128)
    return json({ error: 'Choose a project.' }, 400);
  try {
    return json({
      launches: await listPumpInitialBuyReviews(
        getD1(),
        user.userId,
        projectId,
      ),
    });
  } catch {
    return json({ error: 'Launch history is unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review a launch.' }, 401);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin)
    return json({ error: 'Use this site to review the launch.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Launch request required.' }, 400);
  let b: Record<string, unknown>;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        return json({ error: 'Request too large.' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    b = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
  } catch {
    return json({ error: 'Invalid launch request.' }, 400);
  } finally {
    reader.releaseLock();
  }
  try {
    const db = getD1();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(45000),
    ]);
    if (b.action === 'prepare') {
      if (
        Object.keys(b).sort().join(',') !==
          'action,feeAndRentLimitRaw,maximumQuoteCostRaw,mint,payer,payerRevision,projectId,releaseId,updatedAt' ||
        typeof b.maximumQuoteCostRaw !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(b.maximumQuoteCostRaw) ||
        BigInt(b.maximumQuoteCostRaw) > (1n << 64n) - 1n ||
        typeof b.projectId !== 'string' ||
        !b.projectId ||
        b.projectId.length > 128 ||
        typeof b.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(b.updatedAt)) ||
        typeof b.releaseId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(b.releaseId) ||
        typeof b.payer !== 'string' ||
        typeof b.mint !== 'string' ||
        !Number.isSafeInteger(b.payerRevision) ||
        Number(b.payerRevision) < 1 ||
        typeof b.feeAndRentLimitRaw !== 'string' ||
        !/^[1-9]\d{0,9}$/.test(b.feeAndRentLimitRaw) ||
        BigInt(b.feeAndRentLimitRaw) > 1000000000n ||
        isOffCurveAddress(address(b.payer)) ||
        isOffCurveAddress(address(b.mint)) ||
        b.payer === b.mint
      )
        return json(
          {
            error:
              'Review the exact saved project, release, payer, mint and SOL allowance.',
          },
          400,
        );
      const { action: _action, ...values } = b;
      return json(
        await preparePumpInitialBuyReview(
          db,
          user.userId,
          { ...values, origin } as OwnedPumpTerms & {
            maximumQuoteCostRaw: string;
          },
          signal,
        ),
      );
    }
    if (
      !['approve', 'register', 'submit', 'recover', 'cancel'].includes(
        String(b.action),
      ) ||
      typeof b.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(b.id)
    )
      return json({ error: 'Invalid launch action.' }, 400);
    const allowed =
      b.action === 'register'
        ? ['action', 'id', 'transaction']
        : ['approve', 'submit'].includes(String(b.action))
          ? [
              'action',
              'id',
              'sha256',
              'approved',
              'approvedScope',
              'acknowledgeSimulationLimits',
            ]
          : ['action', 'id'];
    if (Object.keys(b).sort().join(',') !== allowed.sort().join(','))
      return json({ error: 'Unexpected launch fields.' }, 400);
    return json(
      await actPumpInitialBuyReview(
        db,
        user.userId,
        b.id,
        b.action as 'approve' | 'register' | 'submit' | 'recover' | 'cancel',
        b as {
          sha256?: string;
          transaction?: string;
          approved?: boolean;
          approvedScope?: string;
          acknowledgeSimulationLimits?: boolean;
        },
        signal,
      ),
    );
  } catch (error) {
    if (error instanceof PumpPreflightError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Launch action did not complete. Reload its saved history before retrying. No new approval should be assumed.',
      },
      502,
    );
  }
}
