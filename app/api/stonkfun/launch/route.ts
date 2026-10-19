import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { address, isOffCurveAddress } from '@solana/kit';
import {
  StonkLaunchError,
  prepareStonkLaunch,
  stonkLaunchStatus,
  submitStonkLaunch,
  type StonkLaunchTerms,
} from '@/lib/stonkfun-launch-service';
import type { StonkLaunchInput } from '@/lib/stonkfun-launch';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const TERM_KEYS = [
  'devBuyRaw',
  'mint',
  'payer',
  'payerRevision',
  'projectId',
  'releaseId',
  'solLimitLamports',
  'updatedAt',
];

function terms(v: unknown, origin: string): StonkLaunchTerms | null {
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
      isOffCurveAddress(address(b.payer)) ||
      isOffCurveAddress(address(b.mint)) ||
      b.payer === b.mint
    )
      return null;
  } catch {
    return null;
  }
  return { ...(b as Omit<StonkLaunchTerms, 'origin'>), origin };
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
    return json(
      await stonkLaunchStatus(
        signature,
        AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      ),
    );
  } catch (error) {
    if (error instanceof StonkLaunchError)
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
  const t = terms(b.terms, origin);
  if (!t)
    return json(
      {
        error:
          'Review the exact saved project, release, payer, mint, creator buy and SOL limit.',
      },
      400,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  try {
    if (b.action === 'prepare' && Object.keys(b).length === 2)
      return json(await prepareStonkLaunch(getD1(), user.userId, t, signal));
    if (
      b.action === 'submit' &&
      Object.keys(b).sort().join(',') === 'action,input,terms,transaction' &&
      b.input &&
      typeof b.input === 'object' &&
      typeof b.transaction === 'string'
    )
      return json(
        await submitStonkLaunch(
          getD1(),
          user.userId,
          t,
          b.input as StonkLaunchInput,
          b.transaction,
          signal,
        ),
      );
    return json({ error: 'Invalid launch action.' }, 400);
  } catch (error) {
    if (error instanceof StonkLaunchError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Launch action did not complete. Check the mint on Solscan before trying again.',
      },
      502,
    );
  }
}
