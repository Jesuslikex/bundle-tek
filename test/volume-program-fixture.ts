import bs58 from 'bs58';
import { volumePumpFixture } from './volume-pump-simulation-fixture';
import { key } from './volume-bundle-fixture';
import {
  volumeBytesDigest,
  volumeDigest,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
} from '../lib/volume-bundle-construction';
import { VOLUME_PUMP, VOLUME_PUMP_FEE } from '../lib/volume-bundle-route';
import type { VolumeProgramPolicy } from '../lib/volume-bundle-programs';
import type { PumpProgramIdentity } from '../lib/pump-group-code-identity';
import type {
  VolumeSimulationRpc,
  VolumeSimulationAccount,
} from '../lib/volume-bundle-simulation';
const UPGRADE = 'BPFLoaderUpgradeab1e11111111111111111111111',
  BPF = 'BPFLoader2111111111111111111111111111111111',
  NATIVE = 'NativeLoader1111111111111111111111111111111';
export async function volumeProgramFixture(
  atMs = Math.floor(Date.now() / 1000) * 1000,
) {
  const f = await volumePumpFixture(),
    nowMs = atMs;
  const records = new Map<
      string,
      {
        owner: string;
        executable: boolean;
        lamports: string;
        bytes: Uint8Array;
      }
    >(),
    programs: PumpProgramIdentity[] = [];
  const order = [VOLUME_PUMP, VOLUME_PUMP_FEE, VOLUME_TOKEN, VOLUME_SYSTEM];
  for (const [i, p] of order.entries()) {
    const native = p === VOLUME_SYSTEM,
      upgrade = i < 2,
      code = native
        ? new TextEncoder().encode('system_program')
        : new Uint8Array(128).fill(i + 1);
    if (!native) code.set([127, 69, 76, 70]);
    const dataKey = upgrade ? key(101 + i) : null,
      authority = upgrade ? key(110 + i) : null;
    let header = code;
    if (upgrade) {
      header = new Uint8Array(36);
      new DataView(header.buffer).setUint32(0, 2, true);
      header.set(bs58.decode(dataKey!), 4);
      const data = new Uint8Array(45 + code.length),
        v = new DataView(data.buffer);
      v.setUint32(0, 3, true);
      v.setBigUint64(4, 990n, true);
      data[12] = 1;
      data.set(bs58.decode(authority!), 13);
      data.set(code, 45);
      records.set(dataKey!, {
        owner: UPGRADE,
        executable: false,
        lamports: '1000000',
        bytes: data,
      });
    }
    const loader = native ? NATIVE : upgrade ? UPGRADE : BPF;
    records.set(p, {
      owner: loader,
      executable: true,
      lamports: '1000000',
      bytes: header,
    });
    programs.push({
      address: p,
      loader,
      programData: dataKey,
      deploymentSlot: upgrade ? '990' : null,
      upgradeAuthority: authority,
      codeSha256: await volumeBytesDigest(code),
      codeBytes: code.length,
      identityKind: native ? 'native-system' : 'elf-code',
    });
    const raw: VolumeSimulationAccount = {
      owner: loader,
      executable: true,
      lamports: '1000000',
      data: [btoa(String.fromCharCode(...header)), 'base64'],
    };
    f.before[f.index(p)] = structuredClone(raw);
    f.after[f.index(p)] = structuredClone(raw);
  }
  const terms = {
    format: 'volume-program-policy-v1' as const,
    reviewReference: 'SYNTHETIC TEST POLICY ONLY',
    programs,
  };
  const policy: VolumeProgramPolicy = {
    ...terms,
    sha256: await volumeDigest(terms),
  };
  let phase = 1000;
  const rpc: VolumeSimulationRpc = async (method, params, signal) => {
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown })?.dataSlice
    ) {
      const keys = params[0] as string[],
        config = params[1] as {
          minContextSlot: number;
          dataSlice: { offset: number; length: number };
        };
      phase = Math.max(phase, config.minContextSlot);
      return {
        context: { slot: String(phase) },
        value: keys.map((k) => {
          const a = records.get(k);
          if (!a) throw new Error('Unexpected code account');
          return {
            owner: a.owner,
            executable: a.executable,
            lamports: a.lamports,
            space: String(a.bytes.length),
            data: [
              btoa(
                String.fromCharCode(
                  ...a.bytes.slice(
                    config.dataSlice.offset,
                    config.dataSlice.offset + config.dataSlice.length,
                  ),
                ),
              ),
              'base64',
            ],
          };
        }),
      };
    }
    const raw = await f.rpc(method, params, signal);
    if (typeof raw === 'object' && raw !== null && 'context' in raw) {
      const r = raw as { context: { slot: number } };
      phase = Math.max(
        phase,
        r.context.slot,
        (params[1] as { minContextSlot?: number })?.minContextSlot ?? 0,
      );
      r.context.slot = phase;
    }
    if (method === 'getMultipleAccounts' || method === 'simulateTransaction') {
      const accounts =
        method === 'getMultipleAccounts'
          ? (raw as { value: VolumeSimulationAccount[] }).value
          : (raw as { value: { accounts: VolumeSimulationAccount[] } }).value
              .accounts;
      const a = accounts[accounts.length - 1],
        b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
      new DataView(b.buffer).setBigInt64(32, BigInt(nowMs / 1000), true);
      new DataView(b.buffer).setBigUint64(
        0,
        BigInt((raw as { context: { slot: number } }).context.slot),
        true,
      );
      a.data[0] = btoa(String.fromCharCode(...b));
    }
    return raw;
  };
  return { ...f, policy, rpc, records, nowMs };
}
