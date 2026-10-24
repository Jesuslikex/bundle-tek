import bs58 from 'bs58';
import { readJitoSimulationPayload } from './jito-simulation-json';
import {
  inspectSwapMintAccount,
  assertSameSwapMintEvidence,
} from './swap-token-program-evidence';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';

const plans = new WeakMap<
  object,
  { mints: string[]; floor: number; minimum: number; id: string; body: string }
>();
const captures = new WeakMap<
  object,
  { plan: JitoAssetReadPlan; raw: Uint8Array; digest: string }
>();
const fail = (): never => {
  throw Error('Jito asset evidence differs or is incomplete.');
};
const hash = async (v: Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(v)),
  ).toString('hex');
const uint = (v: unknown, max = (1n << 64n) - 1n) => {
  if (typeof v !== 'bigint' || v < 0n || v > max) return fail();
  return v;
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
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
    fail();
};
const key = (v: unknown): string => {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return fail();
  const bytes = bs58.decode(v);
  if (bytes.length !== 32 || bs58.encode(bytes) !== v) return fail();
  return v;
};
export type JitoAssetReadPlan = Readonly<{
  format: 'jito-assets-request-v1';
  body: string;
  addresses: readonly string[];
  minimumSlot: number;
  minimumReadSlot: number;
}>;
export type JitoAssetCapture = {
  format: 'jito-assets-capture-v1';
  slot: number;
  rawBody: Uint8Array;
  rawSha256: string;
  requestBody: string;
  requestSha256: string;
};

/** Independent mint/Rent scope. Plans are locally issued; untrusted caller objects cannot impersonate them. */
export function buildJitoAssetRead(
  mints: readonly string[],
  minimumSlot: number,
  minimumReadSlot: number,
  id: string,
): JitoAssetReadPlan {
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(minimumReadSlot) ||
    minimumReadSlot < minimumSlot ||
    minimumReadSlot - minimumSlot > 32 ||
    typeof id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
    !Array.isArray(mints) ||
    mints.length < 2 ||
    mints.length > 8 ||
    Reflect.ownKeys(mints).length !== mints.length + 1
  )
    return fail();
  const copied: string[] = [];
  for (let i = 0; i < mints.length; i++) {
    const d = Object.getOwnPropertyDescriptor(mints, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail();
    copied.push(key(d.value));
  }
  if (new Set(copied).size !== copied.length || copied.includes(PAIR_RENT))
    return fail();
  const addresses = Object.freeze([...copied, PAIR_RENT]);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'getMultipleAccounts',
    params: [
      addresses,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: minimumReadSlot,
      },
    ],
  });
  const plan = Object.freeze({
    format: 'jito-assets-request-v1' as const,
    body,
    addresses,
    minimumSlot,
    minimumReadSlot,
  });
  plans.set(plan, {
    mints: copied,
    floor: minimumSlot,
    minimum: minimumReadSlot,
    id,
    body,
  });
  return plan;
}

