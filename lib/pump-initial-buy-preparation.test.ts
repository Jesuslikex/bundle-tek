import { afterEach, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTursoDatabase } from '../db/turso';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import {
  buildSavedPumpInitialBuyComponent,
  pumpDeveloperBuyTarget,
} from './pump-initial-buy-preparation';
const clients: Client[] = [];
afterEach(() => {
  for (const db of clients.splice(0)) db.close();
});
async function fixture(stock = false) {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
  );
  for (const sql of readFileSync('drizzle/0078_lush_rictor.sql', 'utf8').split(
    '--> statement-breakpoint',
  ))
    if (sql.trim()) await client.execute(sql);
  const create = await pumpCreateFixture(stock);
  const image = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: create.name,
      ticker: create.symbol,
      ...(stock ? { currency: 'TSLAX', quoteAddress: create.quoteMint } : {}),
    },
    identity: {
      ...EMPTY_IDENTITY,
      artworkUrl:
        '/api/artwork/' + createHash('sha256').update(image).digest('hex'),
    },
    options: DEFAULT_VENUE_OPTIONS,
  });
  const {
    name: _name,
    symbol: _symbol,
    uri: _uri,
    quoteMint: _quote,
    ...context
  } = create;
  const terms = {
    projectId: 'project',
    updatedAt: '2026-10-14T01:00:00.000Z',
    releaseId: 'a'.repeat(64),
    origin: 'https://bundle.example',
    context,
    maximumQuoteCostRaw: '1000000000',
  };
  const metadata = {
    name: doc.plan.tokenName,
    symbol: doc.plan.ticker,
    description: doc.plan.description,
    image: terms.origin + '/api/launch/metadata/' + terms.releaseId + '/image',
  };
  await client.execute({
    sql: 'INSERT INTO workspace_projects VALUES (?,?,?,?,0)',
    args: ['alice', terms.projectId, JSON.stringify(doc), terms.updatedAt],
  });
  await client.execute({
    sql: 'INSERT INTO launch_metadata_releases VALUES (?,?,?,?,?,?,?,?)',
    args: [
      terms.releaseId,
      'alice',
      terms.projectId,
      JSON.stringify(doc),
      JSON.stringify(metadata),
      image,
      'image/png',
      terms.updatedAt,
    ],
  });
  return { client, db: createTursoDatabase(client), terms, doc };
}
it('converts saved supply percentages exactly without interpreting them as SOL', () => {
  expect(pumpDeveloperBuyTarget('1000000000000000', 5)).toBe('50000000000000');
  expect(pumpDeveloperBuyTarget('1000000000000000', 0.29)).toBe(
    '2900000000000',
  );
  expect(pumpDeveloperBuyTarget('1000000000000000', 1e-7)).toBe('1000000');
  for (const value of [0, -1, 101, Infinity, NaN])
    expect(() => pumpDeveloperBuyTarget('1000000000000000', value)).toThrow();
  expect(() => pumpDeveloperBuyTarget('1000', 0.01)).toThrow(
    'whole base-token units',
  );
  expect(() => pumpDeveloperBuyTarget('18446744073709551616', 1)).toThrow(
    'exact Pump token supply',
  );
});
for (const stock of [false, true])
  it(`binds developer target, quote cap, image and metadata to a saved project with real libSQL (${stock ? 'stock' : 'SOL'})`, async () => {
    const f = await fixture(stock),
      built = await buildSavedPumpInitialBuyComponent(f.db, 'alice', f.terms);
    expect(built.developerSupplyPercent).toBe(5);
    expect(built.tokenAmountRaw).toBe('50000000000000');
    expect(built.maximumQuoteCostRaw).toBe('1000000000');
    expect(built.transactionVersion).toBe(1);
    expect(built.containsInitialBuy).toBe(true);
    expect(built.containsHolderBuys).toBe(false);
    expect(built.requestedHoldersBuy).toBe(20);
    expect(built.completeLaunch).toBe(false);
    expect(built.signingAllowed).toBe(false);
    await expect(
      buildSavedPumpInitialBuyComponent(f.db, 'bob', f.terms),
    ).rejects.toThrow('owned active');
    await expect(
      buildSavedPumpInitialBuyComponent(f.db, 'alice', {
        ...f.terms,
        updatedAt: 'old',
      }),
    ).rejects.toThrow('owned active');
    await expect(
      buildSavedPumpInitialBuyComponent(f.db, 'alice', {
        ...f.terms,
        tokenAmountRaw: '1',
      } as typeof f.terms),
    ).rejects.toThrow('cannot override');
  });
it('rejects saved unsupported settings, changed identity and scheduled execution', async () => {
  const f = await fixture();
  f.doc.plan.scheduled = true;
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.doc)],
  });
  await expect(
    buildSavedPumpInitialBuyComponent(f.db, 'alice', f.terms),
  ).rejects.toThrow('Scheduled');
  f.doc.plan.scheduled = false;
  f.doc.plan.tokenName = 'Different';
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.doc)],
  });
  await expect(
    buildSavedPumpInitialBuyComponent(f.db, 'alice', f.terms),
  ).rejects.toThrow('exact saved identity');
});
