import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  snapshotWarmupAssetProbe,
  verifyWarmupAssetProbeSnapshot,
} from './warmup-asset-probe-snapshot.mjs';

test('freezes exact compiler inputs and all original migrations, then loads the keyless local review offline', async () => {
  const root = resolve(process.cwd()),
    folder = join(
      root,
      'work',
      'warmup-probe-snapshot-offline-' + randomUUID(),
    );
  mkdirSync(folder, { recursive: true });
  const snapshot = await snapshotWarmupAssetProbe(root, folder);
  assert.deepEqual(verifyWarmupAssetProbeSnapshot(snapshot), {
    sourceUnchanged: true,
    snapshotUnchanged: true,
  });
  assert.ok(Object.keys(snapshot.sourceFiles).length > snapshot.migrations);
  assert.ok(
    Object.keys(snapshot.frozenFiles).length === snapshot.migrations + 3,
  );
  assert.ok(
    Object.values(snapshot.sourceFiles).every((hash) =>
      /^[a-f0-9]{64}$/.test(hash),
    ),
  );
  assert.ok(
    Object.keys(snapshot.sourceFiles).every((path) => !path.includes('.env')),
  );
  const original = globalThis.fetch;
  let fixture;
  globalThis.fetch = async () => {
    throw Error('No network allowed in snapshot test');
  };
  try {
    process.chdir(folder);
    const lib = await import(pathToFileURL(snapshot.bundle).href);
    fixture = await lib.warmupPublicAssetReviewFixture();
    const result = await fixture.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_reviews')
      .first();
    assert.equal(result.n, 1);
  } finally {
    fixture?.dispose();
    globalThis.fetch = original;
    process.chdir(root);
  }
  appendFileSync(join(folder, 'drizzle/meta/_journal.json'), '\n');
  assert.deepEqual(verifyWarmupAssetProbeSnapshot(snapshot), {
    sourceUnchanged: true,
    snapshotUnchanged: false,
  });
});
