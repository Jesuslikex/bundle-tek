import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { warmupReconstructionFixture } from '../test/warmup-reconstruction-fixture';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { reconstructWarmupExecutionRoot } from './wallet-warmup-execution-budget-review';
import { bindWarmupExecutionRoot } from './wallet-warmup-execution-terms';
import {
  packWarmupExecutionProposal as pack,
  unpackWarmupExecutionProposal as unpack,
  WARMUP_PROPOSAL_CHUNK_BYTES,
  WARMUP_PROPOSAL_MAX_BYTES,
} from './wallet-warmup-execution-proposal-codec';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
let f: Awaited<ReturnType<typeof warmupReconstructionFixture>>;
const signal = () => new AbortController().signal;
const input = () => ({
  format: 'wallet-warmup-execution-proposal-content-v1' as const,
  terms: structuredClone(f.proposed.terms),
  verifierEvidence: structuredClone(f.proposed.verifierEvidence),
});
const selector = (p: Awaited<ReturnType<typeof pack>>, original = f) => {
  expect(p.header).toMatchObject({
    id: original.expected.id,
    ownerId: original.owner,
    consentId: original.expected.consentId,
    reviewId: original.expected.reviewId,
  });
  // IDs come from the separately constructed owned fixture. The hash models a
  // separately retained publication selector; no such production table exists.
  return {
    id: original.expected.id,
    ownerId: original.owner,
    consentId: original.expected.consentId,
    reviewId: original.expected.reviewId,
    headerSha256: p.headerSha256,
  };
};
beforeAll(async () => {
  f = await warmupReconstructionFixture();
});
afterAll(() => f?.dispose());

