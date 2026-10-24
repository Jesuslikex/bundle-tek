import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { readJitoBundle } from './jito-bundle-server';
import { requireJitoManifest } from './jito-bundle';
import { currentImportedPreparation } from './imported-swap-approval';
import { currentTradeSession } from './imported-trade-session-server';
import { restoreSavedSwapOrder } from './warmup-signing';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { getSolanaHolderRpcEndpoint } from './solana-rpc';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';
import { readJitoSimulationPayload } from './jito-simulation-json';
import { collectJitoSimulationAttempt } from './jito-simulation-attempt';
import {
  JITO_SEQUENTIAL_CHECK_AUTHORITY,
  requireJitoSequentialCheckResult,
  type JitoSequentialCheckResult,
} from './jito-sequential-check-result';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';
import { UUID } from './wallet-operation';

const contextFail = (): never => {
  throw Error('Sequential check context changed or unavailable.');
};
const slot = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    return contextFail();
  return v;
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('support read');
  return v as Record<string, unknown>;
};
const fields = (
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) => {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw Error('support read');
};
const integer = (v: unknown, max = (1n << 64n) - 1n) => {
  if (typeof v !== 'bigint' || v < 0n || v > max) throw Error('support read');
  return v;
};
async function owned(
  db: D1Database,
  owner: string,
  id: string,
  sha256: string,
) {
  const bundle = await readJitoBundle(db, owner, id);
  await requireJitoManifest(bundle.manifest);
  if (
    bundle.manifest.sha256 !== sha256 ||
    bundle.row.state !== 'reviewed' ||
    bundle.row.bundleId !== null ||
    bundle.packets.some((p) => p.signature !== null || p.transaction !== null)
  )
    return contextFail();
  const project = await db
    .prepare(
      'SELECT revision,document,address,chain,archived FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, bundle.manifest.projectId)
    .first<{
      revision: number;
      document: string;
      address: string;
      chain: string;
      archived: number;
    }>();
  if (!project || project.chain !== 'Solana' || project.archived !== 0)
    return contextFail();
  const sources = [];
  for (const review of bundle.manifest.swaps) {
    const captured = await currentImportedPreparation(
      db,
      owner,
      review.preparationId,
    );
    if (!captured) return contextFail();
    const saved: SavedSwapPreparation = {
      ...captured,
      document: JSON.parse(captured.document),
    };
    if (
      saved.projectId !== bundle.manifest.projectId ||
      saved.document.conditional ||
      !review.session ||
      JSON.stringify(saved.document.session) !== JSON.stringify(review.session)
    )
      return contextFail();
    const order = await restoreSavedSwapOrder(saved, review.transaction);
    if (
      order.preparation.wallet !== review.wallet ||
      order.inputMint !== review.inputMint ||
      order.outputMint !== review.outputMint ||
      order.inAmount !== review.inputRaw ||
      order.minimumOutAmount !== review.minimumOutputRaw ||
      order.preparation.lastValidBlockHeight !== review.lastValidBlockHeight ||
      order.expiresAt !== review.expiresAt
    )
      return contextFail();
    const guard = await currentTradeSession(db, owner, saved, review.id);
    if (!guard) return contextFail();
    const intent = await db
      .prepare(
        'SELECT document,state,signature,preparation_id AS preparationId,wallet_address AS wallet FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{
        document: string;
        state: string;
        signature: string | null;
        preparationId: string;
        wallet: string;
      }>();
    if (
      !intent ||
      intent.state !== 'awaiting_signature' ||
      intent.signature !== null ||
      intent.document !== JSON.stringify(review) ||
      intent.preparationId !== review.preparationId ||
      intent.wallet !== review.wallet
    )
      return contextFail();
    sources.push({ captured, guard, intent, saved, order });
  }
  return {
    bundle,
    sources,
    fingerprint: JSON.stringify({
      row: bundle.row,
      project,
      packets: bundle.packets,
      sources: sources.map(({ captured, guard, intent }) => ({
        captured,
        guard,
        intent,
      })),
    }),
  };
}

/** Owned, explicit unsigned diagnostic only. No bundle writes, signing, submission or authority. */
export async function checkJitoBundleSequential(
  db: D1Database,
  owner: string,
  input: { id: string; sha256: string },
  signal: AbortSignal,
  dependencies: { fetcher?: typeof fetch; pace?: typeof paceWalletRpc } = {},
): Promise<JitoSequentialCheckResult> {
  let id: string, sha256: string;
  try {
    const names = Object.keys(input);
    const idDescriptor = Object.getOwnPropertyDescriptor(input, 'id'),
      digestDescriptor = Object.getOwnPropertyDescriptor(input, 'sha256');
    if (
      names.length !== 2 ||
      !idDescriptor ||
      !digestDescriptor ||
      !('value' in idDescriptor) ||
      !('value' in digestDescriptor)
    )
      return contextFail();
    id = idDescriptor.value;
    sha256 = digestDescriptor.value;
    if (
      typeof id !== 'string' ||
      !UUID.test(id) ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      return contextFail();
    Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    )!.get!.call(signal);
    signal.throwIfAborted();
  } catch {
    return contextFail();
  }
  const fetcher = dependencies.fetcher ?? fetch,
    pace = dependencies.pace ?? paceWalletRpc;
  const before = await owned(db, owner, id, sha256).catch(contextFail);
  const seen = [
    slot(before.bundle.manifest.tip.slot),
    ...before.sources.flatMap(({ saved }) => [
      slot(saved.document.simulation.feeSlot),
      slot(saved.document.simulation.simulationSlot),
    ]),
  ];
  const minimumSlot = Math.min(...seen);
  const span = () => {
    if (
      Math.max(...seen) - minimumSlot > 32 ||
      seen.some((s) => s < minimumSlot)
    )
      throw Error('slot span');
  };
  try {
    span();
  } catch {
    return contextFail();
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const controller = new AbortController(),
    control = AbortSignal.any([deadline, controller.signal]);
  let reason: JitoSequentialCheckResult['reason'] = 'transport-unavailable',
    units = 0,
    httpReads = 0,
    rateLimited = false;
  let attempt:
    | Awaited<ReturnType<typeof collectJitoSimulationAttempt>>
    | undefined;
  const responses: Response[] = [];
  const cancel = (response: Response) => {
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      /* No private transport details escape. */
    }
  };
  const endpoint = getSolanaHolderRpcEndpoint();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw Error('endpoint');
    async function send(
      body: string,
      count: number,
      signalForRead: AbortSignal,
    ): Promise<Response> {
      if (rateLimited || ++httpReads > 12 || (units += count) > 18)
        throw Error('read budget');
      signalForRead.throwIfAborted();
      let abort: () => void = () => {};
      const stop = new Promise<never>((_, reject) => {
        abort = () => reject(Error('read interrupted'));
        signalForRead.addEventListener('abort', abort, { once: true });
        if (signalForRead.aborted) abort();
      });
      const pending = Promise.resolve().then(async () => {
        for (let i = 0; i < count; i++) await pace(endpoint, signalForRead);
        signalForRead.throwIfAborted();
        const response = await fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          cache: 'no-store',
          signal: signalForRead,
        });
        responses.push(response);
        if (signalForRead.aborted) {
          cancel(response);
          throw Error('read interrupted');
        }
        if (response.status === 429) rateLimited = true;
        return response;
      });
      try {
        return await Promise.race([pending, stop]);
      } finally {
        signalForRead.removeEventListener('abort', abort);
      }
    }
    let rpcId = 0;
    async function rpc(method: string, params: unknown[]) {
      if (!['getGenesisHash', 'getMultipleAccounts'].includes(method))
        throw Error('support method');
      const requestId = `jito-owned-check:${id}:${rpcId++}`;
      const response = await send(
        JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        1,
        control,
      );
      if (response.status === 429) {
        reason = 'rate-limited';
        throw Error('rate limit');
      }
      if (!response.ok) {
        reason = 'http-refused';
        throw Error('http');
      }
      const raw = record(
        (await readJitoSimulationPayload(response.body, control, 524288)).value,
      );
      fields(raw, ['jsonrpc', 'id'], ['result', 'error']);
      if (
        raw.jsonrpc !== '2.0' ||
        raw.id !== requestId ||
        Object.hasOwn(raw, 'result') === Object.hasOwn(raw, 'error')
      )
        throw Error('support envelope');
      if (Object.hasOwn(raw, 'error')) {
        const error = record(raw.error);
        fields(error, ['code', 'message'], ['data']);
        if (error.code === 429n) {
          rateLimited = true;
          reason = 'rate-limited';
        }
        throw Error('support RPC refused');
      }
      if (method === 'getGenesisHash') return raw.result;
      const result = record(raw.result);
      fields(result, ['context', 'value']);
      const context = record(result.context);
      fields(context, ['slot'], ['apiVersion']);
      if (
        Object.hasOwn(context, 'apiVersion') &&
        (typeof context.apiVersion !== 'string' ||
          !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
      )
        throw Error('context');
      const observed = Number(
        integer(context.slot, BigInt(Number.MAX_SAFE_INTEGER)),
      );
      seen.push(observed);
      span();
      if (!Array.isArray(result.value) || result.value.length > 32)
        throw Error('accounts');
      const values = result.value.map((value: unknown) => {
        if (value === null) return null;
        const a = record(value);
        fields(
          a,
          ['owner', 'executable', 'data', 'lamports', 'rentEpoch'],
          ['space'],
        );
        if (
          typeof a.owner !== 'string' ||
          typeof a.executable !== 'boolean' ||
          !Array.isArray(a.data) ||
          a.data.length !== 2 ||
          typeof a.data[0] !== 'string' ||
          a.data[1] !== 'base64'
        )
          throw Error('account');
        const bytes = Buffer.from(a.data[0], 'base64');
        if (bytes.length > 8248 || bytes.toString('base64') !== a.data[0])
          throw Error('account bytes');
        integer(a.rentEpoch);
        if (
          a.space !== undefined &&
          a.space !== null &&
          integer(a.space) !== BigInt(bytes.length)
        )
          throw Error('space');
        return {
          owner: a.owner,
          executable: a.executable,
          data: a.data,
          lamports: integer(a.lamports).toString(),
        };
      });
      // Exact integer-to-string projection only at the existing ALT parser boundary.
      return { context: { slot: observed.toString() }, value: values };
    }
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      throw Error('network');
    const messages = before.sources.map(({ order }) =>
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(
          Buffer.from(order.preparation.transaction, 'base64'),
        ).messageBytes,
      ),
    );
    const lookups: Awaited<ReturnType<typeof readSwapLookupAccounts>>[] = [];
    for (let i = 0; i < messages.length; i++) {
      const found = await readSwapLookupAccounts(
        messages[i],
        Math.max(...seen),
        rpc,
      );
      const approved = before.bundle.manifest.swaps[i].settlement?.lookupTables;
      if (
        approved &&
        JSON.stringify(
          found?.tables.map(({ address, sha256, lastExtendedSlot }) => ({
            address,
            sha256,
            lastExtendedSlot,
          })) ?? [],
        ) !== JSON.stringify(approved)
      )
        throw Error('approved lookup');
      lookups.push(found);
    }
    const packets = before.bundle.manifest.swaps.map((review, i) => ({
      transaction: review.transaction,
      loadedAddresses: lookups[i]
        ? { writable: lookups[i]!.writable, readonly: lookups[i]!.readonly }
        : null,
      maximumFeeLamports: review.maximumFeeLamports,
      expectedFeeLamports: review.maximumFeeLamports,
    }));
    packets.push({
      transaction: before.bundle.manifest.tip.transaction,
      loadedAddresses: null,
      maximumFeeLamports: before.bundle.manifest.tip.feeLamports,
      expectedFeeLamports: before.bundle.manifest.tip.feeLamports,
    });
    attempt = await collectJitoSimulationAttempt({
      packets,
      minimumSlot,
      feeIdPrefix: `jito-check-fees:${id}`,
      simulationRpcId: `jito-check:${id}`,
      bankEncoding: 'slot-object',
      verifySignatures: false,
      signal: control,
      transport: ({ phase, body, signal }) =>
        send(body, phase === 'fees' ? packets.length : 1, signal),
    });
    reason =
      attempt.status === 'captured' ? 'frame-integrity-only' : attempt.reason;
    const feeReplies = attempt.fees?.rawResponse?.value;
    const simulationReply = attempt.simulation?.rawResponse?.value;
    const rpcRateLimited = (v: unknown) =>
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      (v as { error?: { code?: unknown } }).error?.code === 429n;
    if (
      (Array.isArray(feeReplies) && feeReplies.some(rpcRateLimited)) ||
      rpcRateLimited(simulationReply)
    ) {
      rateLimited = true;
      reason = 'rate-limited';
    }
    if (attempt.fees?.status === 'observed') {
      seen.push(attempt.fees.simulationBankSlot);
      span();
    }
    if (attempt.status === 'captured') {
      const bank = attempt.simulation.frames.slot;
      if (bank < Math.max(...seen)) throw Error('simulation predates sources');
      for (let i = 0; i < messages.length; i++) {
        if (!lookups[i]) continue;
        const after = await readSwapLookupAccounts(
          messages[i],
          Math.max(bank, ...seen),
          rpc,
        );
        assertSameSwapLookups(
          lookups[i]!,
          after,
          attempt.simulation.frames.frames[i].loadedAddresses,
        );
      }
    }
    if (
      !rateLimited &&
      (await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS
    )
      throw Error('network');
    control.throwIfAborted();
  } catch {
    if (rateLimited) reason = 'rate-limited';
    else if (control.aborted) reason = 'interrupted';
    else if (reason === 'frame-integrity-only') reason = 'simulation-refused';
  } finally {
    controller.abort();
    for (const response of responses) cancel(response);
  }
  const after = await owned(db, owner, id, sha256).catch(contextFail);
  if (after.fingerprint !== before.fingerprint) return contextFail();
  if (deadline.aborted) reason = 'interrupted';
  const observedSimulationSlot =
    attempt?.status === 'captured' ? attempt.simulation.frames.slot : null;
  const framesObserved =
    reason === 'frame-integrity-only' && observedSimulationSlot !== null;
  const result = {
    format: 'jito-sequential-check-v1' as const,
    bundleId: id,
    manifestSha256: sha256,
    expiresAt: before.bundle.manifest.expiresAt,
    observedAt: new Date().toISOString(),
    status: framesObserved
      ? ('frames-observed' as const)
      : ('refused' as const),
    reason,
    packetCount: before.bundle.manifest.swaps.length + 1,
    minimumSlot,
    simulationSlot: framesObserved ? observedSimulationSlot : null,
    fees:
      attempt?.fees?.fees.map(({ packet, feeLamports, slot }) => ({
        packet,
        feeLamports,
        slot,
      })) ?? [],
    ...JITO_SEQUENTIAL_CHECK_AUTHORITY,
  };
  return requireJitoSequentialCheckResult(result, before.bundle.manifest);
}
