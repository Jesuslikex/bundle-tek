import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { exchangePayoutFixture } from '../test/exchange-payout-fixture';
import {
  collectExchangePayoutReceipt,
  decodeExchangePayoutReceipt,
} from './exchange-payout-receipt';
import { exchangePayoutSignature } from './exchange-payout-signature';
import { exchangeOrderAuthority } from './exchange-order-review';

it.each(['direct', 'inner', 'lookup', 'seeded', 'batch'] as const)(
  'verifies exact signed %s native credit without granting authority',
  async (kind) => {
    const f = await exchangePayoutFixture(kind);
    const receipt = await decodeExchangePayoutReceipt(
      f.expected,
      f.evidence,
      f.now,
    );
    expect(receipt).toMatchObject({
      amountRaw: '1100000000',
      payoutVerified: true,
      signatureVerified: true,
      currentSpendabilityVerified: false,
      finalityEvidence: 'rpc-attestation',
      ...exchangeOrderAuthority,
    });
    expect(receipt.innerTransferCount).toBe(kind === 'inner' ? 1 : 0);
    expect(receipt.lookupResolution).toBe(
      kind === 'lookup' ? 'finalized-rpc-metadata' : 'not-used',
    );
    expect(receipt.packetSha256).toMatch(/^[a-f0-9]{64}$/);
  },
);
it('preserves integer balances above JavaScript safe precision', async () => {
  const f = await exchangePayoutFixture('direct');
  f.evidence.transaction.meta.preBalances[1] = '9007199254740993';
  f.evidence.transaction.meta.postBalances[1] = '9007200354740993';
  expect(
    (await decodeExchangePayoutReceipt(f.expected, f.evidence, f.now))
      .recipientBeforeLamports,
  ).toBe('9007199254740993');
});
const mutations: [
  string,
  (f: Awaited<ReturnType<typeof exchangePayoutFixture>>) => void,
][] = [
  [
    'wrong genesis',
    (f) => {
      f.evidence.genesisAfter = 'wrong';
    },
  ],
  [
    'unrooted',
    (f) => {
      f.evidence.status.value[0].confirmationStatus = 'confirmed';
    },
  ],
  [
    'failed status',
    (f) => {
      Object.assign(f.evidence.status.value[0], { err: {} });
    },
  ],
  [
    'failed transaction',
    (f) => {
      Object.assign(f.evidence.transaction.meta, { err: {} });
    },
  ],
  [
    'status slot mismatch',
    (f) => {
      f.evidence.status.value[0].slot++;
    },
  ],
  [
    'lagging status node',
    (f) => {
      f.evidence.status.context.slot = 119;
    },
  ],
  [
    'unrooted transaction slot',
    (f) => {
      f.evidence.finalizedSlot = 119;
    },
  ],
  [
    'old transaction',
    (f) => {
      f.evidence.transaction.blockTime -= 2;
    },
  ],
  [
    'future transaction',
    (f) => {
      f.evidence.transaction.blockTime += 20;
    },
  ],
  [
    'null timestamp',
    (f) => {
      Object.assign(f.evidence.transaction, { blockTime: null });
    },
  ],
  [
    'wrong expected amount',
    (f) => {
      f.expected.amountRaw = '1100000001';
    },
  ],
  [
    'wrong recipient',
    (f) => {
      f.expected.recipient = bs58.encode(new Uint8Array(32).fill(8));
    },
  ],
  [
    'fee payer recipient',
    (f) => {
      f.expected.recipient = bs58.encode(f.packet.subarray(69, 101));
    },
  ],
  [
    'wrong reference signature',
    (f) => {
      f.expected.signature = bs58.encode(new Uint8Array(64).fill(5));
    },
  ],
  [
    'invalid packet signature',
    (f) => {
      const b = Buffer.from(f.evidence.transaction.transaction[0], 'base64');
      b[5] ^= 1;
      f.evidence.transaction.transaction[0] = b.toString('base64');
    },
  ],
  [
    'trailing packet bytes',
    (f) => {
      f.evidence.transaction.transaction[0] = Buffer.concat([
        Buffer.from(f.packet),
        Buffer.from([0]),
      ]).toString('base64');
    },
  ],
  [
    'wrong version',
    (f) => {
      f.evidence.transaction.version = 0;
    },
  ],
  [
    'missing balances',
    (f) => {
      f.evidence.transaction.meta.preBalances.pop();
    },
  ],
  [
    'unsafe numeric balance',
    (f) => {
      Object.assign(f.evidence.transaction.meta.preBalances, {
        0: Number.MAX_SAFE_INTEGER + 1,
      });
    },
  ],
  [
    'inexact amount',
    (f) => {
      f.expected.amountRaw = '1.1';
    },
  ],
  [
    'fee conservation',
    (f) => {
      f.evidence.transaction.meta.fee = '5001';
    },
  ],
  [
    'target balance differs',
    (f) => {
      f.evidence.transaction.meta.postBalances[1] = '1100000002';
    },
  ],
  [
    'missing CPI evidence',
    (f) => {
      Object.assign(f.evidence.transaction.meta, { innerInstructions: null });
    },
  ],
  [
    'unexpected lookup',
    (f) => {
      f.evidence.transaction.meta.loadedAddresses.writable = [
        f.expected.recipient,
      ];
    },
  ],
];
it.each(mutations)('refuses %s', async (_name, change) => {
  const f = await exchangePayoutFixture();
  change(f);
  await expect(
    decodeExchangePayoutReceipt(f.expected, f.evidence, f.now),
  ).rejects.toThrow();
});
it.each([
  'missing transfer',
  'outgoing transfer',
  'unsupported instruction',
  'duplicate group',
  'bad account index',
  'invoked recipient',
])('refuses inner %s', async (kind) => {
  const f = await exchangePayoutFixture('inner'),
    group = f.evidence.transaction.meta.innerInstructions[0];
  if (kind === 'missing transfer') group.instructions = [];
  if (kind === 'outgoing transfer') group.instructions[0].accounts = [1, 0];
  if (kind === 'unsupported instruction')
    group.instructions[0].data = bs58.encode(new Uint8Array(12));
  if (kind === 'duplicate group')
    f.evidence.transaction.meta.innerInstructions.push(structuredClone(group));
  if (kind === 'bad account index') group.instructions[0].accounts = [0, 100];
  if (kind === 'invoked recipient') group.instructions[0].programIdIndex = 1;
  await expect(
    decodeExchangePayoutReceipt(f.expected, f.evidence, f.now),
  ).rejects.toThrow();
});
it('requires complete lookup resolution even with valid signed v0 bytes', async () => {
  const f = await exchangePayoutFixture('lookup');
  f.evidence.transaction.meta.loadedAddresses.writable = [];
  await expect(
    decodeExchangePayoutReceipt(f.expected, f.evidence, f.now),
  ).rejects.toThrow(/lookup/);
});
it.each([
  'System create',
  'nonsigner source',
  'recipient spending',
  'readonly recipient',
  'duplicate account',
])('refuses a correctly signed packet with %s', async (kind) => {
  const f = await exchangePayoutFixture('direct', 1100000000n, (bytes) => {
    if (kind === 'System create') bytes[bytes.length - 12] = 0;
    if (kind === 'nonsigner source') bytes[bytes.length - 15] = 2;
    if (kind === 'recipient spending') {
      bytes[bytes.length - 15] = 1;
      bytes[bytes.length - 14] = 0;
    }
    if (kind === 'readonly recipient') bytes[2] = 4;
    if (kind === 'duplicate account')
      bytes.set(bytes.subarray(4 + 32, 4 + 64), 4 + 64);
  });
  await expect(
    decodeExchangePayoutReceipt(f.expected, f.evidence, f.now),
  ).rejects.toThrow();
});
it('refuses a correctly signed seeded transfer whose derived source differs', async () => {
  const f = await exchangePayoutFixture('seeded', 1100000000n, (bytes) => {
    bytes[bytes.length - 1] ^= 1;
  });
  await expect(
    decodeExchangePayoutReceipt(f.expected, f.evidence, f.now),
  ).rejects.toThrow(/Seeded payout source/);
});
it('collects only finalized read methods and anchors the root at the transaction slot', async () => {
  const f = await exchangePayoutFixture();
  const rpc = vi.fn(
    async (method: string) =>
      ({
        getGenesisHash: f.evidence.genesisBefore,
        getSignatureStatuses: f.evidence.status,
        getTransaction: f.evidence.transaction,
        getSlot: f.evidence.finalizedSlot,
      })[method],
  );
  expect(
    (
      await collectExchangePayoutReceipt(
        f.expected,
        new AbortController().signal,
        rpc,
        () => f.now,
      )
    ).payoutVerified,
  ).toBe(true);
  expect(rpc.mock.calls.map((c) => c[0])).toEqual([
    'getGenesisHash',
    'getSignatureStatuses',
    'getTransaction',
    'getSlot',
    'getGenesisHash',
  ]);
  expect(rpc).toHaveBeenCalledWith(
    'getSlot',
    [{ commitment: 'finalized', minContextSlot: 120 }],
    expect.any(AbortSignal),
  );
});
it('stops at the first 429 and sanitizes provider errors', async () => {
  const f = await exchangePayoutFixture(),
    rpc = vi.fn(async () => {
      throw Object.assign(new Error('secret-url'), { status: 429 });
    });
  await expect(
    collectExchangePayoutReceipt(f.expected, new AbortController().signal, rpc),
  ).rejects.toMatchObject({
    status: 429,
    message:
      'Payout RPC rate limit reached. Wait before retrying verification.',
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('does not read when cancelled and refuses malformed signature references', async () => {
  const f = await exchangePayoutFixture(),
    c = new AbortController(),
    rpc = vi.fn();
  c.abort();
  await expect(
    collectExchangePayoutReceipt(f.expected, c.signal, rpc),
  ).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
  for (const invalid of [
    '',
    '0'.repeat(88),
    bs58.encode(new Uint8Array(64)),
    bs58.encode(new Uint8Array(63).fill(2)),
  ])
    expect(() => exchangePayoutSignature(invalid)).toThrow();
});
