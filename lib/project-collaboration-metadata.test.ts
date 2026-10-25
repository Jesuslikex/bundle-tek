import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  metadataEditReviewHash,
  normalizeMetadataText,
  readMetadataEditReceipt,
  readMetadataEditRequest,
  readMetadataEditSource,
  readMetadataText,
  verifyMetadataEditReceipt,
  type MetadataEditReceipt,
  type MetadataEditSource,
  type MetadataText,
} from './project-collaboration-metadata';

const shareId = '11111111-1111-4111-8111-111111111111';
const mutationId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const source = (): MetadataEditSource => ({
  format: 'shared-project-metadata-source-v1',
  shareId,
  projectId: 'launch-draft',
  projectUpdatedAt: '2026-10-25T00:00:00.000Z',
  expiresAt: '2026-10-26T00:00:00.000Z',
  values: {
    tokenName: 'Original project',
    ticker: 'ORIG',
    description: 'Original saved description',
  },
  editingAllowed: true,
  walletActionsAllowed: false,
  signingAllowed: false,
  publishingAllowed: false,
});
const after = (): MetadataText => ({
  tokenName: 'RípéMon 🐒',
  ticker: 'RIPMON',
  description: 'Canonical UTF-8: café and 漢字',
});
async function request() {
  const current = source();
  return {
    mutationId,
    shareId,
    projectId: current.projectId,
    expectedUpdatedAt: current.projectUpdatedAt,
    values: after(),
    reviewHash: await metadataEditReviewHash(current, after()),
    approved: true as const,
  };
}
async function receipt(): Promise<MetadataEditReceipt> {
  const current = source();
  return {
    format: 'shared-project-metadata-edit-receipt-v1',
    mutationId,
    shareId,
    projectId: current.projectId,
    beforeUpdatedAt: current.projectUpdatedAt,
    updatedAt: '2026-10-25T00:00:00.001Z',
    createdAt: '2026-10-25T00:00:00.000Z',
    reviewHash: await metadataEditReviewHash(current, after()),
    before: current.values,
    after: after(),
    metadataSaved: true,
    walletActionsAllowed: false,
    signingAllowed: false,
    publishingAllowed: false,
  };
}

it('canonicalizes only the three draft text fields before review', () => {
  expect(
    normalizeMetadataText({
      tokenName: '  RípéMon 🐒  ',
      ticker: ' ripmon ',
      description: ' Canonical UTF-8: café and 漢字 \n',
    }),
  ).toEqual(after());
});

it.each(['tokenName', 'ticker', 'description'] as const)(
  'refuses lone high/low surrogates and NUL in %s before normalization',
  (field) => {
    for (const invalid of ['\ud800', '\udfff', '\0']) {
      const value = { ...after(), [field]: `A${invalid}B` };
      expect(() => normalizeMetadataText(value)).toThrow();
      expect(() => readMetadataText(value)).toThrow();
    }
  },
);

it('preserves valid emoji with the existing UTF-16 length limits', () => {
  const value = {
    tokenName: '🐒'.repeat(32),
    ticker: 'MONKEY',
    description: '🐒'.repeat(140),
  };
  expect(readMetadataText(value)).toEqual(value);
  expect(() =>
    readMetadataText({ ...value, tokenName: value.tokenName + 'a' }),
  ).toThrow();
  expect(() =>
    readMetadataText({ ...value, description: value.description + 'a' }),
  ).toThrow();
});

it('refuses malformed Unicode at the source, hash and receipt boundaries', async () => {
  const current = source();
  const saved = await receipt();
  for (const invalid of ['\ud800', '\udfff', '\0']) {
    const values = { ...after(), description: `Before${invalid}After` };
    expect(() => readMetadataEditSource({ ...current, values })).toThrow();
    await expect(metadataEditReviewHash(current, values)).rejects.toThrow();
    expect(() =>
      readMetadataEditReceipt({ ...saved, after: values }),
    ).toThrow();
    await expect(
      verifyMetadataEditReceipt({ ...saved, before: values }),
    ).rejects.toThrow();
  }
});

it('admits exactly the existing launch-plan text boundaries', () => {
  expect(
    readMetadataText({
      tokenName: 'n'.repeat(64),
      ticker: 'T'.repeat(16),
      description: 'd'.repeat(280),
    }),
  ).toEqual({
    tokenName: 'n'.repeat(64),
    ticker: 'T'.repeat(16),
    description: 'd'.repeat(280),
  });
  expect(
    readMetadataText({ tokenName: 'ab', ticker: '1', description: '' }),
  ).toEqual({ tokenName: 'ab', ticker: '1', description: '' });
});

