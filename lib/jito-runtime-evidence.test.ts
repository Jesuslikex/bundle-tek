import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectJitoCoherentSimulationAttempt } from './jito-coherent-simulation-attempt';
import {
  collectJitoRuntimeEvidence,
  verifyJitoRuntimeBracket,
  JITO_RESERVED_WRITE_KEYS,
  jitoRuntimePolicyRefusal,
} from './jito-runtime-evidence';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { JitoBundleSimulationPacket } from './jito-bundle-simulation-frames';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const signal = () => new AbortController().signal;
async function fixture() {
  const saved = JSON.parse(
    readFileSync('test/fixtures/jito-coherent-native-20261024.json', 'utf8'),
  ).cases[1];
  let i = 0;
  const captured = await collectJitoCoherentSimulationAttempt({
    packets: saved.packets as JitoBundleSimulationPacket[],
    minimumSlot: saved.originalFloor,
    minimumReadSlot: saved.accountSlot,
    feeIdPrefix: 'native-fees:1',
    simulationRpcId: 'native-exact:1',
    verifySignatures: false,
    signal: signal(),
    transport: async () => new Response(saved.reads[i++].response),
  });
  if (captured.status !== 'captured') throw Error('native fixture refused');
  const frames = captured.simulation.frames,
    keys = [...new Set(frames.frames.flatMap((f) => f.keys))],
    map = new Map(
      frames.frames.flatMap((f) =>
        f.keys.map((k, n) => [k, f.preAccounts[n]] as const),
      ),
    );
  const rpc: PumpLaunchRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    const config = params[1] as {
      dataSlice: { offset: number; length: number };
    };
    return {
      context: { slot: String(frames.slot) },
      value: (params[0] as string[]).map((k) => {
        const a = map.get(k);
        if (!a) return null;
        const b = a.data;
        return {
          owner: a.owner,
          executable: a.executable,
          lamports: a.lamports,
          space: String(b.length),
          data: [
            Buffer.from(
              b.slice(
                config.dataSlice.offset,
                config.dataSlice.offset + config.dataSlice.length,
              ),
            ).toString('base64'),
            'base64',
          ],
        };
      }),
    };
  };
  return { frames, keys, rpc, floor: saved.originalFloor };
}
it('requires two complete serial code scans, pinned code policy and original bank bracketing', async () => {
  const f = await fixture(),
    a = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.floor,
      signal(),
      f.rpc,
    ),
    b = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.frames.slot,
      signal(),
      f.rpc,
    );
  const result = await verifyJitoRuntimeBracket(a, b, f.frames, signal());
  expect(result).toMatchObject({
    fullCodeScansMatched: true,
    reviewedCodePolicyMatched: true,
    conservativeRuntimeChecksPassed: true,
    runtimePrivilegesVerified: false,
    signingAllowed: false,
    runtimeAttested: false,
  });
  expect(a.programs).toHaveLength(1);
  expect(a.programs[0].identityKind).toBe('native-system');
});
for (const variant of ['code', 'bank', 'network'] as const)
  it(`refuses actual runtime ${variant} changes instead of trusting a program ID`, async () => {
    const f = await fixture();
    const rpc: PumpLaunchRpc = async (method, params, s) => {
      const result = await f.rpc(method, params, s);
      if (variant === 'network' && method === 'getGenesisHash') return 'wrong';
      if (method === 'getMultipleAccounts') {
        const x = result as {
          context: { slot: string };
          value: ({
            owner: string;
            executable: boolean;
            data: string[];
          } | null)[];
        };
        if (variant === 'bank') x.context.slot = String(f.floor + 33);
        if (variant === 'code')
          for (const a of x.value)
            if (a?.executable)
              a.data[0] = Buffer.from('different code').toString('base64');
      }
      return result;
    };
    await expect(
      collectJitoRuntimeEvidence(f.keys, f.floor, f.floor, signal(), rpc),
    ).rejects.toThrow();
  });
it('rejects writable reserved keys and executable programs even when frames claim no changes', async () => {
  const f = await fixture(),
    a = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.floor,
      signal(),
      f.rpc,
    ),
    b = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.frames.slot,
      signal(),
      f.rpc,
    );
  const copy = structuredClone(f.frames),
    index = copy.frames[0].keys.indexOf('11111111111111111111111111111111');
  copy.frames[0].requestedWritable[index] = true;
  await expect(
    verifyJitoRuntimeBracket(a, b, copy, signal()),
  ).rejects.toThrow();
  expect(JITO_RESERVED_WRITE_KEYS).toHaveLength(31);
  expect(new Set(JITO_RESERVED_WRITE_KEYS).size).toBe(31);
});
it('refuses mutable or forged runtime summaries and mismatched exact packet account coverage', async () => {
  const f = await fixture(),
    a = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.floor,
      signal(),
      f.rpc,
    ),
    b = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.frames.slot,
      signal(),
      f.rpc,
    );
  await expect(
    verifyJitoRuntimeBracket({ ...a }, b, f.frames, signal()),
  ).rejects.toThrow();
  a.programs[0].codeSha256 = '0'.repeat(64);
  await expect(
    verifyJitoRuntimeBracket(a, b, f.frames, signal()),
  ).rejects.toThrow();
});

it('records a real policy refusal as diagnostics only, never as replacement allowlist evidence', async () => {
  const f = await fixture();
  const rpc: PumpLaunchRpc = async (method, params, s) => {
    const result = await f.rpc(method, params, s);
    if (method === 'getMultipleAccounts')
      for (const a of (
        result as { value: ({ executable: boolean; data: string[] } | null)[] }
      ).value)
        if (a?.executable)
          a.data[0] = Buffer.from('different code').toString('base64');
    return result;
  };
  let caught: unknown;
  try {
    await collectJitoRuntimeEvidence(f.keys, f.floor, f.floor, signal(), rpc);
  } catch (e) {
    caught = e;
  }
  const refusal = jitoRuntimePolicyRefusal(caught);
  expect(refusal).toMatchObject({
    reason: 'program-policy-refused',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(refusal?.differences[0].observed.codeSha256).not.toBe(
    refusal?.differences[0].expected?.codeSha256[0],
  );
  expect(
    jitoRuntimePolicyRefusal({ reason: 'program-policy-refused' }),
  ).toBeNull();
});
it('cancels a noncooperative inventory promise without making another code request', async () => {
  const c = new AbortController();
  let called = 0;
  const rpc: PumpLaunchRpc = async () => {
    called++;
    return await new Promise(() => {});
  };
  const pending = collectJitoRuntimeEvidence(
    ['11111111111111111111111111111111'],
    100,
    100,
    c.signal,
    rpc,
  );
  await Promise.resolve();
  c.abort();
  await expect(pending).rejects.toThrow();
  expect(called).toBeLessThanOrEqual(1);
});

it('refuses missing executable frame state independently of requested privileges', async () => {
  const f = await fixture(),
    a = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.floor,
      signal(),
      f.rpc,
    ),
    b = await collectJitoRuntimeEvidence(
      f.keys,
      f.floor,
      f.frames.slot,
      signal(),
      f.rpc,
    );
  const modified = structuredClone(f.frames);
  const index = modified.frames[0].keys.indexOf(
    '11111111111111111111111111111111',
  );
  modified.frames[0].preAccounts[index] = null;
  modified.frames[0].postAccounts[index] = null;
  await expect(
    verifyJitoRuntimeBracket(a, b, modified, signal()),
  ).rejects.toThrow();
});
