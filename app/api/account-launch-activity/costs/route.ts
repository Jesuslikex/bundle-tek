import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { readOwnedPumpGroupRecordedCosts } from '@/lib/pump-group-recorded-costs-service';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review saved launch costs.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('reviewId');
  if (
    !id ||
    params.size !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    return json({ error: 'Select one saved launch group.' }, 400);
  try {
    return json(
      await readOwnedPumpGroupRecordedCosts(
        getD1(),
        user.userId,
        id,
        AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      ),
    );
  } catch (error) {
    const status = error instanceof PumpPreflightError ? error.status : 503;
    return json(
      {
        error:
          status === 404
            ? 'Saved launch group not found.'
            : status === 409 && error instanceof PumpPreflightError
              ? error.message
              : 'Saved launch cost evidence could not be checked. No cost totals are shown.',
      },
      status,
    );
  }
}