it.each([
  { tokenName: 'a', ticker: 'OK', description: '' },
  { tokenName: 'n'.repeat(65), ticker: 'OK', description: '' },
  { tokenName: 'Name', ticker: '', description: '' },
  { tokenName: 'Name', ticker: 'T'.repeat(17), description: '' },
  { tokenName: 'Name', ticker: 'NOT_OK', description: '' },
  { tokenName: 'Name', ticker: '💰', description: '' },
  { tokenName: 'Name', ticker: 'OK', description: 'd'.repeat(281) },
])('rejects invalid text lengths or symbol %j', (value) => {
  expect(() => normalizeMetadataText(value)).toThrow();
});

it.each([
  { ...after(), tokenName: '  Name  ' },
  { ...after(), ticker: 'lower' },
  { ...after(), ticker: ' RIPMON' },
  { ...after(), description: ' description ' },
])('does not silently canonicalize saved or approved values %j', (value) => {
  expect(() => readMetadataText(value)).toThrow('canonical');
});

it.each([
  null,
  [],
  1,
  'text',
  { tokenName: 4, ticker: 'OK', description: '' },
  { tokenName: 'Name', ticker: false, description: '' },
  { tokenName: 'Name', ticker: 'OK', description: null },
  { tokenName: 'Name', ticker: 'OK' },
  { ...after(), wallet: shareId },
])('refuses non-text, missing and extra text fields %j', (value) => {
  expect(() => normalizeMetadataText(value)).toThrow();
});

it('rejects getters before invoking them and rejects prototype, hidden and symbol fields', () => {
  const getter = vi.fn(() => 'Name');
  const accessor = { ...after() };
  Object.defineProperty(accessor, 'tokenName', {
    get: getter,
    enumerable: true,
  });
  expect(() => readMetadataText(accessor)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    readMetadataText(
      Object.assign(Object.create({ inherited: true }), after()),
    ),
  ).toThrow();
  const hidden = { ...after() };
  Object.defineProperty(hidden, 'description', {
    value: 'hidden',
    enumerable: false,
  });
  expect(() => readMetadataText(hidden)).toThrow();
  expect(() =>
    readMetadataText({ ...after(), [Symbol('extra')]: true }),
  ).toThrow();
});

it('accepts null-prototype JSON data while returning detached ordinary records', () => {
  const input = Object.assign(Object.create(null), after());
  const value = readMetadataText(input);
  expect(value).toEqual(after());
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  value.tokenName = 'Changed output';
  expect(input.tokenName).toBe(after().tokenName);
});

it('reads canonical source data without retaining references', () => {
  const input = source();
  const result = readMetadataEditSource(input);
  expect(result).toEqual(input);
  result.values.tokenName = 'Changed output';
  expect(input.values.tokenName).toBe('Original project');
});

it.each([
  ['format', 'other'],
  ['shareId', shareId.toUpperCase().replace('11111111', 'AAAAAAAA')],
  ['projectId', '../project'],
  ['projectId', 'x'.repeat(65)],
  ['projectUpdatedAt', '2026-10-25T00:00:00Z'],
  ['projectUpdatedAt', '2026-02-30T00:00:00.000Z'],
  ['expiresAt', undefined],
  ['expiresAt', 'bad'],
  ['editingAllowed', false],
  ['walletActionsAllowed', true],
  ['signingAllowed', true],
  ['publishingAllowed', true],
])('rejects malformed source field %s=%j', (field, value) => {
  expect(() =>
    readMetadataEditSource({ ...source(), [field]: value }),
  ).toThrow();
});

it('supports a null expiry but not an omitted source field or unknown permission', () => {
  expect(
    readMetadataEditSource({ ...source(), expiresAt: null }).expiresAt,
  ).toBeNull();
  const { expiresAt: _omitted, ...missing } = source();
  expect(() => readMetadataEditSource(missing)).toThrow();
  expect(() =>
    readMetadataEditSource({ ...source(), executionAllowed: true }),
  ).toThrow();
});

it('hashes the exact UTF-8 before and after review in a stable field order', async () => {
  const current = source();
  const values = after();
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        'project-metadata-edit-v1',
        current.shareId,
        current.projectId,
        current.projectUpdatedAt,
        current.values,
        values,
      ]),
    )
    .digest('hex');
  expect(await metadataEditReviewHash(current, values)).toBe(expected);
  expect(
    await metadataEditReviewHash(
      {
        ...current,
        values: {
          description: current.values.description,
          ticker: current.values.ticker,
          tokenName: current.values.tokenName,
        },
      },
      {
        description: values.description,
        ticker: values.ticker,
        tokenName: values.tokenName,
      },
    ),
  ).toBe(expected);
});

it('binds project, share, source revision, before and after text to the review hash', async () => {
  const current = source();
  const original = await metadataEditReviewHash(current, after());
  for (const changed of [
    { ...current, shareId: otherId },
    { ...current, projectId: 'other-project' },
    { ...current, projectUpdatedAt: '2026-10-25T00:00:00.001Z' },
    {
      ...current,
      values: { ...current.values, description: 'Changed before' },
    },
  ])
    expect(await metadataEditReviewHash(changed, after())).not.toBe(original);
  expect(
    await metadataEditReviewHash(current, {
      ...after(),
      description: 'Changed after',
    }),
  ).not.toBe(original);
});

