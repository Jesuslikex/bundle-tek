import test from 'node:test';
import assert from 'node:assert/strict';
import {
  referenceActivity,
  unchangedQuietReference,
} from './stock-reference-activity.mjs';
const signature = '1'.repeat(88);
test('requires a measured quiet interval and unchanged observed activity', () => {
  const before = referenceActivity([{ slot: '100', signature }], 356);
  const after = referenceActivity([{ slot: '100', signature }], 380);
  assert.equal(unchangedQuietReference(before, after), true);
  assert.equal(
    unchangedQuietReference(
      referenceActivity([{ slot: '100', signature }], 355),
      after,
    ),
    false,
  );
  assert.equal(
    unchangedQuietReference(
      before,
      referenceActivity([{ slot: '357', signature: '2'.repeat(88) }], 380),
    ),
    false,
  );
  assert.equal(
    unchangedQuietReference(
      before,
      referenceActivity([{ slot: '100', signature: '2'.repeat(88) }], 380),
    ),
    false,
  );
  assert.equal(
    unchangedQuietReference(
      before,
      referenceActivity([{ slot: '100', signature }], 355),
    ),
    false,
  );
});
test('does not call missing, future or malformed signature evidence quiet', () => {
  for (const rows of [
    [],
    [{ slot: '101', signature }],
    [{ slot: '99', signature: 'bad' }],
    [{ slot: '099', signature }],
  ])
    assert.throws(() => referenceActivity(rows, 100));
});
