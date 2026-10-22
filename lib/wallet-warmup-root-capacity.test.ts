import { beforeAll, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createTursoDatabase } from '../db/turso';
import {
  maximumPlanRootMeasurement,
  modelCeilingRootMeasurement,
} from '../test/warmup-root-capacity-measurement';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { readWarmupExecutionRootBinding } from './wallet-warmup-execution-terms';
import { WARMUP_MAX_PLAN_ACTIONS } from './warmup-history-capacity';
import { createHash } from 'node:crypto';
import { warmupPublicAssetReviewFixture } from '../test/warmup-public-asset-review-fixture';
import { readWarmupExecutionSource } from './wallet-warmup-execution-source';
import { WARMUP_SESSION_ROW_BYTES } from './wallet-warmup-session-digest';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function blobBytes(raw: unknown) {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return Uint8Array.from(raw);
  if (
    Array.isArray(raw) &&
    raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    return Uint8Array.from(raw);
  throw Error('Unsupported local BLOB transport');
}
// Measurement only: not a published codec or a production storage contract.
const chunkBytes = 192 * 1024;
const measurements: Record<string, unknown>[] = [];
let largest: Uint8Array;
let expected: {
  id: string;
  ownerId: string;
  consentId: string;
  reviewId: string;
  rootSha256: string;
};
beforeAll(async () => {
  const base = await maximumPlanRootMeasurement();
  expect(base.calls).toBe(4);
  expect(base.proposal.terms.intent.actions).toHaveLength(
    WARMUP_MAX_PLAN_ACTIONS,
  );
  expect(base.proposal.terms.intent.wallets).toHaveLength(20);
  expect(base.proposal.verifierEvidence.assets.after.accounts).toHaveLength(13);
  expect(base.proposal.verifierEvidence.assets.after.mints).toHaveLength(11);
  expect(base.proposal.executionAllowed).toBe(false);
  const sample = (
    kind: string,
    value: { envelope: unknown; bound: typeof base.bound; scope: string },
  ) => {
    const encoded = new TextEncoder().encode(canonical(value.envelope));
    const rootBytes = new TextEncoder().encode(
      canonical(value.bound.root),
    ).length;
    measurements.push({
      kind,
      scope: value.scope,
      actions: value.bound.manifest.actions.length,
      savedLots: value.bound.manifest.savedLots.length,
      bytes: encoded.length,
      rootBytes,
      chunks: Math.ceil(encoded.length / chunkBytes),
      sha256: sha(encoded),
    });
    if (!largest || encoded.length > largest.length) {
      largest = encoded;
      expected = {
        id: value.bound.manifest.id,
        ownerId: value.bound.manifest.ownerId,
        consentId: value.bound.manifest.consentId,
        reviewId: value.bound.root.terms.review.id,
        rootSha256: value.bound.rootSha256,
      };
    }
  };
  sample('source-derived-maximum-plan', base);
  for (const kind of ['saved', 'mixed', 'paired'] as const)
    for (const mode of [
      'source-like',
      'escaped',
      'unicode',
      'surrogate',
    ] as const)
      sample(
        'model-4800-' + kind + '-' + mode,
        await modelCeilingRootMeasurement(base, mode, kind),
      );
  mkdirSync('work/release-qa', { recursive: true });
  writeFileSync(
    'work/release-qa/warmup-complete-root-capacity-20261022.json',
    JSON.stringify(
      {
        scope:
          'Offline source/model payload and local primitive transport measurement only',
        chunkBytes,
        measurements,
        transportResults: [],
        hostedQualified: false,
        signingAllowed: false,
        executionAllowed: false,
      },
      null,
      2,
    ),
  );
});

it('measures the13 listed complete envelope cases instead of using the flat manifest as a proxy', () => {
  expect(measurements).toHaveLength(13);
  expect(measurements.filter((m) => m.actions === 4800)).toHaveLength(12);
  expect(largest.length).toBeGreaterThan(16 * 1024 * 1024);
  expect(largest.length).toBe(
    Math.max(...measurements.map((m) => Number(m.bytes))),
  );
});

it('preserves distinct lone surrogates through canonical JSON and UTF8 instead of substituting U+FFFD', () => {
  const a = canonical({ id: '\ud800' }),
    b = canonical({ id: '\ud801' });
  expect(a).toContain('\\ud800');
  expect(b).toContain('\\ud801');
  const bytes = new TextEncoder().encode(a);
  expect(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).id,
  ).toBe('\ud800');
  expect(sha(bytes)).not.toBe(sha(new TextEncoder().encode(b)));
});

