import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { address, isOffCurveAddress } from '@solana/kit';
import { artworkIdValid } from '@/lib/artwork';
import {
  preflightOwnedPumpCreate,
  PumpPreflightError,
  type OwnedPumpTerms,
} from '@/lib/owned-pump-preflight';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review a Pump launch.' }, 401);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin)
    return json({ error: 'Start preflight from this site.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Review the saved launch first.' }, 400);
  let terms: OwnedPumpTerms;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) {
        await reader.cancel();
        return json({ error: 'Preflight request is too large.' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !==
        'feeAndRentLimitRaw,mint,payer,payerRevision,projectId,releaseId,updatedAt' ||
      typeof body.projectId !== 'string' ||
      !body.projectId ||
      body.projectId.length > 128 ||
      typeof body.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.updatedAt)) ||
      typeof body.releaseId !== 'string' ||
      !artworkIdValid(body.releaseId) ||
      typeof body.payer !== 'string' ||
      typeof body.mint !== 'string' ||
      !Number.isSafeInteger(body.payerRevision) ||
      Number(body.payerRevision) < 1 ||
      typeof body.feeAndRentLimitRaw !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(body.feeAndRentLimitRaw) ||
      BigInt(body.feeAndRentLimitRaw) > (1n << 64n) - 1n ||
      isOffCurveAddress(address(body.payer)) ||
      isOffCurveAddress(address(body.mint)) ||
      body.payer === body.mint
    )
      return json(
        {
          error:
            'Review the exact saved project, metadata release, payer, new mint and fee/rent allowance.',
        },
        400,
      );
    terms = { ...body, origin } as OwnedPumpTerms;
  } catch {
    return json({ error: 'Send a valid Pump preflight request.' }, 400);
  } finally {
    reader.releaseLock();
  }
  try {
    const db = getD1();
    const result = await preflightOwnedPumpCreate(
      db,
      user.userId,
      terms,
      request.signal,
      {
        beforeRpc: async () => {
          const now = Date.now(),
            key = JSON.stringify([
              'pump-create-preflight-v1',
              user.userId,
              terms.projectId,
            ]);
          const gate = await db
            .prepare(
              'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
            )
            .bind(key, now + 15000, now)
            .run();
          if (!gate.meta.changes)
            throw new PumpPreflightError(
              'Wait 15 seconds before checking this project again.',
              429,
            );
        },
      },
    );
    return json(result);
  } catch (error) {
    if (error instanceof PumpPreflightError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Pump preflight did not pass. Check the saved metadata, deployer funds and current quote support before retrying. No signing approval was created.',
      },
      502,
    );
  }
}
