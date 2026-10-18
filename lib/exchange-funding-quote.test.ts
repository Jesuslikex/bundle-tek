import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createTursoDatabase } from '../db/turso';
import bs58 from 'bs58';
import { validateFunding, type FundingInput } from './funding-plan';
import {
  ExchangeFundingError,
  exchangeFundingSelection,
  previewOwnedExchangeFunding,
  readOwnedExchangeFundingQuote,
  readLatestOwnedExchangeFundingQuote,
} from './exchange-funding-quote';

const client = createClient({ url: ':memory:' });
const db = createTursoDatabase(client);
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const time = Date.parse('2026-10-18T12:00:00.000Z');
const input = {
  planId: 'draft',
  revision: 3,
  funderRevision: 2,
  minimumPayoutLamports: '1100000000',
};
let plan: FundingInput;
const fetcher = vi.fn<typeof fetch>();
const providerQuote = () => ({
  currency: 'sol',
  network: 'sol',
  fromAmount: '1.15',
  toAmount: '1.1',
  validUntil: new Date(time + 60000).toISOString(),
  rateId: 'server-private-provider-reference',
  warningMessage: 'Verification may be required.',
});
const run = (owner = 'alice', value: unknown = input) =>
  previewOwnedExchangeFunding(db, owner, value, new AbortController().signal, {
    key: 'synthetic-key',
    enabled: true,
    fetchImpl: fetcher,
    now: () => time,
  });
