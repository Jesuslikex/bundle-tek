import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { getCompiledTransactionMessageEncoder, address } from '@solana/kit';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
export function fundingOriginFixture(
  batch = false,
  twoSigners = false,
  compute = false,
  recipientSeed = 3,
) {
  const payer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
  const second = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
  const recipient = bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(recipientSeed))
      .publicKey,
  );
  const other = bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).publicKey,
  );
  const from = bs58.encode(payer.publicKey),
    from2 = bs58.encode(second.publicKey);
  const keys = [
    from,
    ...(twoSigners ? [from2] : []),
    recipient,
    ...(batch ? [other] : []),
    SYSTEM,
    ...(compute ? [COMPUTE] : []),
  ];
  const target = keys.indexOf(recipient),
    system = keys.indexOf(SYSTEM);
  const data = (amount: bigint) => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, amount, true);
    return bytes;
  };
  const instructions = [
    {
      programAddressIndex: system,
      accountIndices: [0, target],
      data: data(10000n),
    },
  ];
  if (twoSigners)
    instructions.push({
      programAddressIndex: system,
      accountIndices: [1, target],
      data: data(20000n),
    });
  if (batch)
    instructions.push({
      programAddressIndex: system,
      accountIndices: [0, keys.indexOf(other)],
      data: data(30000n),
    });
  if (compute)
    instructions.unshift({
      programAddressIndex: keys.indexOf(COMPUTE),
      accountIndices: [],
      data: new Uint8Array([2, 0, 53, 12, 0]),
    });
  const message = {
    version: 'legacy' as const,
    header: {
      numSignerAccounts: twoSigners ? 2 : 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: compute ? 2 : 1,
    },
    staticAccounts: keys.map(address),
    lifetimeToken: bs58.encode(new Uint8Array(32).fill(9)),
    instructions,
  };
  const sign = () => {
    const bytes = getCompiledTransactionMessageEncoder().encode(
      message as never,
    );
    const signatures = [
      nacl.sign.detached(Uint8Array.from(bytes), payer.secretKey),
      ...(twoSigners
        ? [nacl.sign.detached(Uint8Array.from(bytes), second.secretKey)]
        : []),
    ];
    const packet = Uint8Array.from([
      signatures.length,
      ...signatures.flatMap((sig) => [...sig]),
      ...bytes,
    ]);
    return {
      packet: btoa(String.fromCharCode(...packet)),
      signature: bs58.encode(signatures[0]),
    };
  };
  const signed = sign();
  const before: string[] = keys.map((_, i) =>
    i < (twoSigners ? 2 : 1) ? '1000000000' : i >= system ? '1' : '0',
  );
  const after = before.map(BigInt);
  const fee = twoSigners ? 10000n : 5000n;
  after[0] -= fee + 10000n + (batch ? 30000n : 0n);
  after[target] += 10000n;
  if (twoSigners) {
    after[1] -= 20000n;
    after[target] += 20000n;
  }
  if (batch) after[keys.indexOf(other)] += 30000n;
  const history = {
    data: [
      {
        signature: signed.signature,
        slot: '100',
        transactionIndex: '0',
        blockTime: '1700000000',
        confirmationStatus: 'finalized',
        err: null,
      },
    ],
    paginationToken: 'more-history',
  };
  const receipt = {
    slot: '100',
    blockTime: '1700000000',
    version: 'legacy',
    transaction: [signed.packet, 'base64'],
    meta: {
      err: null as unknown,
      fee: fee.toString(),
      preBalances: before,
      postBalances: after.map(String),
      innerInstructions: [] as unknown[],
      preTokenBalances: [],
      postTokenBalances: [],
      rewards: [],
    },
  };
  return {
    wallet: recipient,
    from,
    from2,
    message,
    history,
    receipt,
    resign() {
      const value = sign();
      history.data[0].signature = value.signature;
      receipt.transaction[0] = value.packet;
    },
  };
}
