import { expect, it, vi } from 'vitest';
import * as manifestBindings from './wallet-warmup-execution-manifest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { createHash } from 'node:crypto';
import {
  executionManifest,
  executionHash,
} from '../test/warmup-execution-ledger-fixture';
import { executionCapacityManifest } from '../test/warmup-execution-capacity-fixture';
import {
  packWarmupExecutionArchive as pack,
  unpackWarmupExecutionArchive as unpack,
  WARMUP_ARCHIVE_CHUNK_BYTES,
  WARMUP_ARCHIVE_MAX_BYTES,
} from './wallet-warmup-execution-archive';
const expected = (h: Awaited<ReturnType<typeof pack>>['header']) => ({
  id: h.id,
  ownerId: h.ownerId,
  manifestSha256: h.manifestSha256,
});
it.each(['saved', 'mixed'] as const)(
  'retains every action/lot in a full %s manifest beyond a single D1 row',
  async (kind) => {
    const m = executionCapacityManifest(kind),
      a = await pack(m);
    expect(a.header.bytes).toBeGreaterThan(2000000);
    expect(a.header.bytes).toBeLessThan(WARMUP_ARCHIVE_MAX_BYTES);
    expect(a.chunks.length).toBeGreaterThan(1);
    expect(
      a.chunks.every((c) => c.data.length <= WARMUP_ARCHIVE_CHUNK_BYTES),
    ).toBe(true);
    const r = await unpack(a.header, a.chunks, expected(a.header));
    expect(r.manifest).toEqual(m);
    expect(r.manifest.actions).toHaveLength(4800);
    expect(r).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
  },
);
it.each(['escaped', 'unicode', 'surrogate'] as const)(
  'round trips admitted %s IDs by complete bytes, without per-chunk text decoding',
  async (ids) => {
    const m = executionCapacityManifest('saved', ids),
      a = await pack(m);
    expect(a.header.bytes).toBeGreaterThan(2000000);
    expect(
      (await unpack(a.header, a.chunks, expected(a.header))).manifest,
    ).toEqual(m);
    if (ids === 'unicode')
      expect(
        a.chunks.some((c) => {
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(c.data);
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
  },
);
it.each(['owner', 'id', 'hash'] as const)(
  'requires external expected %s binding rather than trusting the archive header',
  async (field) => {
    const a = await pack(executionManifest()),
      e = expected(a.header);
    if (field === 'owner') e.ownerId = 'another-owner';
    if (field === 'id') e.id = '00000000-0000-4000-8000-000000000099';
    if (field === 'hash') e.manifestSha256 = executionHash(99);
    await expect(unpack(a.header, a.chunks, e)).rejects.toThrow();
  },
);
it.each([
  'missing',
  'extra',
  'reordered',
  'duplicate',
  'data',
  'index',
  'length',
  'header-index',
  'header-bytes',
  'header-hash',
  'authority',
  'extra-key',
] as const)(
  'refuses %s archive mutations without returning a partial projection',
  async (change) => {
    const a = await pack(executionCapacityManifest()),
      e = expected(a.header);
    switch (change) {
      case 'missing':
        a.chunks.pop();
        break;
      case 'extra':
        a.chunks.push(a.chunks[0]);
        break;
      case 'reordered':
        a.chunks.reverse();
        break;
      case 'duplicate':
        a.chunks[1] = a.chunks[0];
        break;
      case 'data':
        a.chunks[0].data[0] ^= 1;
        break;
      case 'index':
        a.chunks[0].index = 1;
        break;
      case 'length':
        a.chunks[0].data = a.chunks[0].data.slice(1);
        break;
      case 'header-index':
        a.header.chunks[0].index = 1;
        break;
      case 'header-bytes':
        a.header.bytes--;
        break;
      case 'header-hash':
        a.header.chunks[0].sha256 = executionHash(99);
        break;
      case 'authority':
        Object.assign(a.header, { signingAllowed: true });
        break;
      case 'extra-key':
        Object.assign(a.chunks[0], { proof: true });
        break;
    }
    await expect(unpack(a.header, a.chunks, e)).rejects.toThrow();
  },
);
it('captures mutable input bytes and header before asynchronous hashing, and returns detached model data', async () => {
  const a = await pack(executionManifest()),
    e = expected(a.header);
  const reading = unpack(a.header, a.chunks, e);
  a.chunks[0].data.fill(0);
  a.header.chunks[0].sha256 = executionHash(99);
  e.ownerId = 'changed';
  const r = await reading;
  expect(r.manifest.ownerId).toBe('synthetic-owner');
  r.manifest.actions.pop();
  expect(executionManifest().actions).toHaveLength(2);
});
it('refuses rehashed corrupt chunks against the separately expected complete digest', async () => {
  const a = await pack(executionManifest()),
    e = expected(a.header);
  a.chunks[0].data[0] ^= 1;
  a.header.chunks[0].sha256 = createHash('sha256')
    .update(a.chunks[0].data)
    .digest('hex');
  await expect(unpack(a.header, a.chunks, e)).rejects.toThrow();
});
it.each(['noncanonical', 'invalid-manifest', 'invalid-utf8', 'bom'] as const)(
  'does not admit a self-consistent %s envelope as a valid model',
  async (kind) => {
    const a = await pack(executionManifest());
    const data =
      kind === 'noncanonical'
        ? new TextEncoder().encode(JSON.stringify(executionManifest(), null, 2))
        : kind === 'invalid-manifest'
          ? new TextEncoder().encode('{}')
          : kind === 'bom'
            ? new Uint8Array([
                0xef,
                0xbb,
                0xbf,
                ...new TextEncoder().encode(canonical(executionManifest())),
              ])
            : new Uint8Array([0xff]);
    const digest = createHash('sha256').update(data).digest('hex');
    a.header.bytes = data.length;
    a.header.manifestSha256 = digest;
    a.header.chunks = [{ index: 0, bytes: data.length, sha256: digest }];
    await expect(
      unpack(a.header, [{ index: 0, data }], expected(a.header)),
    ).rejects.toThrow();
  },
);
it('captures the parsed manifest before asynchronous hashing and never truncates actions', async () => {
  const m = executionManifest(),
    packing = pack(m);
  m.actions.pop();
  const a = await packing;
  expect(
    (await unpack(a.header, a.chunks, expected(a.header))).manifest.actions,
  ).toHaveLength(2);
});
it('refuses packing if the model digest and archive byte digest disagree', async () => {
  const bound =
    await manifestBindings.bindWarmupExecutionManifest(executionManifest());
  const spy = vi
    .spyOn(manifestBindings, 'bindWarmupExecutionManifest')
    .mockResolvedValue({ ...bound, sha256: executionHash(999) });
  try {
    await expect(pack(executionManifest())).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});
it('requires byte views and a complete strict expected identity', async () => {
  const a = await pack(executionManifest()),
    e = expected(a.header);
  await expect(
    unpack(
      a.header,
      [{ index: 0, data: a.chunks[0].data.buffer as unknown as Uint8Array }],
      e,
    ),
  ).rejects.toThrow();
  for (const change of [
    { ownerId: '' },
    { id: '' },
    { manifestSha256: 'x' },
    { unexpected: true },
  ])
    await expect(
      unpack(a.header, a.chunks, { ...e, ...change }),
    ).rejects.toThrow();
});
it('retains 2400 linked pairs with escaped maximum-length action IDs without narrowing the model', async () => {
  const m = executionCapacityManifest('paired', 'escaped'),
    a = await pack(m);
  expect(
    m.actions.every(
      (action) =>
        action.id.length === 256 &&
        new TextEncoder().encode(JSON.stringify(action.id)).length === 1538,
    ),
  ).toBe(true);
  expect(m.ownerId.length).toBe(256);
  expect(a.header.bytes).toBeGreaterThan(12000000);
  expect(a.header.bytes).toBeLessThan(WARMUP_ARCHIVE_MAX_BYTES);
  expect(
    (await unpack(a.header, a.chunks, expected(a.header))).manifest,
  ).toEqual(m);
});
