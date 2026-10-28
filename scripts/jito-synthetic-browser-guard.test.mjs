import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  newSyntheticHost,
  acceptsSyntheticHost,
} from './jito-synthetic-browser-guard.mjs';
await test('unique cryptographic localhost origin only', () => {
  const first = newSyntheticHost(),
    second = newSyntheticHost();
  assert.notEqual(first, second);
  assert.match(first, /^jito-[a-f0-9]{32}\.localhost$/);
  assert.equal(
    acceptsSyntheticHost(`${first}:1234`, 1234, '127.0.0.1', first),
    true,
  );
  assert.equal(
    acceptsSyntheticHost(`127.0.0.1:1234`, 1234, '127.0.0.1', first),
    false,
  );
  assert.equal(
    acceptsSyntheticHost(`${second}:1234`, 1234, '127.0.0.1', first),
    false,
  );
  assert.equal(
    acceptsSyntheticHost(`${first}:1234`, 1234, '192.0.2.1', first),
    false,
  );
  assert.equal(
    acceptsSyntheticHost(`${first}:1235`, 1234, '127.0.0.1', first),
    false,
  );
});
