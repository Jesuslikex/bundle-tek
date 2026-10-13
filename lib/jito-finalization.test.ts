import { expect, it } from "vitest";
import { jitoBundleFixture } from "../test/jito-bundle-fixture";
import { decodeNativeWithdrawalReceipt } from "./native-withdrawal-server";
import {
  createJitoFinalization,
  requireJitoFinalization,
} from "./jito-finalization";
it("binds retained slot evidence to the exact manifest and ordered signatures", async () => {
  const f = await jitoBundleFixture(),
    signatures = [f.swap.signed.signature, f.tip.signed.signature];
  const receipt = await createJitoFinalization(f.manifest, signatures, 12345);
  expect(
    await requireJitoFinalization(
      JSON.parse(JSON.stringify(receipt)),
      f.manifest,
      signatures,
    ),
  ).toEqual(receipt);
  for (const altered of [
    { ...receipt, slot: 12346 },
    { ...receipt, sha256: "00".repeat(32) },
    { ...receipt, observedAt: "invalid" },
    { ...receipt, signatures: [...signatures].reverse() },
  ])
    await expect(
      requireJitoFinalization(altered, f.manifest, signatures),
    ).rejects.toThrow();
  await expect(
    requireJitoFinalization(
      receipt,
      { ...f.manifest, sha256: "ab".repeat(32) },
      signatures,
    ),
  ).rejects.toThrow();
  await expect(
    createJitoFinalization(f.manifest, signatures, Number.MAX_SAFE_INTEGER + 1),
  ).rejects.toThrow();
});
it("retains observed tip fees and settlement under the finalization fingerprint", async () => {
  const f = await jitoBundleFixture(4);
  const signatures = [
    ...f.swaps.map((s) => s.signed.signature),
    f.tip.signed.signature,
  ];
  const tip = await decodeNativeWithdrawalReceipt(
    f.tip.receipt,
    f.manifest.tip,
    f.tip.signed.signature,
  );
  if (!("amountRaw" in tip)) throw new Error("Expected successful tip fixture");
  const receipt = await createJitoFinalization(
    f.manifest,
    signatures,
    tip.slot,
    new Date().toISOString(),
    tip,
  );
  expect(receipt.tipReceipt?.networkFeeLamports).toBe(f.tip.receipt.meta.fee);
  expect(
    new TextEncoder().encode(JSON.stringify(receipt)).length,
  ).toBeLessThanOrEqual(2048);
  expect(
    await requireJitoFinalization(
      JSON.parse(JSON.stringify(receipt)),
      f.manifest,
      signatures,
    ),
  ).toEqual(receipt);
  await expect(
    requireJitoFinalization(
      { ...receipt, tipReceipt: { ...tip, source: "changed.test" } },
      f.manifest,
      signatures,
    ),
  ).rejects.toThrow("fingerprint");
  for (const changed of [
    { ...tip, slot: tip.slot + 1 },
    { ...tip, recipient: f.manifest.tip.wallet },
    { ...tip, amountRaw: "1" },
    {
      ...tip,
      networkFeeLamports: (BigInt(f.manifest.tip.feeLamports) + 1n).toString(),
    },
    { ...tip, walletChangeRaw: "0" },
    { ...tip, recipientChangeRaw: "0" },
  ])
    await expect(
      createJitoFinalization(
        f.manifest,
        signatures,
        tip.slot,
        receipt.observedAt,
        changed,
      ),
    ).rejects.toThrow();
  const legacy = await createJitoFinalization(f.manifest, signatures, tip.slot);
  expect(legacy.tipReceipt).toBeUndefined();
  expect(await requireJitoFinalization(legacy, f.manifest, signatures)).toEqual(
    legacy,
  );
});
