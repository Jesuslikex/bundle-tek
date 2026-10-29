import bs58 from 'bs58';
import {
  buildJitoBundleSimulationRequest,
  type JitoBundleSimulationPacket,
} from './jito-bundle-simulation-frames';
import {
  inspectJitoSimulationDecimal,
  readJitoSimulationPayload,
} from './jito-simulation-json';
import { readJitoSimulationResponse } from './jito-simulation-response';

const fail = (): never => {
  throw Error('Same-bank prototype evidence refused.');
};
function obj(v: unknown): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    inspectJitoSimulationDecimal(v) !== null
  )
    return fail();
  return v as Record<string, unknown>;
}
function fields(v: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail();
}
function hash(v: unknown): string {
  if (typeof v !== 'string') return fail();
  try {
    const b = bs58.decode(v);
    if (b.length === 32 && bs58.encode(b) === v) return v;
  } catch {
    /* fail below */
  }
  return fail();
}
// A projection of already bounded, strictly parsed JSON. Numbers remain numbers,
// including opaque decimal tokens; this is never represented as provider wire.
function encode(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string')
    return JSON.stringify(v);
  if (typeof v === 'bigint') return v.toString();
  const decimal = inspectJitoSimulationDecimal(v);
  if (decimal !== null) return decimal;
  if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
  const o = obj(v);
  return (
    '{' +
    Object.keys(o)
      .map((k) => JSON.stringify(k) + ':' + encode(o[k]))
      .join(',') +
    '}'
  );
}

/** Local research adapter. Caller must separately bind actual network transport to
 * requestBody. A server assertion and these synthetic frames grant no authority. */
export async function readJitoSameBankPrototype(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  simulationBankSlot: number;
  rpcId: string;
  requestBody: string;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
}) {
  const {
    packets,
    minimumSlot,
    simulationBankSlot,
    rpcId,
    requestBody,
    body,
    signal,
  } = input;
  if (
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(simulationBankSlot) ||
    simulationBankSlot < minimumSlot ||
    simulationBankSlot - minimumSlot > 32 ||
    typeof rpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(rpcId)
  )
    return fail();
  const plan = await buildJitoBundleSimulationRequest(
    packets,
    simulationBankSlot,
    {
      bankEncoding: 'slot-object',
      verifySignatures: false,
    },
  );
  const expected = JSON.stringify({
    jsonrpc: '2.0',
    id: rpcId,
    method: 'simulateBundleWithSameBankFees',
    params: plan.params,
  });
  if (requestBody !== expected) return fail();
  const raw = await readJitoSimulationPayload(body, signal, 4194304, {
    allowDecimalTokens: true,
  });
  const envelope = obj(raw.value);
  fields(envelope, ['jsonrpc', 'id', 'result']);
  if (envelope.jsonrpc !== '2.0' || envelope.id !== rpcId) return fail();
  const result = obj(envelope.result);
  fields(result, ['context', 'value']);
  const context = obj(result.context);
  fields(
    context,
    Object.hasOwn(context, 'apiVersion') ? ['slot', 'apiVersion'] : ['slot'],
  );
  if (context.slot !== BigInt(simulationBankSlot)) return fail();
  const value = obj(result.value);
  fields(value, ['bankHash', 'independentFees', 'packetHashes', 'simulation']);
  const bankHash = hash(value.bankHash);
  if (
    !Array.isArray(value.independentFees) ||
    !Array.isArray(value.packetHashes) ||
    value.independentFees.length !== plan.packetBindings.length ||
    value.packetHashes.length !== plan.packetBindings.length
  )
    return fail();
  for (let i = 0; i < plan.packetBindings.length; i++) {
    const expectedPacketHash = bs58.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          Buffer.from(plan.packetBindings[i].transaction, 'base64'),
        ),
      ),
    );
    if (
      hash(value.packetHashes[i]) !== expectedPacketHash ||
      typeof value.independentFees[i] !== 'bigint' ||
      value.independentFees[i] !==
        BigInt(plan.packetBindings[i].expectedFeeLamports)
    )
      return fail();
  }
  const projected = encode({
    jsonrpc: '2.0',
    id: rpcId,
    result: { context, value: value.simulation },
  });
  const simulation = await readJitoSimulationResponse({
    profile: 'jito-rust-raw-frames-v1',
    packets: plan.packetBindings,
    minimumSlot,
    simulationBankSlot,
    bankEncoding: 'slot-object',
    verifySignatures: false,
    rpcId,
    body: new Response(projected).body,
    signal,
  });
  if (simulation.status !== 'admitted') return fail();
  for (let i = 0; i < simulation.frames.frames.length; i++) {
    if (
      BigInt(simulation.frames.frames[i].feeLamports) !==
      value.independentFees[i]
    )
      return fail();
  }
  return {
    raw,
    bankHash,
    simulation,
    requestBody,
    projection: 'derived-json-not-provider-wire' as const,
    bankIdentityVerified: false as const,
    sourceAuthenticated: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
