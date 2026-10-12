import { it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { prepareSolanaTokenFunding } from './solana-token-funding';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

const funder = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  recipient = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const source = 'Gs6NxmndAL3PULGZeYUHCknpMdDVbL46eFCBh856p5z6',
  destination = '1JpMxFCbmeBg7QkNCz4gowmn73mKi7bJiLAbCZ1Csvj';
const blockhash = bs58.encode(new Uint8Array(32).fill(3));
const encoded = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const account = (data: Uint8Array, owner = program, lamports = 2039280) => ({
  data: [encoded(data), 'base64'],
  owner,
  lamports,
  executable: false,
});
const mintData = () => {
  const data = new Uint8Array(82);
  data[44] = 6;
  data[45] = 1;
  return data;
};
const tokenData = (owner = funder, raw = 10000000n, state = 1) => {
  const data = new Uint8Array(165);
  data.set(bs58.decode(mint));
  data.set(bs58.decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, raw, true);
  data[108] = state;
  return data;
};
const doc = () => ({
  name: 'Token funding QA',
  chain: 'Solana',
  currency: 'USDC',
  assetAddress: mint,
  source: 'Wallet',
  sourceLabel: '',
  funderAddress: funder,
  startAt: new Date(Date.now() - 1000).toISOString(),
  delaySeconds: 0,
  recipients: [{ address: recipient, amount: '0.123456' }],
});
function provider(
  options: {
    accounts?: Record<string, unknown>;
    methods?: Record<string, unknown>;
  } = {},
) {
  const accounts: Record<string, unknown> = {
    [mint]: account(mintData()),
    [funder]: account(
      new Uint8Array(),
      '11111111111111111111111111111111',
      20000000,
    ),
    [source]: account(tokenData()),
    ...options.accounts,
  };
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
    const body = JSON.parse(init.body);
    calls.push(body);
    const methods: Record<string, unknown> = {
      getGenesisHash: SOLANA_MAINNET_GENESIS,
      getLatestBlockhash: {
        context: { slot: 100 },
        value: { blockhash, lastValidBlockHeight: 200 },
      },
      getAccountInfo: {
        context: { slot: 100 },
        value: accounts[body.params[0]] ?? null,
      },
      getMultipleAccounts: { context: { slot: 100 }, value: [null] },
      getMinimumBalanceForRentExemption:
        body.params[0] === 165 ? 2039280 : 890880,
      getFeeForMessage: { context: { slot: 100 }, value: 5000 },
      simulateTransaction: { context: { slot: 100 }, value: { err: null } },
      isBlockhashValid: { context: { slot: 100 }, value: true },
      getBlockHeight: 150,
      ...options.methods,
    };
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: methods[body.method],
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
it('encodes checked transfer and idempotent ATA creation with exact public keys, amount and zero signatures', async () => {
  const p = provider();
  const batch = await prepareSolanaTokenFunding(
    doc(),
    AbortSignal.timeout(2000),
    p.fetcher,
  );
  const tx = batch.transactions[0];
  expect(tx.sourceTokenAccount).toBe(source);
  expect(tx.destinationTokenAccount).toBe(destination);
  expect(tx.raw).toBe('123456');
  const message = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from(atob(tx.messageBase64), (c) => c.charCodeAt(0)),
  );
  if (message.version !== 'legacy') throw new Error('Expected legacy message');
  expect(message.header.numSignerAccounts).toBe(1);
  expect(message.staticAccounts[0]).toBe(funder);
  expect(message.instructions).toHaveLength(2);
  const create = message.instructions[0],
    transfer = message.instructions[1];
  expect(message.staticAccounts[create.programAddressIndex]).toBe(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  );
  expect(Array.from(create.data!)).toEqual([1]);
  expect(create.accountIndices?.map((i) => message.staticAccounts[i])).toEqual([
    funder,
    destination,
    recipient,
    mint,
    '11111111111111111111111111111111',
    program,
  ]);
  expect(message.staticAccounts[transfer.programAddressIndex]).toBe(program);
  expect(
    transfer.accountIndices?.map((i) => message.staticAccounts[i]),
  ).toEqual([source, mint, destination, funder]);
  expect(Array.from(transfer.data!)).toEqual([
    12, 64, 226, 1, 0, 0, 0, 0, 0, 6,
  ]);
  const wire = Uint8Array.from(atob(tx.unsignedTransactionBase64), (c) =>
    c.charCodeAt(0),
  );
  expect(wire[0]).toBe(1);
  expect(Array.from(wire.slice(1, 65))).toEqual(Array(64).fill(0));
  expect(batch.required).toBe('0.00293516');
  expect(batch.accountRent).toBe('0.00203928');
  expect(batch.total).toBe('0.123456');
  expect(batch.executionAllowed).toBe(false);
  expect(p.calls.some((c) => /send|signTransaction/.test(c.method))).toBe(
    false,
  );
  expect(
    p.calls.find((c) => c.method === 'simulateTransaction')?.params[1],
  ).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
});
it('uses existing initialized matching recipient ATAs without creation or account rent', async () => {
  const p = provider({
    methods: {
      getMultipleAccounts: {
        context: { slot: 100 },
        value: [account(tokenData(recipient, 0n))],
      },
    },
  });
  const batch = await prepareSolanaTokenFunding(
    doc(),
    AbortSignal.timeout(2000),
    p.fetcher,
  );
  expect(batch.accountRent).toBe('0');
  expect(batch.required).toBe('0.00089588');
  expect(batch.transactions[0].createAccount).toBe(false);
  const message = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from(atob(batch.transactions[0].messageBase64), (c) =>
      c.charCodeAt(0),
    ),
  );
  if (message.version !== 'legacy') throw new Error('Expected legacy message');
  expect(message.instructions).toHaveLength(1);
});
it('holds wrong decimals, extensions, source ownership, frozen accounts and SOL/token shortfalls', async () => {
  const wrongDecimals = mintData();
  wrongDecimals[44] = 9;
  const wrongNativeState = tokenData();
  new DataView(wrongNativeState.buffer).setUint32(109, 1, true);
  for (const options of [
    { accounts: { [mint]: account(wrongDecimals) } },
    {
      accounts: {
        [mint]: account(
          mintData(),
          'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        ),
      },
    },
    { accounts: { [source]: account(tokenData(recipient)) } },
    { accounts: { [source]: account(wrongNativeState) } },
    { accounts: { [source]: account(tokenData(funder, 10000000n, 2)) } },
    { accounts: { [source]: account(tokenData(funder, 1n)) } },
    {
      accounts: {
        [funder]: account(
          new Uint8Array(),
          '11111111111111111111111111111111',
          1000000,
        ),
      },
    },
    {
      methods: {
        getMultipleAccounts: {
          context: { slot: 100 },
          value: [account(tokenData(recipient, 0n, 2))],
        },
      },
    },
    {
      methods: {
        getMultipleAccounts: {
          context: { slot: 100 },
          value: [account(tokenData(recipient, (1n << 64n) - 1n))],
        },
      },
    },
  ]) {
    const p = provider(options);
    await expect(
      prepareSolanaTokenFunding(doc(), AbortSignal.timeout(2000), p.fetcher),
    ).rejects.toThrow();
    expect(p.calls.some((c) => c.method === 'simulateTransaction')).toBe(false);
  }
});
it('holds stale contexts, wrong network, unavailable fees, failed simulation and expired lifetime', async () => {
  for (const methods of [
    { getGenesisHash: 'wrong' },
    { getMultipleAccounts: { context: { slot: 99 }, value: [null] } },
    { getMultipleAccounts: { context: { slot: 150 }, value: [null] } },
    { getFeeForMessage: { context: { slot: 100 }, value: null } },
    {
      simulateTransaction: {
        context: { slot: 100 },
        value: { err: { InstructionError: [1, 'frozen'] } },
      },
    },
    { isBlockhashValid: { context: { slot: 100 }, value: false } },
    { getBlockHeight: 200 },
  ]) {
    const p = provider({ methods });
    await expect(
      prepareSolanaTokenFunding(doc(), AbortSignal.timeout(2000), p.fetcher),
    ).rejects.toThrow();
  }
});
it('requires aggregate tokens and account rent for the entire batch', async () => {
  const second = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
  const draft = {
    ...doc(),
    recipients: [
      { address: recipient, amount: '0.6' },
      { address: second, amount: '0.6' },
    ],
  };
  const p = provider({
    accounts: { [source]: account(tokenData(funder, 1000000n)) },
    methods: {
      getMultipleAccounts: { context: { slot: 100 }, value: [null, null] },
    },
  });
  await expect(
    prepareSolanaTokenFunding(draft, AbortSignal.timeout(2000), p.fetcher),
  ).rejects.toThrow('total allocation');
  expect(p.calls.some((c) => c.method === 'simulateTransaction')).toBe(false);
  const funded = provider({
    methods: {
      getMultipleAccounts: { context: { slot: 100 }, value: [null, null] },
    },
  });
  const batch = await prepareSolanaTokenFunding(
    draft,
    AbortSignal.timeout(2000),
    funded.fetcher,
  );
  expect(batch.total).toBe('1.2');
  expect(batch.accountRent).toBe('0.00407856');
  expect(batch.required).toBe('0.00497944');
});
it('holds non-immediate schedules, missing exact assets and self recipients before RPC', async () => {
  for (const patch of [
    { delaySeconds: 1 },
    { assetAddress: undefined },
    { recipients: [{ address: funder, amount: '0.1' }] },
  ]) {
    const p = provider();
    await expect(
      prepareSolanaTokenFunding(
        { ...doc(), ...patch },
        AbortSignal.timeout(2000),
        p.fetcher,
      ),
    ).rejects.toThrow();
    expect(p.calls).toHaveLength(0);
  }
});
