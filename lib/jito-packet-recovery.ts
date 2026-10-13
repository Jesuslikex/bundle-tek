import { requireJitoManifest, type JitoBundleManifest } from './jito-bundle';
import { verifyExactSwapSignature } from './exact-swap-signature';
import { inspectNativeWithdrawal } from './native-withdrawal';

export const JITO_RECOVERY_FILE_MAX_BYTES = 4096;
type Recovery = {
  format: 'jito-signed-packet-recovery-v1';
  projectId: string;
  sessionId: string;
  bundleId: string;
  sha256: string;
  packet: number;
  signature: string;
  transaction: string;
};
export async function createJitoPacketRecovery(
  manifest: JitoBundleManifest,
  packet: number,
  transaction: string,
): Promise<Recovery> {
  await requireJitoManifest(manifest, false);
  if (!Number.isInteger(packet) || packet < 0 || packet > manifest.swaps.length)
    throw new Error('Recovery packet position differs.');
  const swap = manifest.swaps[packet];
  const signature = swap
    ? verifyExactSwapSignature(swap, transaction)
    : (await inspectNativeWithdrawal(manifest.tip, transaction, true))
        .signature!;
  return {
    format: 'jito-signed-packet-recovery-v1',
    projectId: manifest.projectId,
    sessionId: manifest.sessionId,
    bundleId: manifest.id,
    sha256: manifest.sha256,
    packet,
    signature,
    transaction,
  };
}
export async function readJitoPacketRecovery(
  text: string,
  manifest: JitoBundleManifest,
  packet: number,
) {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > JITO_RECOVERY_FILE_MAX_BYTES
  )
    throw new Error('Recovery file exceeds the packet limit.');
  const value = JSON.parse(text) as Recovery;
  if (
    !value ||
    value.format !== 'jito-signed-packet-recovery-v1' ||
    value.projectId !== manifest.projectId ||
    value.sessionId !== manifest.sessionId ||
    value.bundleId !== manifest.id ||
    value.sha256 !== manifest.sha256 ||
    value.packet !== packet ||
    typeof value.transaction !== 'string'
  )
    throw new Error('Recovery file belongs to a different bundle or packet.');
  const checked = await createJitoPacketRecovery(
    manifest,
    packet,
    value.transaction,
  );
  if (
    value.signature !== checked.signature ||
    Object.keys(value).some((key) => !Object.hasOwn(checked, key))
  )
    throw new Error('Recovery packet signature or fields differ.');
  return checked;
}
