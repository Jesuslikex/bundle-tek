import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  fundingSaveStopRequestHash,
  readFundingSaveStopReceipt,
  readFundingSaveStopRequest,
  type FundingSaveStopRequest,
} from './funding-save-stop';

const request = (): FundingSaveStopRequest => ({
  format: 'funding-save-stop-request-v1',
  stopId: 'original-stop',
  reminder: {
    format: 'funding-save-reminder-v1',
    ownerScope: 'a'.repeat(64),
    id: 'draft-one',
    action: 'save',
    expectedRevision: 1,
    documentHash: 'b'.repeat(64),
  },
  consent: 'stop-draft-save-v1',
});
async function receipt() {
  const r = request();
  return {
    format: 'funding-save-stop-receipt-v1',
    stopId: r.stopId,
    requestHash: await fundingSaveStopRequestHash(r),
    reminder: r.reminder,
    outcome: 'revision_advanced',
    beforeRevision: 1,
    afterRevision: 2,
    createdAt: '2026-10-25T12:00:00.000Z',
    transfersCancelled: false,
    signingAuthorized: false,
  };
}
it('detaches strict request metadata and hashes its canonical domain-bound representation', async () => {
  const input = request();
  const captured = readFundingSaveStopRequest(input);
  input.reminder.id = 'later-edit';
  expect(captured.reminder.id).toBe('draft-one');
  expect(await fundingSaveStopRequestHash(captured)).toBe(
    createHash('sha256')
      .update(JSON.stringify(['funding-save-stop-request-v1', captured]))
      .digest('hex'),
  );
});
it.each([
  (r: Record<string, unknown>) => {
    r.extra = false;
  },
  (r: Record<string, unknown>) => {
    r.consent = true;
  },
  (r: Record<string, unknown>) => {
    r.format = 'later';
  },
  (r: Record<string, unknown>) => {
    r.stopId = '../escape';
  },
  (r: Record<string, unknown>) => {
    r.stopId = 'a'.repeat(65);
  },
  (r: Record<string, unknown>) => {
    r.reminder = {
      ...request().reminder,
      action: 'archive',
      expectedRevision: 0,
    };
  },
  (r: Record<string, unknown>) => {
    r.reminder = { ...request().reminder, documentHash: 'A'.repeat(64) };
  },
  (r: Record<string, unknown>) => {
    r.reminder = { ...request().reminder, expectedRevision: -0 };
  },
])('refuses malformed or unapproved request case %#', (mutate) => {
  const r = request() as unknown as Record<string, unknown>;
  mutate(r);
  expect(() => readFundingSaveStopRequest(r)).toThrow();
});
it('rejects accessors without executing them', () => {
  let calls = 0;
  const r = request();
  Object.defineProperty(r, 'consent', {
    enumerable: true,
    get() {
      calls++;
      return 'stop-draft-save-v1';
    },
  });
  expect(() => readFundingSaveStopRequest(r)).toThrow();
  expect(calls).toBe(0);
});
it('rejects inherited, symbolic and nonenumerable request fields', () => {
  for (const r of [
    Object.assign(Object.create({ x: 1 }), request()),
    Object.assign(request(), { [Symbol('x')]: true }),
    Object.defineProperty(request(), 'hidden', { value: true }),
  ])
    expect(() => readFundingSaveStopRequest(r)).toThrow();
});
it('admits revision advance evidence without any source funding document', async () => {
  const r = await receipt();
  expect(await readFundingSaveStopReceipt(r, request())).toEqual(r);
});
it.each([
  {
    outcome: 'creation_fenced',
    expectedRevision: 0,
    beforeRevision: null,
    afterRevision: null,
  },
  {
    outcome: 'already_advanced',
    expectedRevision: 0,
    beforeRevision: 1,
    afterRevision: 1,
  },
  {
    outcome: 'already_advanced',
    expectedRevision: 1,
    beforeRevision: 3,
    afterRevision: 3,
  },
  {
    outcome: 'revision_advanced',
    expectedRevision: 1_000_000_000,
    beforeRevision: 1_000_000_000,
    afterRevision: 1_000_000_001,
  },
])(
  'admits exactly coherent terminal outcome $outcome/$expectedRevision',
  async (change) => {
    const q = request();
    q.reminder.expectedRevision = change.expectedRevision;
    const r = {
      ...(await receipt()),
      ...change,
      reminder: q.reminder,
      requestHash: await fundingSaveStopRequestHash(q),
    };
    const { expectedRevision: _ignored, ...publicReceipt } = r;
    expect(await readFundingSaveStopReceipt(publicReceipt, q)).toEqual(
      publicReceipt,
    );
  },
);
it.each([
  { afterRevision: null },
  { beforeRevision: null },
  { beforeRevision: 2 },
  { afterRevision: 3 },
  { afterRevision: 2.1 },
  { outcome: 'already_advanced' },
  { outcome: 'creation_fenced' },
  { outcome: 'cancelled' },
  { transfersCancelled: true },
  { signingAuthorized: true },
  { requestHash: 'c'.repeat(64) },
  { createdAt: '2026-10-25' },
  { extra: false },
])('refuses mismatched terminal evidence %#', async (change) => {
  await expect(
    readFundingSaveStopReceipt({ ...(await receipt()), ...change }, request()),
  ).rejects.toThrow();
});
it('refuses a valid receipt for a different request or owner namespace', async () => {
  const expected = request();
  expected.reminder.ownerScope = 'c'.repeat(64);
  await expect(
    readFundingSaveStopReceipt(await receipt(), expected),
  ).rejects.toThrow();
});
it('captures receipt strings and expected binding before asynchronous hashing', async () => {
  const input = await receipt();
  const expected = request();
  const original = structuredClone(input);
  const pending = readFundingSaveStopReceipt(input, expected);
  input.createdAt = 'invalid after validation';
  input.requestHash = 'not a hash';
  expected.reminder.id = 'changed during hashing';
  expect(await pending).toEqual(original);
});
