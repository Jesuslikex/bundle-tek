import { createHash } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import { validateFunding, type SavedFunding } from './funding-plan';
import type { FundingMutation } from './funding-plan-storage';
import {
  createFundingSaveReminder,
  readFundingSaveReminder,
  readFundingSaveMutation,
  fundingReminderOutcome,
  type FundingSaveReminder,
} from './funding-save-reminder';
const scope = 'a'.repeat(64);
const document = () =>
  validateFunding({
    name: 'Funding recovery',
    chain: 'Solana',
    currency: 'SOL',
    source: 'Manual',
    sourceLabel: 'Reviewed source',
    funderAddress: '',
    startAt: '2026-01-01T00:00:00.000Z',
    delaySeconds: 2,
    recipients: [
      {
        address: 'SysvarRent111111111111111111111111111111111',
        amount: '0.123456789',
      },
    ],
  });
const mutation = (
  action: FundingMutation['action'] = 'save',
  expectedRevision = 2,
): FundingMutation => ({
  action,
  id: 'funding-one',
  expectedRevision,
  document: document(),
});
const row = (
  value: FundingMutation,
  revision = value.expectedRevision + 1,
): SavedFunding => ({
  id: value.id,
  revision,
  archived: value.action === 'archive',
  updatedAt: '2026-10-25T00:00:00.000Z',
  document: value.document,
});
afterEach(() => vi.restoreAllMocks());
it('stores only a bounded ID/revision/action/hash namespace, never funding terms or authority', async () => {
  const value = mutation();
  const reminder = await createFundingSaveReminder(scope, value);
  expect(reminder).toEqual({
    format: 'funding-save-reminder-v1',
    ownerScope: scope,
    id: value.id,
    action: value.action,
    expectedRevision: 2,
    documentHash: createHash('sha256')
      .update(JSON.stringify(['funding-save-document-v1', value.document]))
      .digest('hex'),
  });
  expect(
    new TextEncoder().encode(JSON.stringify(reminder)).byteLength,
  ).toBeLessThanOrEqual(1024);
  expect(JSON.stringify(reminder)).not.toMatch(
    /Sysvar|Reviewed source|recipients|document"|packet|signing|execution|amount/,
  );
  expect(readFundingSaveReminder(reminder)).toEqual(reminder);
  expect(readFundingSaveReminder(reminder)).not.toBe(reminder);
});
it.each(['save', 'archive', 'restore'] as const)(
  'confirms only exact %s revision, archived bit and document hash',
  async (action) => {
    const value = mutation(action);
    const reminder = await createFundingSaveReminder(scope, value);
    const next = row(value);
    expect(await fundingReminderOutcome(reminder, next)).toBe('confirmed');
    expect(await fundingReminderOutcome(reminder, row(value, 2))).toBe(
      'unknown',
    );
    expect(await fundingReminderOutcome(reminder, row(value, 1))).toBe(
      'unknown',
    );
    expect(await fundingReminderOutcome(reminder, row(value, 4))).toBe(
      'conflict',
    );
    expect(
      await fundingReminderOutcome(reminder, {
        ...next,
        archived: !next.archived,
      }),
    ).toBe('conflict');
    expect(
      await fundingReminderOutcome(reminder, {
        ...next,
        document: { ...next.document, name: 'Different source' },
      }),
    ).toBe('conflict');
    await expect(
      fundingReminderOutcome(reminder, { ...next, id: 'another-plan' }),
    ).rejects.toThrow('invalid');
  },
);
it('supports create revision0 and the largest accepted revision without overflow', async () => {
  for (const revision of [0, 1_000_000_000]) {
    const value = mutation('save', revision);
    const reminder = await createFundingSaveReminder(scope, value);
    expect(await fundingReminderOutcome(reminder, row(value))).toBe(
      'confirmed',
    );
  }
  for (const action of ['archive', 'restore'] as const)
    await expect(
      createFundingSaveReminder(scope, mutation(action, 0)),
    ).rejects.toThrow('invalid');
});
it('uses a stable canonical projection rather than supplied key order', async () => {
  const value = mutation();
  const reversed = Object.fromEntries(Object.entries(value.document).reverse());
  expect(
    await createFundingSaveReminder(scope, {
      ...value,
      document: reversed as typeof value.document,
    }),
  ).toEqual(await createFundingSaveReminder(scope, value));
});
it.each([
  'name',
  'sourceLabel',
  'funderAddress',
  'amount',
  'total',
  'schedule',
  'items',
  'proxies',
  'extra',
])('refuses silently normalized or inconsistent funding %s', async (field) => {
  const value = mutation();
  const d = value.document;
  if (field === 'name') d.name = ' ' + d.name;
  if (field === 'sourceLabel') d.sourceLabel = ' ' + d.sourceLabel;
  if (field === 'funderAddress') d.funderAddress = ' ';
  if (field === 'amount') d.recipients[0].amount = '0.1234567890';
  if (field === 'total') d.total = '999';
  if (field === 'schedule') d.items[0].scheduledAt = '2026-01-02T00:00:00.000Z';
  if (field === 'items') d.items = [];
  if (field === 'proxies') d.recipients[0].proxies = [];
  if (field === 'extra') Object.assign(d, { signingAllowed: true });
  await expect(createFundingSaveReminder(scope, value)).rejects.toThrow(
    'invalid',
  );
});
it.each([null, [], {}, 'raw', new Date()])(
  'refuses a non-record reminder %j',
  (value) => expect(() => readFundingSaveReminder(value)).toThrow('invalid'),
);
it.each([
  ['format', 'funding-save-reminder-v2'],
  ['ownerScope', 'A'.repeat(64)],
  ['ownerScope', 'a'.repeat(63)],
  ['ownerScope', 'a'.repeat(64) + ' '],
  ['documentHash', 'g'.repeat(64)],
  ['id', ''],
  ['id', '../foreign'],
  ['id', 'a'.repeat(65)],
  ['action', 'send'],
  ['expectedRevision', -1],
  ['expectedRevision', -0],
  ['expectedRevision', 1.5],
  ['expectedRevision', 1_000_000_001],
  ['expectedRevision', Number.MAX_SAFE_INTEGER],
  ['expectedRevision', '2'],
  ['expectedRevision', NaN],
  ['expectedRevision', Infinity],
])('refuses malformed reminder %s=%s', async (key, bad) => {
  const good = await createFundingSaveReminder(scope, mutation());
  expect(() => readFundingSaveReminder({ ...good, [key]: bad })).toThrow(
    'invalid',
  );
});
it.each([
  'ownerScope',
  'documentHash',
  'id',
  'action',
  'expectedRevision',
  'format',
])('rejects absent or getter reminder %s without invoking it', async (key) => {
  const good = await createFundingSaveReminder(scope, mutation());
  const absent = { ...good };
  delete (absent as Record<string, unknown>)[key];
  expect(() => readFundingSaveReminder(absent)).toThrow();
  const getter = vi.fn(() => good[key as keyof FundingSaveReminder]);
  Object.defineProperty(good, key, { get: getter, enumerable: true });
  expect(() => readFundingSaveReminder(good)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it('rejects inherited, nonenumerable, symbolic and extra authority fields', async () => {
  const good = await createFundingSaveReminder(scope, mutation());
  for (const bad of [
    Object.assign(Object.create({ inherited: true }), good),
    { ...good, document: {} },
    { ...good, packet: 'bytes' },
    { ...good, signingAllowed: true },
    { ...good, [Symbol('hidden')]: true },
  ])
    expect(() => readFundingSaveReminder(bad)).toThrow();
  const bad = { ...good };
  Object.defineProperty(bad, 'id', { value: good.id, enumerable: false });
  expect(() => readFundingSaveReminder(bad)).toThrow();
  const nullPrototype = Object.assign(Object.create(null), good);
  expect(readFundingSaveReminder(nullPrototype)).toEqual(good);
});
it('rejects document accessors, sparse arrays, custom arrays and toJSON before execution', async () => {
  const getter = vi.fn(() => document().name);
  const d = document();
  Object.defineProperty(d, 'name', { get: getter, enumerable: true });
  await expect(
    createFundingSaveReminder(scope, { ...mutation(), document: d }),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const toJSON = vi.fn(() => document());
  await expect(
    createFundingSaveReminder(scope, {
      ...mutation(),
      document: Object.assign(document(), { toJSON }),
    }),
  ).rejects.toThrow();
  expect(toJSON).not.toHaveBeenCalled();
  for (const change of [
    (d: ReturnType<typeof document>) => {
      Reflect.deleteProperty(d.items, '0');
    },
    (d: ReturnType<typeof document>) => {
      Object.setPrototypeOf(d.recipients, {});
    },
    (d: ReturnType<typeof document>) => {
      Object.defineProperty(d.recipients, 'extra', { value: true });
    },
  ]) {
    const d = document();
    change(d);
    await expect(
      createFundingSaveReminder(scope, { ...mutation(), document: d }),
    ).rejects.toThrow();
  }
});
it.each(['name', 'sourceLabel'] as const)(
  'rejects lone high/low UTF16 surrogates in %s before UTF8 hashing',
  async (field) => {
    for (const bad of ['Ab\ud800', 'Ab\udfff']) {
      const d = document();
      d[field] = bad;
      await expect(
        createFundingSaveReminder(scope, { ...mutation(), document: d }),
      ).rejects.toThrow();
    }
    const d = document();
    d[field] = 'Valid 🚀';
    expect(
      (await createFundingSaveReminder(scope, { ...mutation(), document: d }))
        .documentHash,
    ).toMatch(/^[0-9a-f]{64}$/);
  },
);
it('detaches mutation and saved source before asynchronous hashing', async () => {
  const value = mutation();
  const original = structuredClone(value);
  const first = createFundingSaveReminder(scope, value);
  value.document.name = 'Mutated after call';
  value.document.items[0].amount = '100';
  value.expectedRevision = 99;
  const reminder = await first;
  expect(reminder).toEqual(await createFundingSaveReminder(scope, original));
  const next = row(original);
  const outcome = fundingReminderOutcome(reminder, next);
  next.document.name = 'Changed after call';
  next.revision = 999;
  expect(await outcome).toBe('confirmed');
});
it.each(['id', 'revision', 'archived', 'updatedAt', 'document'] as const)(
  'refuses malformed saved %s even before comparing revisions',
  async (field) => {
    const value = mutation();
    const reminder = await createFundingSaveReminder(scope, value);
    const saved = row(value);
    if (field === 'id') saved.id = '../bad';
    if (field === 'revision') saved.revision = 0;
    if (field === 'archived') Object.assign(saved, { archived: 'false' });
    if (field === 'updatedAt') saved.updatedAt = 'not-time';
    if (field === 'document') saved.document.total = '99';
    await expect(fundingReminderOutcome(reminder, saved)).rejects.toThrow();
  },
);
it('rejects oversized documents and cyclic or excessively deep injected data', async () => {
  const d = document();
  Object.assign(d, { padding: 'x'.repeat(30_001) });
  await expect(
    createFundingSaveReminder(scope, { ...mutation(), document: d }),
  ).rejects.toThrow();
  const cyclic = document();
  Object.assign(cyclic, { self: cyclic });
  await expect(
    createFundingSaveReminder(scope, { ...mutation(), document: cyclic }),
  ).rejects.toThrow();
});
it('rejects extra mutation fields rather than retaining an authority-bearing request', async () => {
  await expect(
    createFundingSaveReminder(
      scope,
      Object.assign(mutation(), { approved: true }),
    ),
  ).rejects.toThrow();
  await expect(
    createFundingSaveReminder('https://provider.example/private', mutation()),
  ).rejects.toThrow();
});
it('bounds valid large documents and the complete actual save envelope independently', async () => {
  const { default: bs58 } = await import('bs58');
  const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const documents = Array.from({ length: 101 }, (_, proxyCount) =>
    validateFunding({
      name: 'X',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Wallet',
      sourceLabel: '',
      funderAddress: address(4),
      startAt: '2026-01-01T00:00:00.000Z',
      delaySeconds: 0,
      recipients: Array.from({ length: 100 }, (_, i) => ({
        address: address(100 + i),
        amount: '0.01',
        ...(i < proxyCount ? { proxies: [address(1)] } : {}),
      })),
    }),
  );
  const huge = documents.find((d) => JSON.stringify(d).length > 30000)!;
  expect(huge).toBeDefined();
  await expect(
    createFundingSaveReminder(scope, { ...mutation(), document: huge }),
  ).rejects.toThrow('invalid');
  const near = documents
    .filter((d) => JSON.stringify(d).length <= 29990)
    .at(-1)!;
  let extra = 29990 - JSON.stringify(near).length;
  expect(extra).toBeLessThanOrEqual(159);
  near.name += 'x'.repeat(Math.min(79, extra));
  extra -= Math.min(79, extra);
  near.sourceLabel = 'y'.repeat(extra);
  expect(JSON.stringify(near).length).toBe(29990);
  expect(validateFunding(near)).toEqual(near);
  const save = { ...mutation(), document: near };
  expect(JSON.stringify(save).length).toBeGreaterThan(30000);
  await expect(createFundingSaveReminder(scope, save)).rejects.toThrow(
    'invalid',
  );
  const reminder = await createFundingSaveReminder(scope, {
    ...save,
    action: 'archive',
  });
  expect(reminder.action).toBe('archive');
});
it('detaches the admitted mutation before hashing and request serialization can yield', () => {
  const original = mutation();
  const captured = readFundingSaveMutation(original);
  original.document.name = 'Changed after admission';
  original.document.recipients[0].amount = '1';
  expect(captured.document.name).toBe('Funding recovery');
  expect(captured.document.recipients[0].amount).toBe('0.123456789');
});
it('refuses a descriptor-backed mutation before request serialization can execute its getter', () => {
  const original = mutation();
  const getter = vi.fn(() => original.document);
  const candidate = { ...original };
  Object.defineProperty(candidate, 'document', {
    get: getter,
    enumerable: true,
  });
  expect(() => readFundingSaveMutation(candidate)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
