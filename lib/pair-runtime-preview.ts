import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
} from './pump-launch-simulation';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { reviewSwapInstructions } from './swap-instruction-review';
import { pairRuntimeDigest } from './pair-runtime-trace';
import { collectPairOrderReview } from './pair-order-collector';
import { assertPairRuntimeWritableAccount } from './pair-runtime-exposure';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { requireConsistentSolanaSlots } from './solana-rpc';
import type { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
type Candidate = Awaited<ReturnType<typeof prepareOwnedImportedPairOrder>>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const COMPUTE = 'ComputeBudget111111111111111111111111111111',
  NATIVE = 'NativeLoader1111111111111111111111111111111';
/** Two full code observations bracket the traced simulation. This establishes identity evidence, not a trusted program policy or semantic audit. */
export async function collectPairRuntimePreview(
  candidate: Candidate,
  rpc: Rpc,
  programRpc: Rpc,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const started = now(),
    slots = [candidate.review.minimumSlot, candidate.review.maximumSlot],
    floor = () => Math.max(...slots);
  const fresh = () => {
    signal.throwIfAborted();
    const time = now();
    if (
      !Number.isFinite(time) ||
      time < started - 1000 ||
      time >= Date.parse(candidate.review.expiresAt)
    )
      throw Error('Pair runtime preview expired.');
  };
  const context = (raw: unknown) => {
    const slot = Number(pumpUnsignedInteger(raw));
    if (!Number.isSafeInteger(slot) || slot < floor())
      throw Error('Pair runtime context moved backwards.');
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  };
  const call: Rpc = async (method, params) => {
    fresh();
    const config = params[1] as { minContextSlot?: number } | undefined;
    const scoped =
      config && typeof config.minContextSlot === 'number'
        ? [
            params[0],
            {
              ...config,
              minContextSlot: Math.max(config.minContextSlot, floor()),
            },
            ...params.slice(2),
          ]
        : params;
    const result = await rpc(method, scoped);
    fresh();
    return result;
  };
  const codeCall: Rpc = async (method, params) => {
    fresh();
    if (!['getMultipleAccounts', 'getGenesisHash'].includes(method))
      throw Error('Pair code reader method differs.');
    const result = await programRpc(method, params);
    fresh();
    return result;
  };
  fresh();
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(candidate.order.preparation.transaction),
    ).messageBytes,
  );
  const lookups = await readSwapLookupAccounts(message, floor(), call);
  if (lookups) context(String(lookups.observedSlot));
  const keys = [
    ...message.staticAccounts.map(String),
    ...(lookups?.writable ?? []),
    ...(lookups?.readonly ?? []),
  ];
  if (new Set(keys).size !== keys.length || keys.length > 256)
    throw Error('Pair runtime account scope differs.');
  const writable = candidate.review.writableAccounts;
  const top = reviewSwapInstructions(message, lookups ?? undefined);
  async function read(keys: string[], sliced: boolean) {
    const response = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: floor(),
        ...(sliced ? { dataSlice: { offset: 0, length: 45 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    context(response?.context?.slot);
    if (!Array.isArray(response.value) || response.value.length !== keys.length)
      throw Error('Pair runtime account snapshot is incomplete.');
    return response.value.map((raw) => {
      const a = pumpRpcAccount(raw),
        declared = (raw as { space?: unknown } | null)?.space;
      return (
        a && {
          ...a,
          space:
            declared === undefined
              ? undefined
              : pumpUnsignedInteger(declared).toString(),
        }
      );
    });
  }
  async function inventory() {
    const accounts = [];
    for (let offset = 0; offset < keys.length; offset += 100)
      accounts.push(...(await read(keys.slice(offset, offset + 100), true)));
    for (const [i, a] of accounts.entries())
      if (writable.includes(keys[i])) assertPairRuntimeWritableAccount(a);
    const programs = accounts
      .flatMap((a, i) => (a?.executable ? [keys[i]] : []))
      .sort();
    if (
      !programs.length ||
      programs.length > 16 ||
      top.instructions.some((ix) => !programs.includes(ix.program.address))
    )
      throw Error('Pair runtime executable coverage differs.');
    return { programs, compute: accounts[keys.indexOf(COMPUTE)] };
  }
  const selected = [
    candidate.preflight.wallet,
    ...candidate.review.assessment.accounts.map((a) => a.address),
  ];
  const beforeAccounts = await read(selected, false);
  const beforeInventory = await inventory();
  async function identities(evidence: Awaited<ReturnType<typeof inventory>>) {
    const programs = evidence.programs.filter((p) => p !== COMPUTE);
    const code = await collectPumpProgramIdentities(
      programs,
      floor(),
      signal,
      (method, params) => codeCall(method, params),
    );
    context(String(code.maximumSlot));
    const result = code.programs.map((p) => ({
      ...p,
      identityKind: p.identityKind as string,
    }));
    if (evidence.programs.includes(COMPUTE)) {
      const a = evidence.compute;
      if (
        !a ||
        !a.executable ||
        a.owner !== NATIVE ||
        !pumpAccountBytes(a).length ||
        pumpAccountBytes(a).length > 45 ||
        (a.space !== undefined &&
          Number(pumpUnsignedInteger(a.space)) !== pumpAccountBytes(a).length)
      )
        throw Error('Pair compute-budget native marker differs.');
      result.push({
        address: COMPUTE,
        loader: NATIVE,
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: Buffer.from(
          await crypto.subtle.digest('SHA-256', pumpAccountBytes(a)),
        ).toString('hex'),
        codeBytes: pumpAccountBytes(a).length,
        identityKind: 'native-marker',
      });
    }
    return result.sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    );
  }
  const beforeCode = await identities(beforeInventory);
  const review = await collectPairOrderReview(
    candidate.preflight,
    candidate.order,
    call,
    now,
    true,
  );
  context(String(review.maximumSlot));
  if (
    !review.runtimeTrace ||
    review.runtimeTrace.programs.some(
      (p) => !beforeInventory.programs.includes(p),
    )
  )
    throw Error(
      'Pair runtime inner program is not covered by executable identities.',
    );
  const afterInventory = await inventory();
  if (
    JSON.stringify(beforeInventory.programs) !==
    JSON.stringify(afterInventory.programs)
  )
    throw Error('Pair runtime executable coverage changed.');
  const afterCode = await identities(afterInventory);
  if (JSON.stringify(beforeCode) !== JSON.stringify(afterCode))
    throw Error(
      'Pair program code or upgrade authority changed around simulation.',
    );
  const afterAccounts = await read(selected, false);
  const stateIdentity = (accounts: typeof beforeAccounts) =>
    accounts.map((a) => a && [a.owner, a.executable, a.lamports, a.data]);
  if (
    (await pairRuntimeDigest(stateIdentity(beforeAccounts))) !==
    (await pairRuntimeDigest(stateIdentity(afterAccounts)))
  )
    throw Error('Pair runtime wallet custody or balances changed.');
  if (lookups) {
    const recheck = await readSwapLookupAccounts(message, floor(), call);
    assertSameSwapLookups(lookups, recheck, null);
    context(String(recheck!.observedSlot));
  }
  const valid = (await call('isBlockhashValid', [
    message.lifetimeToken,
    { commitment: 'confirmed', minContextSlot: floor() },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  context(valid?.context?.slot);
  const height = pumpUnsignedInteger(
    await call('getBlockHeight', [{ commitment: 'confirmed' }]),
  );
  if (
    valid.value !== true ||
    height < BigInt(review.recheckBlockHeight) ||
    height + 10n > BigInt(review.lastValidBlockHeight) ||
    (await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS
  )
    throw Error('Pair runtime lifetime or network changed.');
  fresh();
  const result = {
    format: 'pair-order-runtime-preview-v1' as const,
    packetSha256: review.packetSha256,
    preflightSha256: review.preflightSha256,
    pairSha256: review.pairSha256,
    reviewSha256: review.sha256,
    programs: afterCode,
    traceSha256: review.runtimeTrace.sha256,
    codeIdentityObserved: true as const,
    minimumSlot: Math.min(...slots),
    maximumSlot: floor(),
    recheckBlockHeight: height.toString(),
    observedAt: new Date(started).toISOString(),
    expiresAt: review.expiresAt,
    programCodeAttested: false as const,
    semanticAuditEstablished: false as const,
    trustedProgramPolicyEstablished: false as const,
    innerInstructionPolicyVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const sha256 = await pairRuntimeDigest(result);
  fresh();
  return { review, runtime: { ...result, sha256 } };
}