it('uses the real combined1.5MiB parent limit rather than adding the two individual1MiB limits', async () => {
  const f = await warmupPublicAssetReviewFixture();
  try {
    const row = await f.db
      .prepare(
        'SELECT owner_id,id,plan_id,plan_revision,review_sha256,source_sha256,document,source,reviewed_at,review_expires_at,created_at FROM wallet_warmup_session_reviews',
      )
      .first<Record<string, unknown>>();
    const document = 'x'.repeat(900000),
      source = 'y'.repeat(900000);
    expect(document.length).toBeLessThan(1048576);
    expect(source.length).toBeLessThan(1048576);
    expect(document.length + source.length).toBeGreaterThan(
      WARMUP_SESSION_ROW_BYTES,
    );
    const prepare = vi.fn(() => ({
      bind: () => ({ first: async () => ({ ...row, document, source }) }),
    }));
    await expect(
      readWarmupExecutionSource(
        { prepare } as unknown as D1Database,
        f.owner,
        f.input,
        new AbortController().signal,
        f.clock,
      ),
    ).rejects.toThrow('Execution source');
    // Refused before any retained-document replay query can occur.
    expect(prepare).toHaveBeenCalledTimes(1);
    const underLimitPrepare = vi.fn(() => ({
      bind: () => ({
        first: async () => ({
          ...row,
          document: 'x'.repeat(700000),
          source: 'y'.repeat(700000),
        }),
      }),
    }));
    await expect(
      readWarmupExecutionSource(
        { prepare: underLimitPrepare } as unknown as D1Database,
        f.owner,
        f.input,
        new AbortController().signal,
        f.clock,
      ),
    ).rejects.toThrow('Execution source');
    // Same valid row identity/clock, but under the combined bound reaches the
    // second retained-record query before its deliberately invalid JSON fails.
    expect(underLimitPrepare.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    f.dispose();
  }
});

const transports: Record<string, unknown>[] = [];
it.each(['turso', 'd1'] as const)(
  'round trips the entire largest envelope through local %s with bounded single-chunk reads',
  async (platform) => {
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'warmup-root-capacity-only',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("fixture only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'warmup-root-capacity-only' } },
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
            'warmup-root-capacity-only',
          )) as unknown as D1Database);
      await db
        .prepare(
          "CREATE TABLE measured_chunks(idx INTEGER PRIMARY KEY,data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data)<=196608))",
        )
        .run();
      const chunks = Math.ceil(largest.length / chunkBytes);
      // Separate staging statements are deliberate. This is not atomic root
      // publication and does not claim one large remote batch is supported.
      for (let i = 0; i < chunks; i++)
        await db
          .prepare('INSERT INTO measured_chunks(idx,data) VALUES(?,?)')
          .bind(
            i,
            Uint8Array.from(largest.slice(i * chunkBytes, (i + 1) * chunkBytes))
              .buffer,
          )
          .run();
      const recovered = new Uint8Array(largest.length);
      let maximumArrayJsonRowBytes = 0;
      for (let i = 0; i < chunks; i++) {
        const row = await db
          .prepare('SELECT idx,data FROM measured_chunks WHERE idx=?')
          .bind(i)
          .first<{ idx: number; data: unknown }>();
        expect(row?.idx).toBe(i);
        const bytes = blobBytes(row!.data);
        expect(bytes.length).toBe(
          Math.min(chunkBytes, largest.length - i * chunkBytes),
        );
        const rowBytes = new TextEncoder().encode(
          JSON.stringify({ idx: row!.idx, data: Array.from(bytes) }),
        ).length;
        maximumArrayJsonRowBytes = Math.max(maximumArrayJsonRowBytes, rowBytes);
        expect(rowBytes).toBeLessThan(1024 * 1024);
        recovered.set(bytes, i * chunkBytes);
      }
      expect(sha(recovered)).toBe(sha(largest));
      const decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(recovered),
      );
      expect(
        (
          await readWarmupExecutionRootBinding(
            decoded.root,
            decoded.approval,
            expected,
          )
        ).rootSha256,
      ).toBe(expected.rootSha256);
      // Storage reports a missing piece; no production reassembly refusal is tested.
      await db
        .prepare('DELETE FROM measured_chunks WHERE idx=?')
        .bind(chunks - 1)
        .run();
      expect(
        await db
          .prepare('SELECT idx FROM measured_chunks WHERE idx=?')
          .bind(chunks - 1)
          .first(),
      ).toBeNull();
      const count = await db
        .prepare('SELECT count(*) AS n FROM measured_chunks')
        .first<{ n: number }>();
      expect(count!.n).toBe(chunks - 1);
      // A smaller second specimen forces a real three-byte UTF8 character
      // across a BLOB boundary, and preserves a JSON-escaped lone surrogate.
      const boundaryValue = {
        id: 'x'.repeat(chunkBytes - 8) + '\u0800',
        lone: '\ud800',
      };
      const boundary = new TextEncoder().encode(canonical(boundaryValue));
      expect(boundary[chunkBytes - 1]).toBe(0xe0);
      expect(() =>
        new TextDecoder('utf-8', { fatal: true }).decode(
          boundary.slice(0, chunkBytes),
        ),
      ).toThrow();
      const boundaryRead = new Uint8Array(boundary.length);
      for (let i = 0; i < 2; i++) {
        await db
          .prepare('INSERT INTO measured_chunks(idx,data) VALUES(?,?)')
          .bind(
            20000 + i,
            Uint8Array.from(
              boundary.slice(i * chunkBytes, (i + 1) * chunkBytes),
            ).buffer,
          )
          .run();
        const row = await db
          .prepare('SELECT data FROM measured_chunks WHERE idx=?')
          .bind(20000 + i)
          .first<{ data: unknown }>();
        const bytes = blobBytes(row!.data);
        boundaryRead.set(bytes, i * chunkBytes);
        const rowBytes = new TextEncoder().encode(
          JSON.stringify({ idx: 20000 + i, data: Array.from(bytes) }),
        ).length;
        expect(rowBytes).toBeLessThan(1024 * 1024);
        maximumArrayJsonRowBytes = Math.max(maximumArrayJsonRowBytes, rowBytes);
      }
      expect(sha(boundaryRead)).toBe(sha(boundary));
      expect(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(boundaryRead),
        ),
      ).toEqual(boundaryValue);
      transports.push({
        platform,
        chunks,
        bytes: largest.length,
        modeledMaximumArrayJsonRowBytes: maximumArrayJsonRowBytes,
        completeSha256: sha(recovered),
        modelRootReboundAgainst: 'in-memory-expected-selector',
        missingRowObserved: true,
        partialReaderRejectionTested: false,
        utf8BoundaryRoundTrip: true,
        jsonEscapedSurrogatePreserved: true,
      });
      writeFileSync(
        'work/release-qa/warmup-complete-root-capacity-20261022.json',
        JSON.stringify(
          {
            scope:
              'Offline source/model payload and local primitive transport measurement only',
            chunkBytes,
            measurements,
            transportResults: transports,
            hostedQualified: false,
            signingAllowed: false,
            executionAllowed: false,
          },
          null,
          2,
        ),
      );
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
