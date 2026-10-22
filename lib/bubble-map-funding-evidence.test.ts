import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { funderInTransaction } from './bubble-map';
import {
  findFirstFunder,
  findFunders,
  type BubbleRpc,
} from './bubble-map-funders';
const address = bs58.encode(new Uint8Array(32).fill(1));
const funder = bs58.encode(new Uint8Array(32).fill(2));
const other = bs58.encode(new Uint8Array(32).fill(3));
const signature = (n: number) => {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, n);
  return bs58.encode(bytes);
};
const transfer = (source = funder) => ({
  program: 'system',
  programId: '11111111111111111111111111111111',
  parsed: {
    type: 'transfer',
    info: { source, destination: address, lamports: 1000 },
  },
});
const tx = (n = 1) => ({
  slot: n,
  blockTime: 1700000000,
  transaction: {
    signatures: [signature(n)],
    message: { instructions: [transfer()] },
  },
  meta: {
    err: null,
    innerInstructions: [] as {
      index: number;
      instructions: ReturnType<typeof transfer>[];
    }[],
  },
});
const row = (n: number) => ({ signature: signature(n), slot: n, err: null });
it.each([null, undefined])(
  'does not infer successful funding when transaction metadata is %s',
  (meta) => {
    expect(funderInTransaction({ ...tx(), meta }, address)).toBeNull();
  },
);
it('requires the real System program identity and a positive exact transfer amount', () => {
  const forged = tx();
  forged.transaction.message.instructions[0].programId = other;
  expect(funderInTransaction(forged, address)).toBeNull();
  for (const lamports of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = tx();
    bad.transaction.message.instructions[0].parsed.info.lamports = lamports;
    expect(funderInTransaction(bad, address)).toBeNull();
  }
});
it('preserves actual outer/inner instruction order when choosing a reported funding source', () => {
  const value = tx();
  value.transaction.message.instructions = [
    { program: 'other', programId: other, parsed: { type: 'other', info: {} } },
    transfer(other),
  ] as typeof value.transaction.message.instructions;
  value.meta.innerInstructions = [
    { index: 0, instructions: [transfer(funder)] },
  ];
  expect(funderInTransaction(value, address)?.funder).toBe(funder);
});
it('does not guess a later funder when the oldest returned transaction is missing', async () => {
  const transactions: string[] = [];
  let page = 0;
  const rpc: BubbleRpc = async <T>(method: string, params: unknown[]) => {
    if (method === 'getSignaturesForAddress')
      return (page++ === 0 ? [row(2), row(1)] : []) as T;
    transactions.push(params[0] as string);
    return (params[0] === signature(1) ? null : tx(2)) as T;
  };
  expect((await findFirstFunder(address, rpc)).funder).toBeNull();
  expect(transactions).toEqual([signature(1)]);
});
it('refuses a transaction with a different signature or slot than the requested history record', async () => {
  let page = 0;
  const rpc: BubbleRpc = async <T>(method: string) =>
    (method === 'getSignaturesForAddress'
      ? page++ === 0
        ? [row(1)]
        : []
      : tx(2)) as T;
  expect((await findFirstFunder(address, rpc)).funder).toBeNull();
});
it('requires an empty terminal provider page rather than treating a short page as proof of exhaustion', async () => {
  let page = 0;
  const before: unknown[] = [];
  const rpc: BubbleRpc = async <T>(method: string, params: unknown[]) => {
    if (method === 'getSignaturesForAddress') {
      before.push(params[1]);
      return [[row(2)], [row(1)], []][page++] as T;
    }
    return tx(1) as T;
  };
  expect((await findFirstFunder(address, rpc)).funder?.signature).toBe(
    signature(1),
  );
  expect(before).toHaveLength(3);
});
it('rejects duplicate or reordered signature history rather than inventing an oldest record', async () => {
  for (const records of [
    [row(1), row(2)],
    [row(1), row(1)],
  ]) {
    await expect(
      findFirstFunder(
        address,
        async <T>(method: string) =>
          (method === 'getSignaturesForAddress' ? records : tx()) as T,
      ),
    ).rejects.toThrow();
  }
});

