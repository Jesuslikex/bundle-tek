import { requireJitoSignatures, type JitoBundleManifest } from "./jito-bundle";
import {
  validatedNativeWithdrawal,
  type NativeWithdrawalReceipt,
} from "./native-withdrawal";
export type JitoFinalization = {
  format: "jito-finalization-v1";
  bundleSha256: string;
  slot: number;
  signatures: string[];
  observedAt: string;
  sha256: string;
  tipReceipt?: NativeWithdrawalReceipt;
};
async function digest(value: Omit<JitoFinalization, "sha256">) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function createJitoFinalization(
  manifest: JitoBundleManifest,
  signatures: string[],
  slot: number,
  observedAt = new Date().toISOString(),
  tipReceipt?: NativeWithdrawalReceipt,
) {
  const terms = {
    format: "jito-finalization-v1" as const,
    bundleSha256: manifest.sha256,
    slot,
    signatures: [...signatures],
    observedAt,
    ...(tipReceipt ? { tipReceipt } : {}),
  };
  const result = { ...terms, sha256: await digest(terms) };
  await requireJitoFinalization(result, manifest, signatures);
  return result;
}
export async function requireJitoFinalization(
  value: JitoFinalization,
  manifest: JitoBundleManifest,
  signatures: Array<string | null>,
) {
  if (
    !value ||
    value.format !== "jito-finalization-v1" ||
    value.bundleSha256 !== manifest.sha256 ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 1 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.signatures) ||
    value.signatures.length !== manifest.swaps.length + 1 ||
    JSON.stringify(value.signatures) !== JSON.stringify(signatures)
  )
    throw new Error("Finalization receipt differs.");
  requireJitoSignatures(value.signatures);
  if (value.tipReceipt !== undefined) {
    if (!value.tipReceipt || value.tipReceipt.slot !== value.slot)
      throw new Error("Finalized tip slot differs.");
    await validatedNativeWithdrawal({
      id: manifest.tip.id,
      wallet: manifest.tip.wallet,
      walletRevision: manifest.tip.walletRevision,
      state: "finalized",
      signature: value.signatures.at(-1),
      document: manifest.tip,
      receipt: value.tipReceipt,
      createdAt: manifest.createdAt,
      updatedAt: value.observedAt,
    });
  }
  const { sha256, ...terms } = value;
  if (sha256 !== (await digest(terms)))
    throw new Error("Finalization receipt fingerprint differs.");
  return value;
}
