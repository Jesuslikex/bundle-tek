import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import {
  ImportedSaleEvidenceError,
  readOwnedImportedSaleEvidence,
  retainOwnedImportedSaleEvidence,
} from '@/lib/imported-sale-evidence-service';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import {
  awaitImportedSaleRead,
  createImportedSaleEvidenceRpc,
} from '@/lib/imported-sale-evidence-rpc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const deadline = (request: Request) =>
  AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
function refusal(error: unknown) {
  if (
    error instanceof DOMException &&
    ['AbortError', 'TimeoutError'].includes(error.name)
  )
    return json(
      {
        error:
          'Sale evidence check cancelled or timed out. Load saved evidence before retrying.',
      },
      408,
    );
  if (
    error instanceof ImportedSaleEvidenceError ||
    error instanceof PumpPreflightError
  )
    return json({ error: error.message }, error.status);
  return json(
    {
      error:
        'Sale evidence could not be verified. Load saved evidence before retrying.',
    },
    503,
  );
}
async function body(request: Request, parent: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
  const reader = request.body?.getReader();
  if (!reader)
    throw new ImportedSaleEvidenceError('Select one sale receipt.', 400);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let size = 0,
      text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      signal.throwIfAborted();
      const next = await awaitImportedSaleRead(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024)
        throw new ImportedSaleEvidenceError(
          'Sale evidence request is too large.',
          413,
        );
      text += decoder.decode(next.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new ImportedSaleEvidenceError(
        'Sale evidence request must be JSON.',
        400,
      );
    }
  } catch (error) {
    cancel();
    if (error instanceof TypeError)
      throw new ImportedSaleEvidenceError(
        'Sale evidence request must be valid UTF-8 JSON.',
        400,
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Saved-only recovery. Never initializes a provider or captures on page load. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view sale evidence.' }, 401);
  const search = new URL(request.url).searchParams,
    id = search.get('saleReceiptId');
  if ([...search.keys()].join(',') !== 'saleReceiptId' || !id || !UUID.test(id))
    return json({ error: 'Select one sale receipt.' }, 400);
  const signal = deadline(request);
  try {
    signal.throwIfAborted();
    const result = await awaitImportedSaleRead(
      readOwnedImportedSaleEvidence(getD1(), user.userId, id, signal),
      signal,
    );
    signal.throwIfAborted();
    return json(result);
  } catch (error) {
    return refusal(error);
  }
}

/** Explicit evidence retention, not trade authorization. Raw signed packets stay private. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to retain sale evidence.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Use this app to retain sale evidence.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'Sale evidence request must use JSON.' }, 415);
  if (new URL(request.url).search)
    return json({ error: 'Unsupported sale evidence query.' }, 400);
  const signal = deadline(request);
  try {
    const value = await body(request, signal);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'saleReceiptId' ||
      typeof (value as { saleReceiptId?: unknown }).saleReceiptId !==
        'string' ||
      !UUID.test((value as { saleReceiptId: string }).saleReceiptId)
    )
      throw new ImportedSaleEvidenceError('Select one sale receipt.', 400);
    const id = (value as { saleReceiptId: string }).saleReceiptId;
    // Build transport lazily: owner/source checks and saved-only retries happen first.
    let transport: ReturnType<typeof createImportedSaleEvidenceRpc> | undefined;
    const rpc: ReturnType<typeof createImportedSaleEvidenceRpc> = (
      method,
      params,
      readSignal,
    ) => {
      transport ??= createImportedSaleEvidenceRpc(
        getSolanaRpcEndpoint('mainnet'),
      );
      return transport(method, params, readSignal);
    };
    const result = await awaitImportedSaleRead(
      retainOwnedImportedSaleEvidence(getD1(), user.userId, id, signal, rpc),
      signal,
    );
    signal.throwIfAborted();
    return json(result);
  } catch (error) {
    return refusal(error);
  }
}