it('round trips the complete pre-approval terms and verifier and can reconstruct the original owned root afterwards', async () => {
  const value = input(),
    packed = await pack(value, signal());
  const restored = await unpack(
    packed.header,
    packed.chunks,
    selector(packed),
    signal(),
  );
  expect(restored.terms).toEqual(value.terms);
  expect(restored.verifierEvidence).toEqual(value.verifierEvidence);
  expect(restored).toMatchObject({
    humanApprovalVerified: false,
    currentSourceVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(packed.header.proposalExpiresAt).toBe(
    f.proposed.verifierEvidence.assets.expiresAt,
  );
  expect(packed.headerSha256).not.toBe(packed.header.proposalSha256);
  expect(packed.header.proposalSha256).not.toBe(restored.termsSha256);
  expect(packed.chunks).toHaveLength(1);
  expect(packed.header.chunks[0].sha256).toBe(packed.header.proposalSha256);
  const replay = await reconstructWarmupExecutionRoot(
    f.db,
    f.owner,
    { ...f.record, verifierEvidence: restored.verifierEvidence },
    f.expected,
    signal(),
  );
  expect(replay.rootSha256).toBe(f.expected.rootSha256);
});

it('preserves the original deadline and content after time passes without provider access', async () => {
  const packed = await pack(input(), signal()),
    calls = f.providerCalls();
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(packed.header.proposalExpiresAt) + 60000);
  let restored;
  try {
    restored = await unpack(
      packed.header,
      packed.chunks,
      selector(packed),
      signal(),
    );
  } finally {
    clock.mockRestore();
  }
  expect(restored.verifierEvidence.assets.expiresAt).toBe(
    f.proposed.verifierEvidence.assets.expiresAt,
  );
  expect(f.providerCalls()).toBe(calls);
  // There is deliberately no clock argument and no publication/approval timestamp.
  expect(Object.keys(restored)).not.toContain('approvedAt');
  expect(Object.keys(packed.header)).not.toContain('publishedAt');
});

it('does not confuse transport integrity with source admission for self-consistent invented economics', async () => {
  const original = await pack(input(), signal());
  const control = await unpack(
    original.header,
    original.chunks,
    selector(original),
    signal(),
  );
  const controlRoot = await bindWarmupExecutionRoot(control.terms, {
    ...f.record.approval,
    termsSha256: control.termsSha256,
  });
  expect(
    (
      await reconstructWarmupExecutionRoot(
        f.db,
        f.owner,
        {
          root: controlRoot.root,
          approval: controlRoot.approval,
          verifierEvidence: control.verifierEvidence,
        },
        { ...f.expected, rootSha256: controlRoot.rootSha256 },
        signal(),
      )
    ).rootSha256,
  ).toBe(f.expected.rootSha256);
  const value = input();
  value.verifierEvidence.freshBudget.wallets[0].savedReviewMaximumNativeSpendLamports =
    '1';
  value.verifierEvidence.freshBudgetSha256 = await digest(
    canonical(value.verifierEvidence.freshBudget),
  );
  value.terms.verifierEvidenceSha256 = await digest(
    canonical(value.verifierEvidence),
  );
  const p = await pack(value, signal()),
    restored = await unpack(p.header, p.chunks, selector(p), signal());
  const rebound = await bindWarmupExecutionRoot(restored.terms, {
    ...f.record.approval,
    termsSha256: restored.termsSha256,
  });
  await expect(
    reconstructWarmupExecutionRoot(
      f.db,
      f.owner,
      {
        root: rebound.root,
        approval: rebound.approval,
        verifierEvidence: restored.verifierEvidence,
      },
      { ...f.expected, rootSha256: rebound.rootSha256 },
      signal(),
    ),
  ).rejects.toThrow();
  expect(restored.currentSourceVerified).toBe(false);
});

it.each([
  'termsSha256',
  'verifierEvidenceSha256',
  'proposalExpiresAt',
] as const)(
  'refuses an independently resealed header whose %s differs from complete content',
  async (field) => {
    const p = await pack(input(), signal()),
      h = structuredClone(p.header);
    h[field] =
      field === 'proposalExpiresAt'
        ? new Date(Date.parse(h[field]) + 1).toISOString()
        : '0'.repeat(64);
    await expect(
      unpack(
        h,
        p.chunks,
        { ...selector(p), headerSha256: await digest(canonical(h)) },
        signal(),
      ),
    ).rejects.toThrow('Warmup proposal is incomplete');
  },
);

it('copies actual typed array bytes without invoking a caller iterator or rereading a chunk getter', async () => {
  const p = await pack(input(), signal()),
    data = Uint8Array.from(p.chunks[0].data);
  const iterator = vi.fn(() => {
    throw Error('must not invoke iterator');
  });
  Object.defineProperty(data, Symbol.iterator, { value: iterator });
  Object.defineProperty(data, 'byteLength', { value: 0 });
  const getter = vi.fn(() => data),
    chunk = {
      index: 0,
      get data() {
        return getter();
      },
    };
  expect(
    (await unpack(p.header, [chunk], selector(p), signal())).terms,
  ).toEqual(f.proposed.terms);
  expect(getter).toHaveBeenCalledTimes(1);
  expect(iterator).not.toHaveBeenCalled();
});

it('refuses an oversized typed array concealed by an own byteLength before copying', async () => {
  const p = await pack(input(), signal()),
    data = new Uint8Array(WARMUP_PROPOSAL_CHUNK_BYTES + 1);
  Object.defineProperty(data, 'byteLength', {
    value: p.header.chunks[0].bytes,
  });
  await expect(
    unpack(p.header, [{ index: 0, data }], selector(p), signal()),
  ).rejects.toThrow('Warmup proposal is incomplete');
});

it('never invokes a caller array map or species during snapshot capture', async () => {
  const p = await pack(input(), signal()),
    map = vi.fn(() => {
      throw Error('must not invoke caller map');
    });
  Object.defineProperty(p.chunks, 'map', { value: map });
  Object.defineProperty(p.chunks, 'constructor', {
    get() {
      throw Error('must not inspect caller species');
    },
  });
  expect(
    (await unpack(p.header, p.chunks, selector(p), signal())).terms,
  ).toEqual(f.proposed.terms);
  expect(map).not.toHaveBeenCalled();
});

it('refuses other typed-array element types disguised with a Uint8Array prototype', async () => {
  const p = await pack(input(), signal()),
    data = new Uint16Array(Math.ceil(p.header.bytes / 2));
  Object.setPrototypeOf(data, Uint8Array.prototype);
  await expect(
    unpack(
      p.header,
      [{ index: 0, data: data as unknown as Uint8Array }],
      selector(p),
      signal(),
    ),
  ).rejects.toThrow('Warmup proposal is incomplete');
});

it.each(['id', 'ownerId', 'consentId', 'reviewId', 'headerSha256'] as const)(
  'refuses a different independently selected %s',
  async (key) => {
    const p = await pack(input(), signal()),
      e = selector(p);
    e[key] =
      key === 'ownerId'
        ? 'other_owner'
        : key === 'headerSha256'
          ? '0'.repeat(64)
          : crypto.randomUUID();
    await expect(unpack(p.header, p.chunks, e, signal())).rejects.toThrow(
      'Warmup proposal is incomplete',
    );
  },
);

it.each([
  'missing',
  'duplicate',
  'reordered',
  'changed',
  'extra',
  'bad-index',
  'short',
] as const)(
  'refuses %s chunk sets without returning partial content',
  async (kind) => {
    const p = await pack(input(), signal());
    let chunks = p.chunks.map((c) => ({
      index: c.index,
      data: Uint8Array.from(c.data),
    }));
    if (kind === 'missing') chunks = [];
    if (kind === 'duplicate' || kind === 'extra') chunks.push(chunks[0]);
    if (kind === 'reordered' || kind === 'bad-index') chunks[0].index = 1;
    if (kind === 'changed') chunks[0].data[10] ^= 1;
    if (kind === 'short') chunks[0].data = chunks[0].data.slice(1);
    await expect(
      unpack(p.header, chunks, selector(p), signal()),
    ).rejects.toThrow('Warmup proposal is incomplete');
  },
);

it.each(['bytes', 'sha', 'expiry', 'unknown', 'count', 'limit'] as const)(
  'refuses tampered %s header even with untouched proposal bytes',
  async (kind) => {
    const p = await pack(input(), signal()),
      h = structuredClone(p.header);
    if (kind === 'bytes') h.bytes++;
    if (kind === 'sha') h.proposalSha256 = '0'.repeat(64);
    if (kind === 'expiry')
      h.proposalExpiresAt = new Date(
        Date.parse(h.proposalExpiresAt) + 1,
      ).toISOString();
    if (kind === 'unknown') Object.assign(h, { signingAllowed: true });
    if (kind === 'count') h.chunks.push(structuredClone(h.chunks[0]));
    if (kind === 'limit') h.bytes = WARMUP_PROPOSAL_MAX_BYTES + 1;
    await expect(unpack(h, p.chunks, selector(p), signal())).rejects.toThrow(
      'Warmup proposal is incomplete',
    );
  },
);

it.each([
  'missing-evidence',
  'unknown',
  'approval',
  'budget-hash',
  'asset-hash',
  'terms-hash',
  'flags',
  'format',
] as const)(
  'refuses malformed or unlinked %s content at packing',
  async (kind) => {
    const value = input();
    if (kind === 'missing-evidence')
      Reflect.deleteProperty(value, 'verifierEvidence');
    if (kind === 'unknown') Object.assign(value, { verified: true });
    if (kind === 'approval')
      Object.assign(value, { approval: f.record.approval });
    if (kind === 'budget-hash')
      value.verifierEvidence.freshBudgetSha256 = '0'.repeat(64);
    if (kind === 'asset-hash')
      value.verifierEvidence.assetEvidenceSha256 = '0'.repeat(64);
    if (kind === 'terms-hash')
      value.terms.verifierEvidenceSha256 = '0'.repeat(64);
    if (kind === 'flags')
      Object.assign(value.verifierEvidence.freshBudget, {
        signingAllowed: true,
      });
    if (kind === 'format')
      Object.assign(value, { format: 'wallet-warmup-execution-archive-v1' });
    await expect(pack(value, signal())).rejects.toThrow(
      'Warmup proposal is incomplete',
    );
  },
);

it('takes detached snapshots before asynchronous hashing', async () => {
  const value = input(),
    original = structuredClone(value),
    pending = pack(value, signal());
  value.verifierEvidence.assets.provider = 'mutated.invalid';
  value.terms.intent.actions[0].id = 'mutated';
  const p = await pending,
    expected = selector(p),
    pendingRead = unpack(p.header, p.chunks, expected, signal());
  p.chunks[0].data.fill(0);
  p.header.chunks[0].sha256 = '0'.repeat(64);
  expected.ownerId = 'mutated';
  const restored = await pendingRead;
  expect(restored.terms).toEqual(original.terms);
  expect(restored.verifierEvidence).toEqual(original.verifierEvidence);
});

it('propagates cancellation with no partial result or replacement attempt', async () => {
  const c = new AbortController();
  c.abort(Error('explicit cancellation'));
  await expect(pack(input(), c.signal)).rejects.toThrow(
    'explicit cancellation',
  );
  const p = await pack(input(), signal());
  const c2 = new AbortController(),
    pending = unpack(p.header, p.chunks, selector(p), c2.signal);
  c2.abort(Error('cancel during hashing'));
  await expect(pending).rejects.toThrow('cancel during hashing');
});

it('refuses whitespace, duplicate keys and BOM even if all transport hashes are resealed', async () => {
  const p = await pack(input(), signal()),
    json = canonical(input());
  for (const bytes of [
    new TextEncoder().encode(' ' + json),
    new TextEncoder().encode('{"format":"ignored-duplicate",' + json.slice(1)),
    new TextEncoder().encode('\uFEFF' + json),
  ]) {
    const h = structuredClone(p.header);
    h.bytes = bytes.length;
    const rawSha = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    h.proposalSha256 = rawSha;
    h.chunks = [{ index: 0, bytes: bytes.length, sha256: rawSha }];
    await expect(
      unpack(
        h,
        [{ index: 0, data: bytes }],
        { ...selector(p), headerSha256: await digest(canonical(h)) },
        signal(),
      ),
    ).rejects.toThrow('Warmup proposal is incomplete');
  }
});

it('requires fatal UTF8 decoding for invalid bytes inside an otherwise valid canonical proposal string', async () => {
  const original = input(),
    id = original.terms.intent.actions[0].id;
  const value = JSON.parse(
    canonical(original).replaceAll(id, id + '\uFFFD'),
  ) as ReturnType<typeof input>;
  value.verifierEvidence.freshBudgetSha256 = await digest(
    canonical(value.verifierEvidence.freshBudget),
  );
  value.terms.verifierEvidenceSha256 = await digest(
    canonical(value.verifierEvidence),
  );
  const p = await pack(value, signal()),
    valid = new TextEncoder().encode(canonical(value));
  expect(
    (await unpack(p.header, p.chunks, selector(p), signal())).terms,
  ).toEqual(value.terms);
  const at = valid.indexOf(0xef);
  expect(at).toBeGreaterThan(0);
  const invalid = new Uint8Array(valid.length - 2);
  invalid.set(valid.slice(0, at));
  invalid[at] = 0xff;
  invalid.set(valid.slice(at + 3), at + 1);
  // Nonfatal decoding yields the exact valid canonical content and all its
  // valid terms/evidence digests. Only fatal decoding prevents admission here.
  expect(new TextDecoder().decode(invalid)).toBe(canonical(value));
  expect(() =>
    new TextDecoder('utf-8', { fatal: true }).decode(invalid),
  ).toThrow();
  const rawSha = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', invalid)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const h = {
    ...p.header,
    bytes: invalid.length,
    proposalSha256: rawSha,
    chunks: [{ index: 0, bytes: invalid.length, sha256: rawSha }],
  };
  await expect(
    unpack(
      h,
      [{ index: 0, data: invalid }],
      { ...selector(p), headerSha256: await digest(canonical(h)) },
      signal(),
    ),
  ).rejects.toThrow('Warmup proposal is incomplete');
});

