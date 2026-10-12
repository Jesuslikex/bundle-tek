import {
  observeSupplyPartition,
  supplyPartitionScope,
} from '@/lib/supply-partition';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let scope;
  try {
    const text = await request.text();
    if (text.length > 4096)
      return json({ error: 'Supply request too large.' }, 413);
    scope = supplyPartitionScope(JSON.parse(text));
  } catch {
    return json(
      {
        error:
          'Choose a valid Solana mint and 1 to 12 uniquely classified wallets.',
      },
      400,
    );
  }
  try {
    return json({
      snapshot: await observeSupplyPartition(
        scope,
        AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
      ),
    });
  } catch {
    return json(
      {
        error:
          'Supply read unavailable or inconsistent. Check your holder-capable mainnet RPC and retry.',
      },
      502,
    );
  }
}
