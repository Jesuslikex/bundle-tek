import { expect, it } from 'vitest';
import { exchangeFundingReviewFixture } from '../test/exchange-funding-review-fixture';
import {
  decodeSavedFunding,
  decodeFundingList,
  fundingMutationOutcome,
  fundingResponse,
  type FundingMutation,
} from './funding-plan-storage';

const fixture = () => exchangeFundingReviewFixture().plan;
it('retains exact amounts and rejects missing, duplicate or oversized saved lists', () => {
  const row = fixture();
  expect(decodeFundingList({ plans: [row] })).toEqual([row]);
  for (const body of [
    {},
    { plans: null },
    { plans: [row, row] },
    { plans: Array(101).fill(row) },
  ])
    expect(() => decodeFundingList(body)).toThrow('unavailable');
});
it.each([
  'id',
  'revision',
  'archived',
  'updatedAt',
  'total',
  'items',
  'amount',
  'schedule',
])('refuses malformed saved %s before it can enable review', (field) => {
  const row = fixture();
  if (field === 'id') row.id = '../other';
  if (field === 'revision') row.revision = 0;
  if (field === 'archived') Object.assign(row, { archived: 'false' });
  if (field === 'updatedAt') row.updatedAt = 'not a date';
  if (field === 'total') row.document.total = '999';
  if (field === 'items') row.document.items = [];
  if (field === 'amount') row.document.items[0].amount = '99';
  if (field === 'schedule')
    row.document.items[0].scheduledAt = '2020-01-01T00:00:00.000Z';
  expect(() => decodeSavedFunding(row)).toThrow('unavailable');
});
it.each(['save', 'archive', 'restore'] as const)(
  'confirms only the exact %s result and fences a competing revision',
  (action) => {
    const row = fixture();
    const attempt: FundingMutation = {
      id: row.id,
      expectedRevision: row.revision,
      document: row.document,
      action,
    };
    expect(fundingMutationOutcome(attempt, row)).toBe('unknown');
    const next = {
      ...row,
      revision: row.revision + 1,
      archived: action === 'archive',
    };
    expect(fundingMutationOutcome(attempt, next)).toBe('confirmed');
    expect(
      fundingMutationOutcome(attempt, { ...next, archived: !next.archived }),
    ).toBe('conflict');
    expect(
      fundingMutationOutcome(attempt, { ...next, revision: next.revision + 1 }),
    ).toBe('conflict');
    expect(
      fundingMutationOutcome(attempt, {
        ...next,
        document: { ...next.document, name: 'Other writer' },
      }),
    ).toBe('conflict');
    expect(() =>
      fundingMutationOutcome(attempt, { ...next, id: 'other-plan' }),
    ).toThrow();
  },
);
it.each([401, 409, 502])(
  'sanitizes HTTP %i HTML without consuming its parser text',
  async (status) => {
    await expect(
      fundingResponse(
        new Response('<html>private gateway diagnostic</html>', { status }),
      ),
    ).rejects.not.toThrow('private');
  },
);
it('refuses unreadable or non-object success envelopes', async () => {
  for (const body of ['<html>not json</html>', 'null', '[]'])
    await expect(fundingResponse(new Response(body))).rejects.toThrow(
      'unreadable response',
    );
});
