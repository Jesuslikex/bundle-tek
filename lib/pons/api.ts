import { withDeadline } from './deadline';
import { type Hex } from 'viem';
import {
  type StoredSimulation,
  type ReceiptState,
  type ReceiptObservation,
} from './receipt';
import { PonsError, exactObject, validateIntent, type Intent } from './intent';
import { type PonsStore, type Job } from './store';
type Deps = {
  owner: () => Promise<string | null>;
  enabled: boolean;
  store: PonsStore | (() => Promise<PonsStore>);
  simulate: (
    intent: Intent,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; [key: string]: unknown }>;
  observe?: (
    stored: StoredSimulation,
    hash: Hex,
    signal: AbortSignal,
  ) => Promise<{ state: ReceiptState; receipt: ReceiptObservation }>;
};
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
async function body(request: Request) {
  return withDeadline(
    5000,
    (signal) => readBody(request, signal),
    'BODY_TIMEOUT',
    408,
  );
}
async function readBody(request: Request, signal: AbortSignal) {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    throw new PonsError(415, 'JSON_REQUIRED');
  if (Number(request.headers.get('content-length')) > 16384)
    throw new PonsError(413, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new PonsError(400, 'INVALID_JSON');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) throw new PonsError(413, 'BODY_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await disposeBodyReader(reader);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PonsError(400, 'INVALID_JSON');
  }
}
async function disposeBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  try {
    // Workerd currently requires service callees to consume rejected uploads;
    // cancellation alone can poison the next service.fetch (workerd#960).
    // Drain without retaining bytes. A deadline bounds stalled/malicious streams,
    // and periodic timer yields keep an already-buffered endless stream bounded.
    await withDeadline(
      5000,
      async (signal) => {
        signal.addEventListener('abort', cancel, { once: true });
        try {
          let reads = 0;
          while (true) {
            const { done } = await reader.read();
            if (done) return;
            if (++reads % 64 === 0)
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      },
      'BODY_CLEANUP_TIMEOUT',
    );
  } catch {
    // Cleanup must not replace the original API result.
  } finally {
    cancel();
    reader.releaseLock();
  }
}
async function cleanupUnreadBody(request: Request) {
  // readBody owns its locked reader, including timeout cleanup.
  if (!request.body || request.body.locked || request.bodyUsed) return;
  await disposeBodyReader(request.body.getReader());
}
function present(j: Job) {
  const result = j.result ? JSON.parse(j.result) : null;
  const handoff =
    result?.ok && result?.unsignedTransaction
      ? {
          usable:
            j.state === 'simulated' &&
            Boolean(result.handoffValidatedAt) &&
            result.expiresAt > Date.now(),
          reason:
            result.expiresAt <= Date.now()
              ? 'SIMULATION_EXPIRED'
              : result.handoffValidatedAt
                ? 'UNSIGNED_ONLY_NONCE_NOT_RESERVED'
                : 'REVALIDATE_BEFORE_SIGNING',
        }
      : { usable: false, reason: 'SIMULATION_REQUIRED' };
  return {
    handoff,
    id: j.id,
    intent: JSON.parse(j.intent),
    state: j.state,
    revision: j.revision,
    leaseUntil: j.lease_until,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    result: j.result ? JSON.parse(j.result) : null,
  };
}
export async function handlePons(
  request: Request,
  action: 'create' | 'get' | 'simulate' | 'handoff' | 'receipt',
  id: string | undefined,
  deps: Deps,
) {
  try {
    const owner = await deps.owner();
    if (!owner) throw new PonsError(401, 'AUTH_REQUIRED');
    if (!deps.enabled) throw new PonsError(423, 'PONS_BACKEND_LOCKED');
    if (action !== 'get') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin)
        throw new PonsError(403, 'CROSS_ORIGIN_DENIED');
    }
    if (action !== 'create' && (!id || !/^[0-9a-f-]{36}$/.test(id)))
      throw new PonsError(400, 'INVALID_JOB_ID');
    const store =
      typeof deps.store === 'function' ? await deps.store() : deps.store;
    if (action === 'create') {
      const intent = validateIntent(await body(request));
      const job = await store.create(
        owner,
        request.headers.get('idempotency-key') ?? '',
        intent,
      );
      return Response.json({ job: present(job) }, { status: 201, headers });
    }
    if (action === 'get') {
      const job = await store.get(owner, id!);
      return Response.json(
        {
          job: present(job),
          events: await store.events(owner, id!),
          eventWindow: 'latest-100',
        },
        { headers },
      );
    }
    if (action === 'receipt') {
      const input = exactObject(await body(request), ['revision', 'txHash']);
      if (
        !Number.isSafeInteger(input.revision) ||
        Number(input.revision) < 0 ||
        typeof input.txHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(input.txHash)
      )
        throw new PonsError(400, 'INVALID_RECEIPT_REQUEST');
      const current = await store.get(owner, id!);
      if (current.revision !== input.revision)
        throw new PonsError(409, 'REVISION_OR_STATE_CONFLICT');
      if (
        ![
          'simulated',
          'submitted',
          'confirming',
          'confirmed',
          'reverted',
          'reorged',
        ].includes(current.state) ||
        !current.result
      )
        throw new PonsError(409, 'SIMULATION_REQUIRED');
      if (!deps.observe)
        throw new PonsError(503, 'RECEIPT_MONITOR_UNAVAILABLE');
      const stored = JSON.parse(current.result) as StoredSimulation;
      const observation = await withDeadline(
        90000,
        (signal) => deps.observe!(stored, input.txHash as Hex, signal),
        'RECEIPT_TIMEOUT',
      );
      const job = await store.recordReceipt(
        owner,
        id!,
        current.revision,
        observation.state,
        { ...stored, receipt: observation.receipt },
      );
      return Response.json({ job: present(job) }, { headers });
    }
    const input = exactObject(await body(request), ['revision']);
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
      throw new PonsError(400, 'INVALID_REVISION');
    const previous = action === 'handoff' ? await store.get(owner, id!) : null;
    if (previous && (previous.state !== 'simulated' || !previous.result))
      throw new PonsError(409, 'SIMULATION_REQUIRED');
    const claim = await store.claim(owner, id!, input.revision as number);
    let outcome: { ok: boolean; [key: string]: unknown };
    try {
      outcome = await withDeadline(
        90000,
        (signal) =>
          deps.simulate(validateIntent(JSON.parse(claim.intent)), signal),
        'SIMULATION_TIMEOUT',
      );
      if (previous) {
        const old = JSON.parse(previous.result!);
        const tx = outcome.unsignedTransaction as
          | Record<string, unknown>
          | undefined;
        if (
          !outcome.ok ||
          !tx ||
          old.expectedEconomics !== outcome.expectedEconomics ||
          old.launchFeeWei !== outcome.launchFeeWei ||
          ['chainId', 'from', 'to', 'value', 'data', 'gas', 'gasPrice'].some(
            (k) => old.unsignedTransaction?.[k] !== tx[k],
          )
        )
          throw new PonsError(409, 'TERMS_CHANGED_RESIMULATE');
        outcome = { ...outcome, handoffValidatedAt: Date.now() };
      }
    } catch (e) {
      outcome = {
        ok: false,
        error: e instanceof PonsError ? e.code : 'SIMULATION_RPC_FAILED',
        failedAt: Date.now(),
        nonceStatus: 'not reserved',
      };
    }
    const job = await store.finish(
      owner,
      id!,
      claim.revision,
      claim.lease_token!,
      outcome,
    );
    return Response.json({ job: present(job) }, { headers });
  } catch (e) {
    const known = e instanceof PonsError;
    return Response.json(
      { error: known ? e.code : 'PONS_UNAVAILABLE' },
      { status: known ? e.status : 503, headers },
    );
  } finally {
    await cleanupUnreadBody(request);
  }
}
