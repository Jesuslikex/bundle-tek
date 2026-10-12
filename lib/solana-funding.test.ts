import { it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { prepareSolanaFunding, solanaTransferMessage } from './solana-funding';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const from = bs58.encode(new Uint8Array(32).fill(1)),
  to = bs58.encode(new Uint8Array(32).fill(2)),
  blockhash = bs58.encode(new Uint8Array(32).fill(3));
const doc = () => ({
  name: 'QA SOL',
  chain: 'Solana',
  currency: 'SOL',
  source: 'Wallet',
  sourceLabel: '',
  funderAddress: from,
  startAt: new Date(Date.now() - 1000).toISOString(),
  delaySeconds: 0,
  recipients: [{ address: to, amount: '0.01' }],
});
const account = (lamports: number) => ({
  lamports,
  owner: '11111111111111111111111111111111',
  executable: false,
  data: ['', 'base64'],
});
function provider(patch: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const data = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getLatestBlockhash: {
      context: { slot: 100 },
      value: { blockhash, lastValidBlockHeight: 200 },
    },
    getAccountInfo: { context: { slot: 100 }, value: account(20000000) },
    getMultipleAccounts: { context: { slot: 100 }, value: [null] },
    getMinimumBalanceForRentExemption: 890880,
    getFeeForMessage: { context: { slot: 100 }, value: 5000 },
    simulateTransaction: { context: { slot: 100 }, value: { err: null } },
    isBlockhashValid: { context: { slot: 100 }, value: true },
    getBlockHeight: 150,
    ...patch,
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('Expected JSON request');
    const b = JSON.parse(init.body);
    calls.push(b);
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: data[b.method as keyof typeof data],
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
it('independently decodes the exact legacy system transfer message', () => {
  const message = solanaTransferMessage(from, to, blockhash, 123456789012345n);
  const decoded = getCompiledTransactionMessageDecoder().decode(message);
  expect(decoded.version).toBe('legacy');
  if (decoded.version !== 'legacy') throw new Error('Expected legacy transfer');
  expect(decoded.staticAccounts).toEqual([
    from,
    to,
    '11111111111111111111111111111111',
  ]);
  expect(decoded.header).toMatchObject({
    numSignerAccounts: 1,
    numReadonlySignerAccounts: 0,
    numReadonlyNonSignerAccounts: 1,
  });
  expect(decoded.instructions[0].programAddressIndex).toBe(2);
  expect(decoded.instructions[0].accountIndices).toEqual([0, 1]);
  const data = decoded.instructions[0].data!;
  expect(
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
      0,
      true,
    ),
  ).toBe(2);
  expect(
    new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
      4,
      true,
    ),
  ).toBe(123456789012345n);
});
it('quotes fees, conserves aggregate funds/rent and simulates without signing/sending', async () => {
  const p = provider();
  const b = await prepareSolanaFunding(
    doc(),
    AbortSignal.timeout(1000),
    p.fetcher,
  );
  expect(b.required).toBe('0.01089588');
  expect(b.fees).toBe('0.000005');
  expect(b.signed).toBe(false);
  expect(b.transactions[0].lamports).toBe('10000000');
  const wire = Uint8Array.from(
    atob(b.transactions[0].unsignedTransactionBase64),
    (c) => c.charCodeAt(0),
  );
  expect(Array.from(wire.slice(1, 65))).toEqual(Array(64).fill(0));
  expect(p.calls.some((c) => /send|signTransaction/.test(c.method))).toBe(
    false,
  );
  expect(
    p.calls.find((c) => c.method === 'simulateTransaction')?.params[1],
  ).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
});
it('refuses rent/balance shortfalls, data-bearing accounts and unavailable fees', async () => {
  for (const patch of [
    { getAccountInfo: { context: { slot: 100 }, value: account(10000000) } },
    {
      getAccountInfo: {
        context: { slot: 100 },
        value: { ...account(20000000), data: ['AA==', 'base64'] },
      },
    },
    { getFeeForMessage: { context: { slot: 100 }, value: null } },
  ]) {
    const p = provider(patch);
    await expect(
      prepareSolanaFunding(doc(), AbortSignal.timeout(1000), p.fetcher),
    ).rejects.toThrow();
  }
  const p = provider();
  await expect(
    prepareSolanaFunding(
      { ...doc(), recipients: [{ address: to, amount: '0.000000001' }] },
      AbortSignal.timeout(1000),
      p.fetcher,
    ),
  ).rejects.toThrow('rent');
});
it('refuses wrong network, failed simulations, slot drift and expired blockhash', async () => {
  for (const patch of [
    { getGenesisHash: 'other' },
    {
      simulateTransaction: {
        context: { slot: 100 },
        value: { err: { InstructionError: [0, 'failed'] } },
      },
    },
    { getAccountInfo: { context: { slot: 150 }, value: account(20000000) } },
    { getAccountInfo: { context: { slot: 99 }, value: account(20000000) } },
    { isBlockhashValid: { context: { slot: 100 }, value: false } },
    { isBlockhashValid: { context: { slot: 100 }, value: 'true' } },
    { getBlockHeight: 200 },
  ]) {
    const p = provider(patch);
    await expect(
      prepareSolanaFunding(doc(), AbortSignal.timeout(1000), p.fetcher),
    ).rejects.toThrow();
  }
});
it('checks aggregate batch funds rather than only individual transfers', async () => {
  const second = bs58.encode(Uint8Array.from({ length: 32 }, () => 4));
  const draft = {
    ...doc(),
    recipients: [
      { address: to, amount: '0.01' },
      { address: second, amount: '0.01' },
    ],
  };
  const short = provider({
    getMultipleAccounts: { context: { slot: 100 }, value: [null, null] },
  });
  await expect(
    prepareSolanaFunding(draft, AbortSignal.timeout(1000), short.fetcher),
  ).rejects.toThrow('Funder balance');
  expect(short.calls.some((c) => c.method === 'simulateTransaction')).toBe(
    false,
  );
  const funded = provider({
    getMultipleAccounts: { context: { slot: 100 }, value: [null, null] },
    getAccountInfo: { context: { slot: 100 }, value: account(30000000) },
  });
  const batch = await prepareSolanaFunding(
    draft,
    AbortSignal.timeout(1000),
    funded.fetcher,
  );
  expect(batch.required).toBe('0.02090088');
  expect(batch.transactions).toHaveLength(2);
  expect(
    funded.calls.filter((c) => c.method === 'simulateTransaction'),
  ).toHaveLength(2);
});
it('rejects schedules, unsupported assets and self transfers before usable preparation', async () => {
  for (const patch of [
    { delaySeconds: 1 },
    { currency: 'USDC' },
    { recipients: [{ address: from, amount: '0.01' }] },
  ]) {
    const p = provider();
    await expect(
      prepareSolanaFunding(
        { ...doc(), ...patch },
        AbortSignal.timeout(1000),
        p.fetcher,
      ),
    ).rejects.toThrow();
    expect(p.calls).toHaveLength(0);
  }
});
