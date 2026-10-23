import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { address, isOffCurveAddress } from '@solana/kit';
import {
  MeteoraDbcError,
  type MeteoraDbcTerms,
} from '@/lib/meteora-dbc-launch-service';
import {
  StonkLaunchError,
  stonkLaunchStatus,
} from '@/lib/stonkfun-launch-service';
import {
  actVenueLaunchRecovery,
  listVenueLaunchRecoveries,
  prepareVenueLaunchRecovery,
  readVenueLaunchRecovery,
  VenueLaunchRecoveryError,
} from '@/lib/venue-launch-recovery';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const TERM_KEYS = [
  'config',
  'devBuyRaw',
  'mint',
  'payer',
  'payerRevision',
  'projectId',
  'releaseId',
  'solLimitLamports',
  'updatedAt',
];

function terms(v: unknown, origin: string): MeteoraDbcTerms | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  try {
    if (
      Object.keys(b).sort().join(',') !== TERM_KEYS.join(',') ||
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
      typeof b.devBuyRaw !== 'string' ||
      !/^(0|[1-9]\d{0,18})$/.test(b.devBuyRaw) ||
      typeof b.solLimitLamports !== 'string' ||
      !/^[1-9]\d{0,9}$/.test(b.solLimitLamports) ||
      typeof b.config !== 'string' ||
      isOffCurveAddress(address(b.payer)) ||
      isOffCurveAddress(address(b.mint)) ||
      address(b.config) === b.mint ||
      b.payer === b.mint
    )
      return null;
  } catch {
    return null;
  }
  return { ...(b as Omit<MeteoraDbcTerms, 'origin'>), origin };
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 12288) {
        await reader.cancel();
        return 'too-large' as const;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to check a launch.' }, 401);
  const signature = new URL(request.url).searchParams.get('signature') ?? '';
  try {
    const params = new URL(request.url).searchParams;
    if (params.has('id'))
      return json(
        await readVenueLaunchRecovery(
          getD1(),
          user.userId,
          'meteora-dbc',
          params.get('id')!,
        ),
      );
    if (params.has('projectId'))
      return json(
        await listVenueLaunchRecoveries(
          getD1(),
          user.userId,
          'meteora-dbc',
          params.get('projectId')!,
        ),
      );
    return json(
      await stonkLaunchStatus(
        signature,
        AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      ),
    );
  } catch (error) {
    // The confirmation lookup is venue-independent and shared with StonkFun.
    if (
      error instanceof StonkLaunchError ||
      error instanceof VenueLaunchRecoveryError
    )
      return json({ error: error.message }, error.status);
    return json({ error: 'Launch status is unavailable.' }, 503);
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
  const b = await readBody(request);
  if (b === 'too-large') return json({ error: 'Request too large.' }, 413);
  if (!b) return json({ error: 'Invalid launch request.' }, 400);
  if (b.action !== 'prepare') {
    try {
      return json(
        await actVenueLaunchRecovery(
          getD1(),
          user.userId,
          'meteora-dbc',
          b,
          AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
        ),
      );
    } catch (error) {
      if (
        error instanceof VenueLaunchRecoveryError ||
        error instanceof MeteoraDbcError
      )
        return json({ error: error.message }, error.status);
      return json(
        {
          error:
            'Saved launch action did not complete. Recover the original launch ID before trying again.',
        },
        502,
      );
    }
  }
  const t = terms(b.terms, origin);
  if (!t)
    return json(
      {
        error:
          'Review the exact saved project, release, payer, mint, DBC config, creator buy and SOL limit.',
      },
      400,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  try {
    if (b.action === 'prepare' && Object.keys(b).length === 2)
      return json(
        await prepareVenueLaunchRecovery(
          getD1(),
          user.userId,
          'meteora-dbc',
          t,
          signal,
        ),
      );
    return json({ error: 'Invalid launch action.' }, 400);
  } catch (error) {
    if (
      error instanceof MeteoraDbcError ||
      error instanceof VenueLaunchRecoveryError
    )
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Launch response is uncertain. Reload saved launch history and recover the original ID before another action.',
      },
      502,
    );
  }
}
