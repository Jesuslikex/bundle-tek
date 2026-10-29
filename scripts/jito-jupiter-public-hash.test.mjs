import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  inspectJupiterAccounts,
  PROGRAM_DATA,
} from './jito-jupiter-public-hash.mjs';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
function fixture() {
  const p = Buffer.alloc(36);
  p.writeUInt32LE(2);
  Buffer.from(bs58.decode(PROGRAM_DATA)).copy(p, 4);
  const d = Buffer.alloc(49);
  d.writeUInt32LE(3);
  d.writeBigUInt64LE(123n, 4);
  d[12] = 1;
  d.fill(7, 13, 45);
  d.set([1, 2, 3, 4], 45);
  return {
    context: { slot: 130 },
    value: [
      {
        owner: loader,
        executable: true,
        data: [p.toString('base64'), 'base64'],
      },
      {
        owner: loader,
        executable: false,
        data: [d.toString('base64'), 'base64'],
      },
    ],
  };
}
test('extracts only the validated code bytes after the upgradeable-loader header', () => {
  const result = inspectJupiterAccounts(fixture());
  assert.equal(result.contextSlot, 130);
  assert.equal(result.deploymentSlot, '123');
  assert.equal(result.codeBytes, 4);
  assert.equal(
    result.codeSha256,
    createHash('sha256')
      .update(Buffer.from([1, 2, 3, 4]))
      .digest('hex'),
  );
});
for (const [name, change] of [
  [
    'wrong program owner',
    (f) => {
      f.value[0].owner = 'incorrect';
    },
  ],
  [
    'wrong data owner',
    (f) => {
      f.value[1].owner = 'incorrect';
    },
  ],
  [
    'missing executable bit',
    (f) => {
      f.value[0].executable = false;
    },
  ],
  [
    'program-data executable',
    (f) => {
      f.value[1].executable = true;
    },
  ],
  [
    'malformed base64',
    (f) => {
      f.value[1].data[0] = '##';
    },
  ],
  [
    'missing account',
    (f) => {
      f.value.pop();
    },
  ],
  [
    'invalid context',
    (f) => {
      f.context.slot = -1;
    },
  ],
  [
    'wrong program-data pointer',
    (f) => {
      const p = Buffer.from(f.value[0].data[0], 'base64');
      p[4] ^= 1;
      f.value[0].data[0] = p.toString('base64');
    },
  ],
  [
    'invalid data variant',
    (f) => {
      const d = Buffer.from(f.value[1].data[0], 'base64');
      d.writeUInt32LE(2);
      f.value[1].data[0] = d.toString('base64');
    },
  ],
  [
    'invalid authority option',
    (f) => {
      const d = Buffer.from(f.value[1].data[0], 'base64');
      d[12] = 3;
      f.value[1].data[0] = d.toString('base64');
    },
  ],
])
  test(`refuses ${String(name)}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => inspectJupiterAccounts(f));
  });
