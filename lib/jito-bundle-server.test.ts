import { afterEach, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import {
  registerJitoPacket,
  readJitoBundle,
  cancelJitoBundle,
} from './jito-bundle-server';
const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const f of databases.splice(0)) f.sqlite.close();
  vi.restoreAllMocks();
});
it('registers exact signed packets transactionally and rejects substitutions and cross-owner access', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.attach();
  await expect(readJitoBundle(d.db, 'other', f.manifest.id)).rejects.toThrow(
    'Owned',
  );
  await expect(
    registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      '00'.repeat(32),
      0,
      f.swap.signed.transaction,
    ),
  ).rejects.toThrow();
  await expect(
    registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      0,
      f.tip.signed.transaction,
    ),
  ).rejects.toThrow();
  let result = await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    0,
    f.swap.signed.transaction,
  );
  expect(result.signatures).toEqual([f.swap.signed.signature, null]);
  expect(
    (
      await registerJitoPacket(
        d.db,
        'owner',
        f.manifest.id,
        f.manifest.sha256,
        0,
        f.swap.signed.transaction,
      )
    ).signatures,
  ).toEqual(result.signatures);
  await expect(cancelJitoBundle(d.db, 'owner', f.manifest.id)).rejects.toThrow(
    'unsigned',
  );
  result = await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    1,
    f.tip.signed.transaction,
  );
  expect(result.signatures).toEqual([
    f.swap.signed.signature,
    f.tip.signed.signature,
  ]);
  expect(
    d.sqlite.prepare('SELECT state FROM solana_swap_reservations').get()?.state,
  ).toBe('signed');
});
it('blocks incomplete claims and individual submission, then atomically claims all members once', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.attach();
  const claim = () =>
    d.sqlite
      .prepare(
        "UPDATE jito_bundles SET state='submitting' WHERE owner_id='owner' AND id=? AND state='reviewed'",
      )
      .run(f.manifest.id);
  expect(claim).toThrow('incomplete');
  await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    0,
    f.swap.signed.transaction,
  );
  expect(() =>
    d.sqlite
      .prepare(
        "UPDATE imported_swap_signing_intents SET state='submitted' WHERE id=?",
      )
      .run(f.review.id),
  ).toThrow('complete bundle');
  await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    1,
    f.tip.signed.transaction,
  );
  d.sqlite
    .prepare("UPDATE imported_trade_session_controls SET state='paused'")
    .run();
  expect(claim).toThrow();
  d.sqlite
    .prepare("UPDATE imported_trade_session_controls SET state='ready'")
    .run();
  d.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect(claim).toThrow();
  d.sqlite.prepare('UPDATE workspace_wallets SET revision=1').run();
  expect(claim().changes).toBe(1);
  expect(claim().changes).toBe(0);
  expect(
    d.sqlite.prepare('SELECT state FROM imported_swap_signing_intents').get()
      ?.state,
  ).toBe('submitted');
  expect(
    d.sqlite.prepare('SELECT state FROM solana_swap_reservations').get()?.state,
  ).toBe('submitted');
  expect(() =>
    d.sqlite.prepare("UPDATE jito_bundles SET state='reviewed'").run(),
  ).toThrow();
});
it('cancels only entirely unsigned bundles and retains immutable history', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.attach();
  expect(() =>
    d.sqlite
      .prepare(
        "UPDATE imported_swap_signing_intents SET state='cancelled' WHERE id=?",
      )
      .run(f.review.id),
  ).toThrow();
  const result = await cancelJitoBundle(d.db, 'owner', f.manifest.id);
  expect(result.state).toBe('cancelled');
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM solana_swap_reservations').get()
      ?.n,
  ).toBe(0);
  expect(() =>
    d.sqlite.prepare("UPDATE jito_bundles SET document='{}'").run(),
  ).toThrow('immutable');
});
it('requires all four wallet signatures and the tip before claiming one five-packet bundle', async () => {
  const f = await jitoBundleFixture(4),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.attach();
  for (let i = 0; i < 4; i++)
    await registerJitoPacket(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      i,
      f.swaps[i].signed.transaction,
    );
  expect(() =>
    d.sqlite.prepare("UPDATE jito_bundles SET state='submitting'").run(),
  ).toThrow('incomplete');
  await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    4,
    f.tip.signed.transaction,
  );
  d.sqlite.prepare("UPDATE jito_bundles SET state='submitting'").run();
  expect(
    d.sqlite
      .prepare(
        "SELECT count(*) AS n FROM imported_swap_signing_intents WHERE state='submitted'",
      )
      .get()?.n,
  ).toBe(4);
  expect(
    d.sqlite
      .prepare(
        "SELECT count(*) AS n FROM solana_swap_reservations WHERE state='submitted'",
      )
      .get()?.n,
  ).toBe(4);
});
it('rolls back attachment when a wallet signs or project changes before the snapshot commits', async () => {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.sqlite.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect(d.attach).toThrow();
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM jito_bundles').get()?.n,
  ).toBe(0);
  d.sqlite.prepare('UPDATE imported_token_projects SET archived=0').run();
  d.sqlite
    .prepare(
      "UPDATE imported_swap_signing_intents SET state='signed',signature=?",
    )
    .run(f.swap.signed.signature);
  expect(d.attach).toThrow();
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM jito_bundles').get()?.n,
  ).toBe(0);
});
