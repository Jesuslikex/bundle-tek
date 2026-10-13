import { expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import {
  bundleFingerprint,
  requireJitoManifest,
  jitoIntentSelection,
  jitoTipLamports,
  decodeJitoStatus,
} from './jito-bundle';
import { getJitoTipAccounts, jitoRpc } from './jito-provider';
it('binds every ordered swap, exact tip and expiry to one fingerprint', async () => {
  const { manifest } = await jitoBundleFixture();
  await expect(requireJitoManifest(manifest)).resolves.toBe(manifest);
  for (const changed of [
    { ...manifest, tip: { ...manifest.tip, amountRaw: '1001' } },
    { ...manifest, swaps: [{ ...manifest.swaps[0], minimumOutputRaw: '1' }] },
    { ...manifest, sessionId: crypto.randomUUID() },
  ])
    await expect(requireJitoManifest(changed)).rejects.toThrow('fingerprint');
  const { sha256: _, ...terms } = manifest;
  const duplicate = { ...terms, swaps: [manifest.swaps[0], manifest.swaps[0]] };
  await expect(
    requireJitoManifest({
      ...duplicate,
      sha256: await bundleFingerprint(duplicate),
    }),
  ).rejects.toThrow();
});
it('bounds atomic selections and explicit tips without splitting into multiple bundles', () => {
  expect(jitoIntentSelection([crypto.randomUUID()])).toHaveLength(1);
  expect(jitoTipLamports('1000')).toBe('1000');
  for (const n of ['999', '10000001', '-1000', '1e4', '01000'])
    expect(() => jitoTipLamports(n)).toThrow();
  for (const ids of [
    [],
    Array.from({ length: 5 }, () => crypto.randomUUID()),
    ['bad'],
  ])
    expect(() => jitoIntentSelection(ids)).toThrow();
});
it('rejects reordered signatures, errors and unrelated bundle acknowledgements', async () => {
  const f = await jitoBundleFixture(),
    signatures = [f.swap.signed.signature, f.tip.signed.signature],
    id = 'ab'.repeat(32);
  const status = {
    bundle_id: id,
    transactions: signatures,
    slot: 500,
    confirmation_status: 'finalized',
    err: { Ok: null },
  };
  expect(decodeJitoStatus({ value: [status] }, id, signatures)).toEqual({
    slot: 500,
    commitment: 'finalized',
  });
  expect(decodeJitoStatus({ value: [] }, id, signatures)).toBeNull();
  for (const changed of [
    { ...status, transactions: signatures.toReversed() },
    { ...status, bundle_id: '00'.repeat(32) },
    { ...status, err: { Err: 'failed' } },
    { ...status, slot: -1 },
  ])
    expect(() =>
      decodeJitoStatus({ value: [changed] }, id, signatures),
    ).toThrow();
});
it('uses only the fixed Jito endpoint, base64 transport and bounded RPC responses', async () => {
  const f = await jitoBundleFixture();
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: 1, result: [f.tip.recipient] }),
  );
  expect(await getJitoTipAccounts(AbortSignal.timeout(1000), fetcher)).toEqual([
    f.tip.recipient,
  ]);
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  );
  await expect(
    jitoRpc('getTipAccounts', [], AbortSignal.timeout(1000), async () =>
      Response.json({ jsonrpc: '2.0', id: 2, result: [] }),
    ),
  ).rejects.toThrow();
  await expect(
    jitoRpc(
      'getTipAccounts',
      [],
      AbortSignal.timeout(1000),
      async () => new Response('x'.repeat(32769)),
    ),
  ).rejects.toThrow();
});