it('does not treat expiry as part of the content hash or the digest as live permission', async () => {
  const current = source();
  expect(
    await metadataEditReviewHash({ ...current, expiresAt: null }, after()),
  ).toBe(await metadataEditReviewHash(current, after()));
  await expect(
    metadataEditReviewHash(
      { ...current, editingAllowed: false } as unknown as MetadataEditSource,
      after(),
    ),
  ).rejects.toThrow();
});

it('permits hashing a no-op review, leaving no-op refusal to guarded storage', async () => {
  const current = source();
  expect(await metadataEditReviewHash(current, current.values)).toMatch(
    /^[0-9a-f]{64}$/,
  );
});

it('reads only the exact explicitly approved mutation request', async () => {
  const value = await request();
  const result = readMetadataEditRequest(value);
  expect(result).toEqual(value);
  result.values.tokenName = 'Detached';
  expect(value.values.tokenName).toBe(after().tokenName);
});

it.each([
  ['approved', false],
  ['approved', 1],
  ['mutationId', 'not-a-uuid'],
  ['mutationId', mutationId.toUpperCase().replace('22222222', 'AAAAAAAA')],
  ['shareId', 'bad'],
  ['projectId', '/private'],
  ['expectedUpdatedAt', 'bad'],
  ['reviewHash', 'A'.repeat(64)],
  ['reviewHash', 'a'.repeat(63)],
])('rejects request field %s=%j', async (field, value) => {
  const current = await request();
  expect(() =>
    readMetadataEditRequest({ ...current, [field]: value }),
  ).toThrow();
});

it('rejects noncanonical request text and unapproved extra fields', async () => {
  const current = await request();
  expect(() =>
    readMetadataEditRequest({
      ...current,
      values: { ...current.values, ticker: 'lower' },
    }),
  ).toThrow();
  expect(() =>
    readMetadataEditRequest({ ...current, signingAllowed: true }),
  ).toThrow();
});

it('reads and hash-verifies an exact immutable edit receipt', async () => {
  const value = await receipt();
  expect(readMetadataEditReceipt(value)).toEqual(value);
  const result = await verifyMetadataEditReceipt(value);
  expect(result).toEqual(value);
  result.before.description = 'Detached';
  result.after.tokenName = 'Detached';
  expect(value.before.description).toBe(source().values.description);
  expect(value.after.tokenName).toBe(after().tokenName);
});

it.each([
  ['format', 'other'],
  ['metadataSaved', false],
  ['walletActionsAllowed', true],
  ['signingAllowed', true],
  ['publishingAllowed', true],
  ['mutationId', 'missing'],
  ['shareId', 'missing'],
  ['projectId', 'a/b'],
  ['beforeUpdatedAt', 'invalid'],
  ['updatedAt', '2026-10-25T00:00:00.000Z'],
  ['updatedAt', '2026-10-24T23:59:59.999Z'],
  ['createdAt', '2026-10-25T00:00:00Z'],
  ['reviewHash', 'not-a-hash'],
])('rejects receipt field %s=%j', async (field, value) => {
  const current = await receipt();
  expect(() =>
    readMetadataEditReceipt({ ...current, [field]: value }),
  ).toThrow();
});

it('distinguishes shape admission from digest verification for changed receipt content', async () => {
  const original = await receipt();
  for (const changed of [
    { ...original, shareId: otherId },
    { ...original, projectId: 'other-project' },
    { ...original, beforeUpdatedAt: '2026-10-24T00:00:00.000Z' },
    {
      ...original,
      before: { ...original.before, tokenName: 'Changed source' },
    },
    { ...original, after: { ...original.after, tokenName: 'Changed result' } },
    { ...original, reviewHash: '0'.repeat(64) },
  ]) {
    expect(() => readMetadataEditReceipt(changed)).not.toThrow();
    await expect(verifyMetadataEditReceipt(changed)).rejects.toThrow(
      'differs from its review',
    );
  }
});

it('does not infer actor ownership or the caller mutation binding from content digest', async () => {
  const value = { ...(await receipt()), mutationId: otherId };
  expect((await verifyMetadataEditReceipt(value)).mutationId).toBe(otherId);
  // Exact requested mutation/owner binding is intentionally a caller/server check.
  expect(value.mutationId).not.toBe(mutationId);
});

it('rejects accessor-bearing envelopes without invoking their getters', async () => {
  const value = await receipt();
  const getter = vi.fn(() => after());
  Object.defineProperty(value, 'after', { get: getter, enumerable: true });
  expect(() => readMetadataEditReceipt(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it.each([
  { value: [] },
  { value: Object.assign([], { length: 3 }) },
  { value: Object.assign([], { ...after() }) },
])('rejects arrays and sparse arrays as text records', ({ value }) => {
  expect(() => readMetadataText(value)).toThrow();
});
