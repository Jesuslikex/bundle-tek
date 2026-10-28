import { afterEach, expect, it } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import {
  beginJitoSignAttempt,
  readJitoSignAttempt,
  registerJitoSignAttempt,
} from './jito-sign-attempt-server';
import { cancelJitoBundle, registerJitoPacket } from './jito-bundle-server';

const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
});

it('retains UNKNOWN until an exact signed packet is registered and supports the tip separately', async () => {
  const f = await jitoBundleFixture();
  const d = jitoDatabase(f.manifest, true, true);
  databases.push(d);
  d.attach();
  const id = f.manifest.id,
    hash = f.manifest.sha256,
    nonce = crypto.randomUUID();
  const begin = () => beginJitoSignAttempt(d.db, 'owner', id, hash, 0, nonce);
  const attempt = await begin();
  expect(attempt.attempt?.state).toBe('unknown');
  expect(attempt.mayInvokeSigner).toBe(true);
  expect(await begin()).toEqual({
    attempt: attempt.attempt,
    mayInvokeSigner: false,
  });
  expect(await readJitoSignAttempt(d.db, 'other', nonce)).toBeNull();
  await expect(
    beginJitoSignAttempt(d.db, 'owner', id, hash, 1, nonce),
  ).rejects.toThrow();
  await expect(
    beginJitoSignAttempt(d.db, 'owner', id, hash, 1, crypto.randomUUID()),
  ).rejects.toThrow();
  await expect(cancelJitoBundle(d.db, 'owner', id)).rejects.toThrow();
  expect(() =>
    d.sqlite
      .prepare(
        "UPDATE jito_bundles SET state='expired' WHERE owner_id=? AND id=?",
      )
      .run('owner', id),
  ).toThrow();
  // The pre-v2 writer is stopped by SQL, including its attempt to mutate the intent first.
  await expect(
    registerJitoPacket(d.db, 'owner', id, hash, 0, f.swap.signed.transaction),
  ).rejects.toThrow();
  await expect(
    registerJitoSignAttempt(
      d.db,
      'owner',
      id,
      hash,
      0,
      nonce,
      f.tip.signed.transaction,
    ),
  ).rejects.toThrow();
  expect((await readJitoSignAttempt(d.db, 'owner', nonce))?.state).toBe(
    'unknown',
  );
  const registered = await registerJitoSignAttempt(
    d.db,
    'owner',
    id,
    hash,
    0,
    nonce,
    f.swap.signed.transaction,
  );
  expect(registered.signatures[0]).toBe(f.swap.signed.signature);
  expect(
    await registerJitoSignAttempt(
      d.db,
      'owner',
      id,
      hash,
      0,
      nonce,
      f.swap.signed.transaction,
    ),
  ).toEqual(registered);
  const tipNonce = crypto.randomUUID();
  expect(
    (await beginJitoSignAttempt(d.db, 'owner', id, hash, 1, tipNonce)).attempt
      .intentId,
  ).toBeNull();
  const complete = await registerJitoSignAttempt(
    d.db,
    'owner',
    id,
    hash,
    1,
    tipNonce,
    f.tip.signed.transaction,
  );
  expect(complete.signatures).toEqual([
    f.swap.signed.signature,
    f.tip.signed.signature,
  ]);
  expect(
    (await readJitoSignAttempt(d.db, 'owner', tipNonce))?.transaction,
  ).toBe(f.tip.signed.transaction);
});

it('returns signer permission only to the successful insert, never to retries or concurrent requests', async () => {
  const f = await jitoBundleFixture();
  const d = jitoDatabase(f.manifest, true, true);
  databases.push(d);
  d.attach();
  const nonce = crypto.randomUUID();
  const begin = () =>
    beginJitoSignAttempt(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      0,
      nonce,
    );
  const results = await Promise.all([begin(), begin()]);
  expect(results.filter((r) => r.mayInvokeSigner)).toHaveLength(1);
  // Model a lost response: all later observations are recovery only.
  expect((await begin()).mayInvokeSigner).toBe(false);
  expect((await readJitoSignAttempt(d.db, 'owner', nonce))?.state).toBe(
    'unknown',
  );
});
