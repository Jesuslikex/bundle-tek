import { beforeAll, expect, it } from 'vitest';
import { importedSaleEvidenceFixture } from '../test/imported-sale-evidence-fixture';
import {
  collectImportedSaleEvidence,
  parseImportedSaleEvidence,
  requireImportedSaleParent,
  type ImportedSaleEvidence,
} from './imported-sale-evidence';
import { pumpHolderDigest } from './pump-holder-review';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof importedSaleEvidenceFixture>>;
beforeAll(async () => {
  f = await importedSaleEvidenceFixture();
});
async function rehash(e: ImportedSaleEvidence) {
  const { sha256: _, ...core } = e;
  return { ...core, sha256: await pumpHolderDigest(core) };
}
it.each([false, true])(
  'replays the original signed Metis Sell with lookup tables (Token2022=%s)',
  async (t22) => {
    const f = await importedSaleEvidenceFixture(t22);
    const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
    expect(e.report).toEqual({ ...f.report, acquiredRaw: '1000' });
    expect(e.report.nativeSettlementRaw).toBe('1000000');
    expect(f.calls).toEqual([
      { method: 'getGenesisHash', params: [] },
      {
        method: 'getTransaction',
        params: [
          f.p.signature,
          {
            encoding: 'base64',
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          },
        ],
      },
    ]);
    expect(await parseImportedSaleEvidence(e, f.p, signal())).toEqual(e);
    expect(e).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      acquisitionLinksChanged: false,
      profitCalculated: false,
      economicSettlementVerified: false,
    });
  },
);
it('strips logs and provider extras, detaches capture and refuses extras in stored evidence', async () => {
  const raw = {
    ...structuredClone(f.raw),
    untrusted: 'ignore',
    meta: { ...f.raw.meta, logMessages: ['ignore'] },
  };
  const e = await collectImportedSaleEvidence(f.p, signal(), async (m) =>
    m === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : raw,
  );
  expect(e.raw).not.toHaveProperty('untrusted');
  expect(e.raw.meta).not.toHaveProperty('logMessages');
  raw.meta.fee = '9';
  expect(e.report.networkFeeLamports).toBe('5000');
  e.raw.untrusted = 'extra';
  await expect(
    parseImportedSaleEvidence(await rehash(e), f.p, signal()),
  ).rejects.toThrow();
});
it.each([
  'signature',
  'wallet',
  'state',
  'projectRevision',
  'receiptDocument',
  'preparationDocument',
  'approvalDocument',
])('refuses changed retained parent field %s', async (field) => {
  const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
  const p = { ...f.p, [field]: field === 'projectRevision' ? 2 : 'changed' };
  await expect(parseImportedSaleEvidence(e, p, signal())).rejects.toThrow();
});
it('rejects Buy and invalid summaries before provider access', async () => {
  const p = {
    ...f.p,
    receiptDocument: f.p.receiptDocument.replace(
      '"side":"Sell"',
      '"side":"Buy"',
    ),
  };
  expect(() => requireImportedSaleParent(p)).toThrow();
  let calls = 0;
  await expect(
    collectImportedSaleEvidence(p, signal(), async () => {
      calls++;
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it.each(['fee', 'slot', 'signature', 'balance', 'failure', 'missing'])(
  'refuses changed raw %s even with a recomputed envelope hash',
  async (change) => {
    const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
    const raw = e.raw as typeof f.raw;
    if (change === 'fee') raw.meta.fee = '5001';
    if (change === 'slot') raw.slot = '999';
    if (change === 'signature') raw.transaction[0] = 'AAAA';
    if (change === 'balance') raw.meta.postBalances[0] = '1';
    if (change === 'failure')
      (raw.meta as Record<string, unknown>).err = {
        InstructionError: [0, 'Failed'],
      };
    if (change === 'missing')
      delete (raw.meta as Record<string, unknown>).postTokenBalances;
    await expect(
      parseImportedSaleEvidence(await rehash(e), f.p, signal()),
    ).rejects.toThrow();
  },
);
it.each(['report', 'authority', 'date', 'parentHash'])(
  'rejects self-rehashed envelope tampering: %s',
  async (change) => {
    const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
    if (change === 'report') e.report.nativeSettlementRaw = '1000001';
    if (change === 'authority')
      (e as unknown as Record<string, unknown>).executionAllowed = true;
    if (change === 'date') e.observedAt = 'yesterday';
    if (change === 'parentHash') e.parentSha256 = 'a'.repeat(64);
    await expect(
      parseImportedSaleEvidence(await rehash(e), f.p, signal()),
    ).rejects.toThrow();
  },
);
it('refuses wrong genesis, missing receipts and cancellation without extra reads', async () => {
  let calls = 0;
  await expect(
    collectImportedSaleEvidence(f.p, signal(), async () => {
      calls++;
      return 'wrong';
    }),
  ).rejects.toThrow('mainnet');
  expect(calls).toBe(1);
  await expect(
    collectImportedSaleEvidence(f.p, signal(), async (m) =>
      m === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : null,
    ),
  ).rejects.toThrow();
  const c = new AbortController();
  await expect(
    collectImportedSaleEvidence(f.p, c.signal, async () => {
      c.abort();
      return SOLANA_MAINNET_GENESIS;
    }),
  ).rejects.toThrow();
  await expect(parseImportedSaleEvidence({}, f.p, c.signal)).rejects.toThrow();
});
it('verifies the cryptographic signature, not just its envelope or retained boolean', async () => {
  const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
  const tx = e.raw.transaction as string[];
  const bytes = Uint8Array.from(atob(tx[0]), (c) => c.charCodeAt(0));
  bytes[1] ^= 1;
  tx[0] = btoa(String.fromCharCode(...bytes));
  await expect(
    parseImportedSaleEvidence(await rehash(e), f.p, signal()),
  ).rejects.toThrow();
});
it('rechecks raw balances against a self-rehashed replacement of the retained fee summary', async () => {
  const e = await collectImportedSaleEvidence(f.p, signal(), f.rpc);
  const doc = JSON.parse(f.p.receiptDocument);
  doc.networkFeeLamports = '5001';
  const p = { ...f.p, receiptDocument: JSON.stringify(doc) };
  e.parentSha256 = await pumpHolderDigest(p);
  await expect(
    parseImportedSaleEvidence(await rehash(e), p, signal()),
  ).rejects.toThrow();
});
it('replays historical approvals after their signing deadline without authorizing a new signature', async () => {
  const approval = { ...f.approval, expiresAt: '2020-01-01T00:00:00.000Z' };
  const p = { ...f.p, approvalDocument: JSON.stringify(approval) };
  const e = await collectImportedSaleEvidence(p, signal(), f.rpc);
  expect((await parseImportedSaleEvidence(e, p, signal())).signingAllowed).toBe(
    false,
  );
});
it('bounds stored metadata, envelopes and original source documents', async () => {
  const raw = {
    ...structuredClone(f.raw),
    transaction: ['a'.repeat(1048577), 'base64'],
  };
  await expect(
    collectImportedSaleEvidence(f.p, signal(), async (m) =>
      m === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : raw,
    ),
  ).rejects.toThrow('storage limit');
  await expect(
    parseImportedSaleEvidence({ junk: 'x'.repeat(1310721) }, f.p, signal()),
  ).rejects.toThrow();
  expect(() =>
    requireImportedSaleParent({ ...f.p, approvalDocument: 'x'.repeat(65537) }),
  ).toThrow();
});