function projectAccount(value: unknown) {
  const a = object(value);
  fields(
    a,
    ['owner', 'executable', 'lamports', 'rentEpoch', 'data'],
    ['space'],
  );
  if (
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    typeof a.data[0] !== 'string' ||
    a.data[1] !== 'base64' ||
    a.data[0].length > 11000
  )
    return fail();
  const bytes = Buffer.from(a.data[0], 'base64');
  if (bytes.length > 8248 || bytes.toString('base64') !== a.data[0])
    return fail();
  uint(a.rentEpoch);
  if (Object.hasOwn(a, 'space') && uint(a.space) !== BigInt(bytes.length))
    return fail();
  return {
    owner: key(a.owner),
    executable: a.executable,
    lamports: uint(a.lamports).toString(),
    data: [a.data[0], 'base64'] as [string, 'base64'],
  };
}
async function parse(
  plan: JitoAssetReadPlan,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) {
  const policy = plans.get(plan);
  if (!policy) return fail();
  const raw = await readJitoSimulationPayload(body, signal, 131072);
  const envelope = object(raw.value);
  fields(envelope, ['jsonrpc', 'id', 'result']);
  if (envelope.jsonrpc !== '2.0' || envelope.id !== policy.id) return fail();
  const result = object(envelope.result);
  fields(result, ['context', 'value']);
  const context = object(result.context);
  fields(context, ['slot'], ['apiVersion']);
  if (
    context.apiVersion !== undefined &&
    (typeof context.apiVersion !== 'string' ||
      !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
  )
    return fail();
  const slot = Number(uint(context.slot, BigInt(Number.MAX_SAFE_INTEGER)));
  if (
    slot < policy.minimum ||
    slot - policy.floor > 32 ||
    !Array.isArray(result.value) ||
    result.value.length !== policy.mints.length + 1
  )
    return fail();
  const accounts = result.value.map(projectAccount);
  const mints = await Promise.all(
    policy.mints.map((address, i) =>
      inspectSwapMintAccount(accounts[i], address),
    ),
  );
  const rent = inspectPairRentAccount(accounts.at(-1));
  signal.throwIfAborted();
  return { raw, slot, accounts, mints, rent };
}
/** Raw bytes and request identity are retained privately; no provider/ownership/signing claim. */
export async function readJitoAssetEvidence(
  plan: JitoAssetReadPlan,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<JitoAssetCapture> {
  const parsed = await parse(plan, body, signal);
  const capture = {
    format: 'jito-assets-capture-v1' as const,
    slot: parsed.slot,
    rawBody: Uint8Array.from(parsed.raw.rawBody),
    rawSha256: parsed.raw.rawSha256,
    requestBody: plan.body,
    requestSha256: await hash(new TextEncoder().encode(plan.body)),
  };
  captures.set(capture, {
    plan,
    raw: Uint8Array.from(parsed.raw.rawBody),
    digest: parsed.raw.rawSha256,
  });
  signal.throwIfAborted();
  return capture;
}

/** Replays original private bytes rather than trusting mutable decoded summaries. */
export async function verifyJitoAssetBracket(
  before: JitoAssetCapture,
  after: JitoAssetCapture,
  simulationBankSlot: number,
  signal: AbortSignal,
) {
  const first = captures.get(before),
    last = captures.get(after);
  if (
    !first ||
    !last ||
    before === after ||
    first.plan === last.plan ||
    !Number.isSafeInteger(simulationBankSlot)
  )
    return fail();
  const a = plans.get(first.plan)!,
    b = plans.get(last.plan)!;
  if (
    a.floor !== b.floor ||
    a.id === b.id ||
    JSON.stringify(a.mints) !== JSON.stringify(b.mints) ||
    simulationBankSlot < a.floor ||
    simulationBankSlot - a.floor > 32 ||
    b.minimum < simulationBankSlot
  )
    return fail();
  for (const [publicCopy, privateCopy] of [
    [before, first],
    [after, last],
  ] as const)
    if (
      publicCopy.rawSha256 !== privateCopy.digest ||
      (await hash(publicCopy.rawBody)) !== privateCopy.digest ||
      publicCopy.requestBody !== privateCopy.plan.body ||
      publicCopy.requestSha256 !==
        (await hash(new TextEncoder().encode(privateCopy.plan.body)))
    )
      return fail();
  const x = await parse(
      first.plan,
      new Response(Uint8Array.from(first.raw)).body,
      signal,
    ),
    y = await parse(
      last.plan,
      new Response(Uint8Array.from(last.raw)).body,
      signal,
    );
  if (
    x.slot > simulationBankSlot ||
    y.slot < simulationBankSlot ||
    before.slot !== x.slot ||
    after.slot !== y.slot
  )
    return fail();
  assertSameSwapMintEvidence(
    { slot: x.slot, mints: x.mints },
    { slot: y.slot, mints: y.mints },
  );
  if (x.rent.dataBase64 !== y.rent.dataBase64) return fail();
  signal.throwIfAborted();
  return {
    format: 'jito-assets-bracket-v1' as const,
    minimumSlot: a.floor,
    simulationBankSlot,
    beforeSlot: x.slot,
    afterSlot: y.slot,
    mints: x.mints,
    minimumSystemReserveLamports: pairRentMinimumRaw(x.rent, 0),
    mintAccounts: a.mints.map((address, i) => ({
      address,
      before: x.accounts[i],
      after: y.accounts[i],
    })),
    rentAccounts: {
      slot: x.slot,
      recheckSlot: y.slot,
      before: x.accounts.at(-1)!,
      after: y.accounts.at(-1)!,
    },
    mintPolicyChecksPassed: true as const,
    rentChecksPassed: true as const,
    providerQualified: false as const,
    sourceAuthenticated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
