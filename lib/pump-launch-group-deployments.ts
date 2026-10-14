import bs58 from 'bs58';
import {
  pumpAccountBytes,
  type PumpRpcAccount,
} from './pump-launch-simulation';

export const PUMP_UPGRADEABLE_LOADER =
  'BPFLoaderUpgradeab1e11111111111111111111111';
const BPF2 = 'BPFLoader2111111111111111111111111111111111';
const NATIVE = 'NativeLoader1111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
export async function pumpDeploymentHash(value: unknown) {
  return Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  ).toString('hex');
}

/** Restricted executable-loader profile. Native acceptance is only for the known System program. */
export function pumpGroupProgramDataLink(
  address: string,
  account: PumpRpcAccount,
) {
  if (
    !account?.executable ||
    ![
      BPF2,
      PUMP_UPGRADEABLE_LOADER,
      ...(address === SYSTEM ? [NATIVE] : []),
    ].includes(account.owner)
  )
    throw new Error('Group executable or loader profile differs.');
  if (account.owner !== PUMP_UPGRADEABLE_LOADER) return null;
  const bytes = pumpAccountBytes(account);
  if (
    bytes.length !== 36 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) !== 2
  )
    throw new Error('Group executable deployment link differs.');
  return bs58.encode(bytes.slice(4));
}

/** Only the 45-byte deployment metadata slice is reviewed. This does not attest executable code. */
export function requirePumpGroupDeploymentHeader(
  account: PumpRpcAccount,
  replayBank: number,
) {
  if (
    !account ||
    account.executable ||
    account.owner !== PUMP_UPGRADEABLE_LOADER
  )
    throw new Error('Group deployment metadata owner differs.');
  const bytes = pumpAccountBytes(account),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length !== 45 ||
    view.getUint32(0, true) !== 3 ||
    bytes[12] > 1 ||
    view.getBigUint64(4, true) > BigInt(replayBank)
  )
    throw new Error(
      'Group deployment metadata is malformed or newer than replay bank.',
    );
}