it('retains an actual block time and refuses invalid receipt metadata', () => {
  expect(funderInTransaction(tx(), address)?.blockTime).toBe(1700000000);
  for (const value of [
    { ...tx(), slot: -1 },
    { ...tx(), blockTime: -1 },
    { ...tx(), blockTime: Number.MAX_SAFE_INTEGER },
    { ...tx(), transaction: { ...tx().transaction, signatures: ['invalid'] } },
  ]) {
    expect(funderInTransaction(value, address)).toBeNull();
  }
  const duplicate = tx();
  duplicate.meta.innerInstructions = [
    { index: 0, instructions: [transfer()] },
    { index: 0, instructions: [transfer()] },
  ];
  expect(funderInTransaction(duplicate, address)).toBeNull();
});
it('does not skip a failed oldest transaction to manufacture funding evidence', async () => {
  let page = 0;
  const methods: string[] = [];
  const rpc: BubbleRpc = async <T>(method: string) => {
    methods.push(method);
    return (
      page++ === 0
        ? [{ ...row(1), err: { InstructionError: [0, 'failure'] } }]
        : []
    ) as T;
  };
  expect(await findFirstFunder(address, rpc)).toEqual({
    funder: null,
    reason: 'funding-unavailable',
  });
  expect(methods).toEqual([
    'getSignaturesForAddress',
    'getSignaturesForAddress',
  ]);
});
it('stops new RPC reads after a sibling fails and waits for already-started reads', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const calls: unknown[] = [];
  const failure = new Error('provider refused');
  const rpc: BubbleRpc = async <T>(_method: string, params: unknown[]) => {
    calls.push(params[0]);
    if (params[0] === address) throw failure;
    return (await pending) as T;
  };
  let settled = false;
  const result = findFunders([address, funder, other], rpc, 2).then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  release([row(1)]);
  expect(await result).toBe(failure);
  expect(calls).toEqual([address, funder]);
});
it('rejects an invalid lookup scope before making provider calls', async () => {
  let calls = 0;
  const rpc: BubbleRpc = async <T>() => {
    calls++;
    return [] as T;
  };
  for (const addresses of [[], [address, address], ['invalid']])
    await expect(findFunders(addresses, rpc)).rejects.toThrow();
  for (const concurrency of [0, 5, 1.5])
    await expect(findFunders([address], rpc, concurrency)).rejects.toThrow();
  expect(calls).toBe(0);
});

it.each([null, undefined])(
  'keeps missing inner recording unknown: %s',
  (innerInstructions) => {
    expect(
      funderInTransaction(
        { ...tx(), meta: { ...tx().meta, innerInstructions } },
        address,
      ),
    ).toBeNull();
  },
);
it('never skips malformed or unsupported instructions to use a later funding source', () => {
  for (const instruction of [
    {
      ...transfer(),
      parsed: {
        type: 'transfer',
        info: { destination: address, lamports: 1000 },
      },
    },
    {
      ...transfer(),
      parsed: { type: 'transfer', info: { source: funder, lamports: 1000 } },
    },
    { ...transfer(), parsed: { type: 'withdrawFromNonce', info: {} } },
    { programIdIndex: 0 },
    { ...transfer(), program: 'other' },
    { ...transfer(), parsed: undefined },
  ]) {
    const value = tx();
    value.transaction.message.instructions = [
      instruction,
      transfer(other),
    ] as typeof value.transaction.message.instructions;
    expect(funderInTransaction(value, address)).toBeNull();
  }
});
it('admits seeded System transfers and exact unsigned 64-bit string amounts', () => {
  for (const type of ['transferWithSeed', 'createAccountWithSeed']) {
    const value = tx();
    value.transaction.message.instructions[0].parsed = {
      type,
      info: {
        source: funder,
        destination: address,
        newAccount: address,
        lamports: '18446744073709551615',
      },
    } as never;
    expect(funderInTransaction(value, address)?.funder).toBe(funder);
  }
  for (const lamports of ['18446744073709551616', '01', '0', '-1']) {
    const value = tx();
    value.transaction.message.instructions[0].parsed.info.lamports =
      lamports as never;
    expect(funderInTransaction(value, address)).toBeNull();
  }
});
it('checks exact pagination cursors at the three-page boundary', async () => {
  const pages = [[row(3)], [row(2)], [row(1)], []];
  let page = 0;
  const rpc: BubbleRpc = async <T>(method: string, params: unknown[]) => {
    if (method === 'getTransaction') return tx() as T;
    expect(params).toEqual([
      address,
      {
        limit: 1000,
        commitment: 'finalized',
        ...(page ? { before: signature(4 - page) } : {}),
      },
    ]);
    return pages[page++] as T;
  };
  expect((await findFirstFunder(address, rpc)).funder?.signature).toBe(
    signature(1),
  );
  expect(page).toBe(4);
});
it('refuses cross-page history reversals and repeated signatures', async () => {
  for (const second of [row(3), row(2)]) {
    let page = 0;
    const rpc: BubbleRpc = async <T>() =>
      (page++ === 0 ? [row(2)] : [second]) as T;
    await expect(findFirstFunder(address, rpc)).rejects.toThrow(
      'Signature history differs',
    );
  }
});
it('keeps indistinguishable oldest transaction order unknown', async () => {
  let page = 0;
  const calls: string[] = [];
  const rpc: BubbleRpc = async <T>(method: string) => {
    calls.push(method);
    return (page++ === 0 ? [row(2), { ...row(1), slot: 2 }] : []) as T;
  };
  expect(await findFirstFunder(address, rpc)).toEqual({
    funder: null,
    reason: 'funding-unavailable',
  });
  expect(calls).toEqual(['getSignaturesForAddress', 'getSignaturesForAddress']);
});
