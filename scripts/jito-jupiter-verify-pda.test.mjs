import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { inspectPdas, TARGET } from './jito-jupiter-verify-pda.mjs';
const verify = 'verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC';
function fixture() {
  const bytes = Buffer.alloc(40);
  Buffer.from(bs58.decode(TARGET)).copy(bytes, 8);
  return {
    context: { slot: 100 },
    value: [
      {
        pubkey: bs58.encode(new Uint8Array(32).fill(2)),
        account: {
          owner: verify,
          executable: false,
          data: [bytes.toString('base64'), 'base64'],
        },
      },
    ],
  };
}
test('accepts a bounded matching metadata observation but does not assert verification', () => {
  assert.deepEqual(inspectPdas(fixture(), TARGET), {
    contextSlot: 100,
    count: 1,
  });
  const empty = fixture();
  empty.value = [];
  assert.deepEqual(inspectPdas(empty, TARGET), { contextSlot: 100, count: 0 });
});
for (const [name, change] of [
  [
    'missing context',
    (v) => {
      delete v.context;
    },
  ],
  [
    'negative slot',
    (v) => {
      v.context.slot = -1;
    },
  ],
  [
    'wrong owner',
    (v) => {
      v.value[0].account.owner = TARGET;
    },
  ],
  [
    'executable record',
    (v) => {
      v.value[0].account.executable = true;
    },
  ],
  [
    'bad encoding',
    (v) => {
      v.value[0].account.data[1] = 'jsonParsed';
    },
  ],
  [
    'bad bytes',
    (v) => {
      v.value[0].account.data[0] = 'invalid';
    },
  ],
  [
    'different program',
    (v) => {
      const b = Buffer.from(v.value[0].account.data[0], 'base64');
      b[8] ^= 1;
      v.value[0].account.data[0] = b.toString('base64');
    },
  ],
  [
    'duplicate record',
    (v) => {
      v.value.push(v.value[0]);
    },
  ],
])
  test(`rejects ${String(name)}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => inspectPdas(f, TARGET));
  });