it.each(['turso', 'd1'] as const)(
  'recovers a real maximum-plan proposal through disposable %s BLOB rows and refuses a missing row',
  async (platform) => {
    const maximum = await warmupReconstructionFixture('none', true);
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'proposal-codec-only',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("fixture")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'proposal-codec-only' } },
                },
              },
            ],
          })
        : null;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await mf!.getD1Database(
            'DB',
            'proposal-codec-only',
          )) as unknown as D1Database);
      await db
        .prepare(
          'CREATE TABLE pieces(idx INTEGER PRIMARY KEY, data BLOB NOT NULL)',
        )
        .run();
      const value = {
        format: 'wallet-warmup-execution-proposal-content-v1',
        terms: maximum.proposed.terms,
        verifierEvidence: maximum.proposed.verifierEvidence,
      };
      const p = await pack(value, signal());
      expect(p.chunks.length).toBeGreaterThan(1);
      expect(
        p.chunks.every((c) => c.data.length <= WARMUP_PROPOSAL_CHUNK_BYTES),
      ).toBe(true);
      for (const c of p.chunks)
        await db
          .prepare('INSERT INTO pieces VALUES(?,?)')
          .bind(c.index, c.data.buffer)
          .run();
      const rows = await db
        .prepare('SELECT idx,data FROM pieces ORDER BY idx')
        .all<{ idx: number; data: ArrayBuffer | number[] }>();
      const chunks = rows.results.map((r) => ({
        index: r.idx,
        data: Array.isArray(r.data)
          ? Uint8Array.from(r.data)
          : new Uint8Array(r.data),
      }));
      const expected = selector(p, maximum);
      expect(
        (await unpack(p.header, chunks, expected, signal())).terms,
      ).toEqual(maximum.proposed.terms);
      await expect(
        unpack(p.header, [...chunks].reverse(), expected, signal()),
      ).rejects.toThrow('Warmup proposal is incomplete');
      const duplicate = chunks.map((c, i) =>
        i === 1 ? { index: i, data: chunks[0].data } : c,
      );
      await expect(
        unpack(p.header, duplicate, expected, signal()),
      ).rejects.toThrow('Warmup proposal is incomplete');
      await expect(
        unpack(p.header, chunks.slice(0, -1), expected, signal()),
      ).rejects.toThrow('Warmup proposal is incomplete');
    } finally {
      maximum.dispose();
      client?.close();
      await mf?.dispose();
    }
  },
);
