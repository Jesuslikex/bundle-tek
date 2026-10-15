import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  collectPumpProgramIdentities,
  matchesPumpProgramPolicy,
} from './pump-group-code-identity';
import { PUMP_UPGRADEABLE_LOADER } from './pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const program = bs58.encode(new Uint8Array(32).fill(2)),
  dataKey = bs58.encode(new Uint8Array(32).fill(3)),
  system = '11111111111111111111111111111111';
function fixture(kind = 'ok', space = true) {
  let headerReads = 0;
  const calls: string[] = [];
  const code = new Uint8Array(300000);
  code.set([127, 69, 76, 70]);
  const link = new Uint8Array(36);
  new DataView(link.buffer).setUint32(0, 2, true);
  link.set(new Uint8Array(32).fill(3), 4);
  const full = new Uint8Array(45 + code.length);
  const view = new DataView(full.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 90n, true);
  full[12] = 1;
  full.fill(4, 13, 45);
  full.set(code, 45);
  const rpc: PumpLaunchRpc = async (method, params) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts')
      throw new Error('No other RPC methods');
    const keys = params[0] as string[],
      config = params[1] as { dataSlice: { offset: number; length: number } };
    const slice = config.dataSlice;
    if (keys.includes(dataKey) && slice.offset === 0) headerReads++;
    return {
      context: { slot: kind === 'drift' ? '133' : '100' },
      value: keys.map((key) => {
        let bytes =
          key === program
            ? link
            : key === system
              ? Buffer.from('system_program')
              : full;
        if (kind === 'authority' && key === dataKey && headerReads > 1) {
          bytes = bytes.slice();
          bytes[13] = 9;
        }
        if (kind === 'not-elf' && key === dataKey) {
          bytes = bytes.slice();
          bytes[45] = 0;
        }
        return {
          owner:
            key === system
              ? 'NativeLoader1111111111111111111111111111111'
              : PUMP_UPGRADEABLE_LOADER,
          executable: key !== dataKey,
          lamports: '1000000',
          ...(space
            ? {
                space: String(
                  bytes.length +
                    (kind === 'truncated' && key === dataKey ? 1 : 0),
                ),
              }
            : {}),
          data: [
            Buffer.from(
              bytes.slice(slice.offset, slice.offset + slice.length),
            ).toString('base64'),
            'base64',
          ],
        };
      }),
    };
  };
  return { rpc, calls };
}
it.each([true, false])(
  'hashes complete sliced code and upgrade authority with declared space %s',
  async (space) => {
    const f = fixture('ok', space);
    const report = await collectPumpProgramIdentities(
      [program, system],
      100,
      new AbortController().signal,
      f.rpc,
    );
    expect(report.programs[0]).toMatchObject({
      address: program,
      programData: dataKey,
      codeBytes: 300000,
      deploymentSlot: '90',
      upgradeAuthority: bs58.encode(new Uint8Array(32).fill(4)),
      identityKind: 'elf-code',
    });
    expect(report.programs[1].identityKind).toBe('native-system');
    expect(report.totalCodeBytes).toBe(300000);
    expect(report.semanticAuditEstablished).toBe(false);
    expect(report.signingAllowed).toBe(false);
    expect(matchesPumpProgramPolicy(report, null)).toBe(false);
    expect(
      matchesPumpProgramPolicy(report, {
        programs: report.programs,
        reviewReference: 'controlled fixture policy',
        policySha256: 'a'.repeat(64),
      }),
    ).toBe(true);
    expect(
      f.calls.every((method) =>
        ['getGenesisHash', 'getMultipleAccounts'].includes(method),
      ),
    ).toBe(true);
  },
);
it.each(['drift', 'authority', 'not-elf', 'truncated'])(
  'rejects %s code evidence',
  async (kind) => {
    const f = fixture(kind);
    await expect(
      collectPumpProgramIdentities(
        [program, system],
        100,
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow();
  },
);
it('rejects missing or repeated program scope and pre-aborted reads', async () => {
  const f = fixture();
  await expect(
    collectPumpProgramIdentities(
      [program, program],
      100,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('scope');
  const controller = new AbortController();
  controller.abort();
  await expect(
    collectPumpProgramIdentities([program], 100, controller.signal, f.rpc),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