async function save() {
  await db
    .prepare('UPDATE funding_plans SET document=?')
    .bind(JSON.stringify(validateFunding(plan)))
    .run();
}
beforeEach(async () => {
  await client.executeMultiple(
    'DROP TABLE IF EXISTS exchange_funding_quotes; DROP TABLE IF EXISTS exchange_funding_quote_gates; DROP TABLE IF EXISTS funding_plans; DROP TABLE IF EXISTS workspace_wallets; CREATE TABLE funding_plans(owner_id TEXT,id TEXT,document TEXT,revision INTEGER,archived INTEGER,updated_at TEXT); CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER);',
  );
  await client.executeMultiple(
    await readFile('drizzle/0103_exchange_funding_quotes.sql', 'utf8'),
  );
  plan = {
    name: 'Launch funding',
    chain: 'Solana',
    currency: 'SOL',
    source: 'CEX',
    sourceLabel: 'Exchange',
    funderAddress: address(1),
    startAt: new Date(time).toISOString(),
    delaySeconds: 0,
    recipients: [{ address: address(2), amount: '1' }],
  };
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'alice',
      'draft',
      JSON.stringify(validateFunding(plan)),
      3,
      0,
      new Date(time).toISOString(),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('alice', 'Solana', address(1), 2, 0)
    .run();
  fetcher.mockReset().mockResolvedValue(Response.json(providerQuote()));
});
afterAll(() => client.close());
it('uses the real owner-scoped SQL and returns exact deposit, payout and cost without provider references or authority', async () => {
  const before = await client.execute('SELECT * FROM funding_plans');
  const quote = await run();
  expect(quote).toMatchObject({
    provider: 'ChangeNOW',
    funder: address(1),
    depositLamports: '1150000000',
    expectedPayoutLamports: '1100000000',
    providerCostLamports: '50000000',
    distributionTotalLamports: '1000000000',
    undistributedPayoutLamports: '100000000',
    durableReview: true,
    orderCreationAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(JSON.stringify(quote)).not.toContain(
    'server-private-provider-reference',
  );
  expect(JSON.stringify(quote)).not.toContain('synthetic-key');
  expect(quote).not.toHaveProperty('depositAddress');
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe(
    'https://api.changenow.io/v2/private-transfer/estimated-amount?currency=sol&network=sol&toAmount=1.100000000',
  );
  expect(options).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { 'x-changenow-api-key': 'synthetic-key' },
  });
  expect((await client.execute('SELECT * FROM funding_plans')).rows).toEqual(
    before.rows,
  );
});
it('does not use a different owner’s draft or wallet', async () => {
  await expect(run('bob')).rejects.toMatchObject({ status: 404 });
  await db.prepare("UPDATE workspace_wallets SET owner_id='bob'").run();
  await expect(run()).rejects.toMatchObject({ status: 404 });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  'UPDATE funding_plans SET archived=1',
  'UPDATE funding_plans SET revision=4',
  'UPDATE workspace_wallets SET archived=1',
  'UPDATE workspace_wallets SET revision=3',
])('refuses stale or archived context before quoting: %s', async (sql) => {
  await db.prepare(sql).run();
  await expect(run()).rejects.toMatchObject({ status: 409 });
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires an explicitly enabled and configured provider without reading storage', async () => {
  const prepare = vi.fn();
  const storage = { prepare } as unknown as D1Database;
  for (const options of [
    { enabled: false, key: 'synthetic' },
    { enabled: true },
  ])
    await expect(
      previewOwnedExchangeFunding(
        storage,
        'alice',
        input,
        new AbortController().signal,
        options,
      ),
    ).rejects.toMatchObject({ status: 503 });
  expect(prepare).not.toHaveBeenCalled();
});
it.each(['Wallet', 'Manual'] as const)('refuses %s drafts', async (source) => {
  plan.source = source;
  await save();
  await expect(run()).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses a payout below the distribution total', async () => {
  await expect(
    run('alice', { ...input, minimumPayoutLamports: '999999999' }),
  ).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['0', '-1', '01', '1.1', '18446744073709551616'])(
  'rejects malformed or overflowing raw amount %s',
  async (minimumPayoutLamports) => {
    expect(() =>
      exchangeFundingSelection({ ...input, minimumPayoutLamports }),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('rejects authority fields supplied by a caller', () => {
  expect(() =>
    exchangeFundingSelection({ ...input, signingAllowed: true }),
  ).toThrow();
});
it.each([
  { currency: 'eth' },
  { network: 'eth' },
  { fromAmount: '1.0' },
  { toAmount: '1.09' },
  { fromAmount: -1.15 },
  { toAmount: '1.1000000001' },
  { fromAmount: '1e3' },
  { rateId: '' },
  { validUntil: new Date(time + 15000).toISOString() },
  { validUntil: new Date(time + 3600001).toISOString() },
])('refuses inconsistent provider quote %j', async (change) => {
  fetcher.mockResolvedValue(Response.json({ ...providerQuote(), ...change }));
  await expect(run()).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([429, 401, 500, 302])(
  'does not retry HTTP %s or return raw upstream errors',
  async (status) => {
    fetcher.mockResolvedValue(
      new Response('private upstream data', { status }),
    );
    await expect(run()).rejects.toMatchObject({
      status: status === 429 ? 429 : 503,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('rejects unreadable responses and transport errors without retries', async () => {
  fetcher.mockResolvedValue(new Response('<html>error</html>'));
  await expect(run()).rejects.toMatchObject({ status: 502 });
  await db.prepare('DELETE FROM exchange_funding_quote_gates').run();
  fetcher.mockRejectedValue(new Error('secret endpoint'));
  await expect(run()).rejects.toMatchObject({
    status: 503,
    message: 'Exchange quote unavailable. No provider order was created.',
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  'UPDATE funding_plans SET revision=4',
  'UPDATE funding_plans SET archived=1',
  "UPDATE funding_plans SET document=json_set(document,'$.recipients[0].amount','2')",
  'UPDATE workspace_wallets SET revision=3',
  'DELETE FROM workspace_wallets',
])('rechecks owned storage after the quote: %s', async (sql) => {
  fetcher.mockImplementation(async () => {
    await db.prepare(sql).run();
    return Response.json(providerQuote());
  });
  await expect(run()).rejects.toMatchObject({ status: 409 });
});
it('checks expiry again after the storage recheck', async () => {
  const now = vi
    .fn()
    .mockReturnValueOnce(time)
    .mockReturnValueOnce(time)
    .mockReturnValue(time + 50000);
  await expect(
    previewOwnedExchangeFunding(
      db,
      'alice',
      input,
      new AbortController().signal,
      { key: 'synthetic', enabled: true, fetchImpl: fetcher, now },
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it('does not call the provider for an aborted request', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    previewOwnedExchangeFunding(db, 'alice', input, controller.signal, {
      key: 'synthetic',
      enabled: true,
      fetchImpl: fetcher,
      now: () => time,
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('returns a typed 400 for malformed decimal input without attempting BigInt conversion', () => {
  expect(() =>
    exchangeFundingSelection({ ...input, minimumPayoutLamports: '1.1' }),
  ).toThrow(ExchangeFundingError);
});
it('retains the opaque rate only in owned server storage and reloads without a provider request', async () => {
  const quote = await run();
  expect(await readOwnedExchangeFundingQuote(db, 'alice', quote.id)).toEqual(
    quote,
  );
  expect(
    await readLatestOwnedExchangeFundingQuote(db, 'alice', input.planId),
  ).toEqual(quote);
  expect(
    await readLatestOwnedExchangeFundingQuote(db, 'bob', input.planId),
  ).toBeNull();
  expect(
    await readLatestOwnedExchangeFundingQuote(db, 'alice', 'another-draft'),
  ).toBeNull();
  await expect(
    readOwnedExchangeFundingQuote(db, 'bob', quote.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readOwnedExchangeFundingQuote(db, 'alice', '../bad'),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (
      await db
        .prepare('SELECT provider_reference FROM exchange_funding_quotes')
        .first<{ provider_reference: string }>()
    )?.provider_reference,
  ).toBe('server-private-provider-reference');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shares owner pacing across independent calls without retrying the provider', async () => {
  await run();
  await expect(run()).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shares provider pacing across different owners', async () => {
  await db
    .prepare(
      "INSERT INTO funding_plans SELECT 'bob',id,document,revision,archived,updated_at FROM funding_plans WHERE owner_id='alice'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO workspace_wallets SELECT 'bob',chain,address,revision,archived FROM workspace_wallets WHERE owner_id='alice'",
    )
    .run();
  await run();
  await expect(run('bob')).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps precise provider amounts above Number.MAX_SAFE_INTEGER', async () => {
  fetcher.mockResolvedValue(
    Response.json({
      ...providerQuote(),
      fromAmount: '12345678.000000009',
      toAmount: '12345678.000000001',
    }),
  );
  expect(
    await run('alice', {
      ...input,
      minimumPayoutLamports: '12345678000000001',
    }),
  ).toMatchObject({
    depositLamports: '12345678000000009',
    expectedPayoutLamports: '12345678000000001',
    providerCostLamports: '8',
  });
});
it('retains exact lamports from numeric JSON amount tokens without binary rounding', async () => {
  const text = JSON.stringify(providerQuote())
    .replace('"fromAmount":"1.15"', '"fromAmount":12345678.000000009')
    .replace('"toAmount":"1.1"', '"toAmount":12345678.000000001');
  fetcher.mockResolvedValue(new Response(text));
  expect(
    await run('alice', {
      ...input,
      minimumPayoutLamports: '12345678000000001',
    }),
  ).toMatchObject({
    depositLamports: '12345678000000009',
    expectedPayoutLamports: '12345678000000001',
    providerCostLamports: '8',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('times out a stalled response body without retaining a quote or retrying', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    fetcher.mockResolvedValue(new Response(body));
    const result = run();
    const rejected = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(cancelled).toBe(true);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM exchange_funding_quotes')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('database guards refuse edits, forged authority and a foreign owner', async () => {
  await run();
  await expect(
    db
      .prepare(
        "UPDATE exchange_funding_quotes SET provider_reference='changed'",
      )
      .run(),
  ).rejects.toThrow('immutable');
  for (const flag of [
    'orderCreationAllowed',
    'fundingAllowed',
    'signingAllowed',
    'executionAllowed',
  ]) {
    await expect(
      db
        .prepare(
          `INSERT INTO exchange_funding_quotes SELECT 'forged',owner_id,plan_id,plan_revision,funder_revision,plan_document,json_set(review,'$.id','forged','$.${flag}',json('true')),provider_reference,created_at,expires_at FROM exchange_funding_quotes`,
        )
        .run(),
    ).rejects.toThrow('current owned');
  }
  await expect(
    db
      .prepare(
        "INSERT INTO exchange_funding_quotes SELECT 'foreign','bob',plan_id,plan_revision,funder_revision,plan_document,json_set(review,'$.id','foreign'),provider_reference,created_at,expires_at FROM exchange_funding_quotes",
      )
      .run(),
  ).rejects.toThrow('current owned');
});
