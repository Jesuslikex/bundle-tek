import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { jitoBundleFixture } from './jito-bundle-fixture';
import { bundleFingerprint, requireJitoManifest } from '../lib/jito-bundle';
import { formatNativeBalance } from '../lib/wallet-balance-format';
it('builds a public synthetic four-wallet fixture for isolated browser review', async () => {
  const f = await jitoBundleFixture(4);
  const preparedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(preparedAt) + 60_000).toISOString();
  const { sha256: _, ...original } = f.manifest;
  const terms = {
    ...original,
    expiresAt,
    swaps: original.swaps.map((r) => ({ ...r, expiresAt })),
    tip: { ...original.tip, preparedAt, expiresAt },
  };
  const manifest = { ...terms, sha256: await bundleFingerprint(terms) };
  await expect(requireJitoManifest(manifest)).resolves.toBe(manifest);
  const session = {
    id: manifest.sessionId,
    revision: 1,
    state: 'active',
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    terms: {
      format: 'imported-trade-session-v1',
      projectId: manifest.projectId,
      projectRevision: 1,
      mint: manifest.swaps[0].outputMint,
      decimals: 6,
      side: 'Buy',
      totalRaw: (BigInt(manifest.swaps[0].inputRaw) * 4n).toString(),
      entries: manifest.swaps.map((r, i) => ({
        entry: i + 1,
        wallet: r.wallet,
        walletRevision: 1,
        unitsRaw: r.inputRaw,
        amount: formatNativeBalance(r.inputRaw, 9),
      })),
    },
  };
  await mkdir('work/jito-bundle-qa', { recursive: true });
  await writeFile(
    'work/jito-bundle-qa/fixture.json',
    JSON.stringify({
      manifest,
      session,
      signed: [...f.swaps.map((s) => s.signed), f.tip.signed],
    }),
  );
});
