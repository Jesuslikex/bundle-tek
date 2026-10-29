import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  inspectUpgrade,
  inspectHistoricalBuffer,
  compareBufferToDeployment,
} from './jito-jupiter-upgrade-history.mjs';
import { PROGRAM, PROGRAM_DATA } from './jito-jupiter-public-hash.mjs';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BUFFER = 'CbboLZHpRP8LTWmn3Wj2DGCya1rVvZX6ARMJs5k76n6n';
const AUTH = 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ';
const SIG =
  '3qcuiJd614zpxRq4935DZwdgcrpR32k8N7Xh5H32EB4w2QXonLQWc4XBrL6oMEfoegnCYKXGddQD95YC86rarEh8';
function upgrade() {
  return {
    slot: 459479624,
    meta: {
      err: null,
      innerInstructions: [
        {
          instructions: [
            {
              programId: LOADER,
              parsed: {
                type: 'upgrade',
                info: {
                  authority: AUTH,
                  bufferAccount: BUFFER,
                  programAccount: PROGRAM,
                  programDataAccount: PROGRAM_DATA,
                },
              },
            },
          ],
        },
      ],
    },
    transaction: { signatures: [SIG], message: { instructions: [] } },
  };
}
function buffer() {
  const data = Buffer.alloc(40);
  data.writeUInt32LE(1);
  data[4] = 1;
  Buffer.from(bs58.decode(AUTH)).copy(data, 5);
  data.set([1, 2, 3], 37);
  return {
    context: { slot: 459479623 },
    value: {
      owner: LOADER,
      executable: false,
      data: [data.toString('base64'), 'base64'],
    },
  };
}
function deployed(bytes = Buffer.from([1, 2, 3, 0, 0])) {
  return {
    codeBytes: bytes.length,
    codeSha256: createHash('sha256').update(bytes).digest('hex'),
    deploymentSlot: '459479624',
    authority: AUTH,
  };
}
test('checks public upgrade linkage and compares padded historical buffer bytes', () => {
  assert.equal(inspectUpgrade(upgrade()).buffer, BUFFER);
  const b = inspectHistoricalBuffer(buffer(), 459479623);
  assert.equal(compareBufferToDeployment(b.code, deployed()).match, true);
  assert.equal(
    compareBufferToDeployment(b.code, deployed(Buffer.from([1, 2, 3, 0, 1])))
      .match,
    false,
  );
});
for (const [name, change] of [
  [
    'different slot',
    (v) => {
      v.slot--;
    },
  ],
  [
    'failed transaction',
    (v) => {
      v.meta.err = {};
    },
  ],
  [
    'wrong signature',
    (v) => {
      v.transaction.signatures[0] = 'other';
    },
  ],
  [
    'different authority',
    (v) => {
      v.meta.innerInstructions[0].instructions[0].parsed.info.authority =
        BUFFER;
    },
  ],
  [
    'different buffer',
    (v) => {
      v.meta.innerInstructions[0].instructions[0].parsed.info.bufferAccount =
        PROGRAM;
    },
  ],
  [
    'two upgrades',
    (v) => {
      v.meta.innerInstructions[0].instructions.push(
        v.meta.innerInstructions[0].instructions[0],
      );
    },
  ],
])
  test(`rejects upgrade ${String(name)}`, () => {
    const v = upgrade();
    change(v);
    assert.throws(() => inspectUpgrade(v));
  });
for (const [name, change] of [
  [
    'different slot',
    (v) => {
      v.context.slot--;
    },
  ],
  [
    'wrong owner',
    (v) => {
      v.value.owner = PROGRAM;
    },
  ],
  [
    'executable buffer',
    (v) => {
      v.value.executable = true;
    },
  ],
  [
    'bad base64',
    (v) => {
      v.value.data[0] = 'not base64';
    },
  ],
  [
    'bad authority',
    (v) => {
      const b = Buffer.from(v.value.data[0], 'base64');
      b[5] ^= 1;
      v.value.data[0] = b.toString('base64');
    },
  ],
])
  test(`rejects historical buffer ${String(name)}`, () => {
    const v = buffer();
    change(v);
    assert.throws(() => inspectHistoricalBuffer(v, 459479623));
  });
test('rejects a newer deployment slot even if bytes could match', () => {
  const d = deployed();
  d.deploymentSlot = '459479625';
  assert.throws(() =>
    compareBufferToDeployment(
      inspectHistoricalBuffer(buffer(), 459479623).code,
      d,
    ),
  );
});
