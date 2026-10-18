import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';

/** Deterministic synthetic packets only. No vault, real wallet or provider is accessed. */
export async function exchangePayoutFixture(
  kind: 'direct' | 'inner' | 'lookup' | 'seeded' | 'batch' = 'direct',
  amount = 1100000000n,
  editMessage?: (message: Uint8Array) => void,
) {
  const payer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  const recipient = bs58.encode(new Uint8Array(32).fill(7));
  const other = bs58.encode(new Uint8Array(32).fill(9));
  const system = '11111111111111111111111111111111';
  const carrier = bs58.encode(new Uint8Array(32).fill(12));
  const stamp = Date.parse('2026-10-18T12:00:00.000Z');
  const transfer = new Uint8Array(12),
    view = new DataView(transfer.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  let data = transfer,
    source = bs58.encode(payer.publicKey);
  if (kind === 'seeded') {
    const seed = new TextEncoder().encode('fixture'),
      owner = new Uint8Array(32).fill(14);
    source = bs58.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from([...payer.publicKey, ...seed, ...owner]),
        ),
      ),
    );
    data = new Uint8Array(52 + seed.length);
    const v = new DataView(data.buffer);
    v.setUint32(0, 11, true);
    v.setBigUint64(4, amount, true);
    v.setBigUint64(12, BigInt(seed.length), true);
    data.set(seed, 20);
    data.set(owner, 20 + seed.length);
  }
  const lookup = kind === 'lookup';
  const keys = lookup
    ? [bs58.encode(payer.publicKey), other, system]
    : [
        bs58.encode(payer.publicKey),
        recipient,
        kind === 'seeded' ? source : other,
        system,
        carrier,
      ];
  const targetIndex = lookup ? 3 : 1,
    systemIndex = lookup ? 2 : 3;
  const selected = kind === 'seeded' ? [2, 0, targetIndex] : [0, targetIndex];
  const instruction = (
    program: number,
    accounts: number[],
    bytes: Uint8Array,
  ) => [program, accounts.length, ...accounts, bytes.length, ...bytes];
  const half = transfer.slice(),
    remainder = transfer.slice();
  new DataView(half.buffer).setBigUint64(4, amount / 2n, true);
  new DataView(remainder.buffer).setBigUint64(4, amount - amount / 2n, true);
  // One-byte shortvec fields suffice for these bounded synthetic fixture packets.
  const instructions =
    kind === 'inner'
      ? instruction(4, [0, 1, 3], new Uint8Array([99]))
      : kind === 'batch'
        ? [
            ...instruction(systemIndex, [0, 1], half),
            ...instruction(systemIndex, [0, 1], remainder),
            ...instruction(
              systemIndex,
              [0, 2],
              Uint8Array.from([2, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]),
            ),
          ]
        : instruction(systemIndex, selected, data);
  const message = Uint8Array.from([
    ...(lookup ? [128] : []),
    1,
    0,
    lookup ? 1 : 2,
    keys.length,
    ...keys.flatMap((k) => Array.from(bs58.decode(k))),
    ...new Uint8Array(32).fill(3),
    kind === 'batch' ? 3 : 1,
    ...instructions,
    ...(lookup ? [1, ...new Uint8Array(32).fill(13), 1, 0, 0] : []),
  ]);
  editMessage?.(message);
  const signatureBytes = nacl.sign.detached(message, payer.secretKey);
  payer.secretKey.fill(0);
  const packet = Uint8Array.from([1, ...signatureBytes, ...message]);
  const before = keys.map(() => '1');
  if (lookup) before.push('1');
  before[0] = '10000000000';
  if (kind === 'seeded') before[2] = '5000000000';
  const after = [...before];
  after[0] = String(
    BigInt(before[0]) -
      5000n -
      (kind === 'seeded' ? 0n : amount) -
      (kind === 'batch' ? 10n : 0n),
  );
  if (kind === 'seeded') after[2] = String(BigInt(before[2]) - amount);
  if (kind === 'batch') after[2] = '11';
  after[targetIndex] = String(BigInt(before[targetIndex]) + amount);
  const signature = bs58.encode(signatureBytes);
  const expected = {
    reviewId: '00000000-0000-4000-8000-000000000002',
    orderSha256: 'a'.repeat(64),
    signature,
    recipient,
    amountRaw: String(amount),
    notBefore: new Date(stamp).toISOString(),
  };
  const transaction = {
    slot: 120,
    blockTime: stamp / 1000 + 1,
    version: lookup ? 0 : 'legacy',
    transaction: [Buffer.from(packet).toString('base64'), 'base64'],
    meta: {
      err: null,
      fee: '5000',
      preBalances: before,
      postBalances: after,
      loadedAddresses: { writable: lookup ? [recipient] : [], readonly: [] },
      innerInstructions:
        kind === 'inner'
          ? [
              {
                index: 0,
                instructions: [
                  {
                    programIdIndex: 3,
                    accounts: [0, 1],
                    data: bs58.encode(transfer),
                    stackHeight: 2,
                  },
                ],
              },
            ]
          : [],
    },
  };
  const evidence = {
    genesisBefore: SOLANA_MAINNET_GENESIS,
    genesisAfter: SOLANA_MAINNET_GENESIS,
    status: {
      context: { slot: 130 },
      value: [
        {
          slot: 120,
          err: null,
          confirmations: null,
          confirmationStatus: 'finalized',
        },
      ],
    },
    transaction,
    finalizedSlot: 125,
  };
  return {
    expected,
    evidence,
    now: stamp + 10000,
    packet,
    message,
    targetIndex,
  };
}
