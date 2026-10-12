import { expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { solanaTransferMessage } from './solana-funding';
import { preparationHistoryFixture } from '../test/imported-preparation-history-fixture';
import {
  decodeWarmupBuyReceipt,
  decodeWarmupReceipt,
  observeWarmupBuyReceipt,
  type SavedWarmupBuyReceipt,
} from './warmup-buy-receipt';
import { warmupBuyLink, requireStoredWarmupBuyLink } from './warmup-buy-link';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import type { WarmupSellInventory } from './warmup-sell-inventory';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WRAPPED = 'So11111111111111111111111111111111111111112';
const account = bs58.encode(new Uint8Array(32).fill(2)),
  mint = bs58.encode(new Uint8Array(32).fill(3));
const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function fixture() {
  const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),
    wallet = bs58.encode(signer.publicKey);
  // A signed envelope fixture with mocked balance metadata. This does not model a live swap.
  const message = Uint8Array.from([
    128,
    ...solanaTransferMessage(
      wallet,
      account,
      '11111111111111111111111111111111',
      1n,
    ),
    0,
  ]);
  const sig = nacl.sign.detached(message, signer.secretKey),
    signature = bs58.encode(sig);
  const unsigned = Uint8Array.from([1, ...new Uint8Array(64), ...message]),
    signed = Uint8Array.from([1, ...sig, ...message]);
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', unsigned.buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const preparation: SavedWarmupPreparation = {
    id: '00000000-0000-4000-8000-000000000001',
    planId: 'qa',
    planRevision: 1,
    cycle: 2,
    walletRevision: 1,
    createdAt: new Date().toISOString(),
    document: {
      ...preparationHistoryFixture(),
      side: 'Buy',
      wallet,
      inputMint: WRAPPED,
      outputMint: mint,
      minimumOutRaw: '100',
      transaction: {
        ...preparationHistoryFixture().transaction,
        sha256: sha,
        bytes: unsigned.length,
      },
      inventory: null,
    },
  };
  const balance = (amount: string) => ({
    accountIndex: '1',
    mint,
    owner: wallet,
    programId: TOKEN,
    uiTokenAmount: { amount, decimals: '6' },
  });
  const raw = {
    version: '0',
    slot: '300',
    blockTime: null,
    transaction: [wire(signed), 'base64'],
    meta: {
      err: null as unknown,
      fee: '5000',
      loadedAddresses: { writable: [] as string[], readonly: [] as string[] },
      preBalances: ['1000000', '1', '1'],
      postBalances: ['995000', '1', '1'],
      preTokenBalances: [balance('9007199254740993')],
      postTokenBalances: [balance('9007199254741094')],
      logMessages: ['private-log-sentinel'],
    },
  };
  return { preparation, signature, raw, wallet, signed };
}
it('verifies the wallet signature and exact saved packet, counting only the net standard SPL increase', async () => {
  const f = await fixture();
  const receipt = await decodeWarmupBuyReceipt(
    f.raw,
    f.preparation,
    f.signature,
  );
  expect(receipt).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    commitment: 'finalized',
    signatureVerified: true,
    acquiredRaw: '101',
    decimals: 6,
    slot: 300,
    nativeChangeRaw: '-5000',
    networkFeeLamports: '5000',
  });
  expect(receipt.limitations).toContain(
    'does not verify swap instruction semantics',
  );
  expect(JSON.stringify(receipt)).not.toContain('private-log-sentinel');
  expect(receipt).not.toHaveProperty('transaction');
  expect(receipt).not.toHaveProperty('signatures');
});
it('verifies exact sell debit and native output, rejecting a missing minimum or changed token units', async () => {
  const f = await fixture();
  const preparation = {
    ...f.preparation,
    document: {
      ...f.preparation.document,
      side: 'Sell' as const,
      inputMint: mint,
      outputMint: WRAPPED,
      inAmountRaw: '101',
      minimumOutRaw: '100',
    },
  };
  f.raw.meta.preTokenBalances[0].uiTokenAmount.amount = '9007199254741094';
  f.raw.meta.postTokenBalances[0].uiTokenAmount.amount = '9007199254740993';
  f.raw.meta.postBalances[0] = '995100';
  expect(
    await decodeWarmupReceipt(f.raw, preparation, f.signature, 'Sell'),
  ).toMatchObject({ acquiredRaw: '101', nativeChangeRaw: '-4900' });
  f.raw.meta.postBalances[0] = '995099';
  await expect(
    decodeWarmupReceipt(f.raw, preparation, f.signature, 'Sell'),
  ).rejects.toThrow();
  f.raw.meta.postBalances[0] = '995100';
  f.raw.meta.postTokenBalances[0].uiTokenAmount.amount = '9007199254740994';
  await expect(
    decodeWarmupReceipt(f.raw, preparation, f.signature, 'Sell'),
  ).rejects.toThrow();
});
it('rejects mismatched saved fingerprints, wallets and invalid cryptographic signatures', async () => {
  const f = await fixture();
  await expect(
    decodeWarmupBuyReceipt(
      f.raw,
      {
        ...f.preparation,
        document: {
          ...f.preparation.document,
          transaction: {
            ...f.preparation.document.transaction,
            sha256: 'f'.repeat(64),
          },
        },
      },
      f.signature,
    ),
  ).rejects.toThrow('saved buy packet');
  await expect(
    decodeWarmupBuyReceipt(
      f.raw,
      {
        ...f.preparation,
        document: { ...f.preparation.document, wallet: account },
      },
      f.signature,
    ),
  ).rejects.toThrow();
  const changed = Uint8Array.from(f.signed);
  changed[1] ^= 1;
  await expect(
    decodeWarmupBuyReceipt(
      { ...f.raw, transaction: [wire(changed), 'base64'] },
      f.preparation,
      bs58.encode(changed.slice(1, 65)),
    ),
  ).rejects.toThrow('Invalid wallet signature');
  await expect(
    decodeWarmupBuyReceipt(
      f.raw,
      f.preparation,
      bs58.encode(new Uint8Array(64).fill(1)),
    ),
  ).rejects.toThrow('signature mismatch');
});
it('rejects failed or incomplete token evidence, unsupported token programs and output below the minimum', async () => {
  const f = await fixture();
  for (const raw of [
    { ...f.raw, version: '1' },
    { ...f.raw, meta: { ...f.raw.meta, err: { InstructionError: [0, 1] } } },
    { ...f.raw, meta: { ...f.raw.meta, preTokenBalances: null } },
    {
      ...f.raw,
      meta: {
        ...f.raw.meta,
        loadedAddresses: { writable: [account], readonly: [] },
      },
    },
    {
      ...f.raw,
      meta: {
        ...f.raw.meta,
        postTokenBalances: [
          { ...f.raw.meta.postTokenBalances[0], owner: undefined },
        ],
      },
    },
    {
      ...f.raw,
      meta: {
        ...f.raw.meta,
        preTokenBalances: [],
        postTokenBalances: [
          { ...f.raw.meta.postTokenBalances[0], programId: account },
        ],
      },
    },
    {
      ...f.raw,
      meta: {
        ...f.raw.meta,
        postTokenBalances: [
          {
            ...f.raw.meta.postTokenBalances[0],
            uiTokenAmount: { amount: '9007199254740994', decimals: '6' },
          },
        ],
      },
    },
    { ...f.raw, transaction: ['bad', 'base64'] },
  ])
    await expect(
      decodeWarmupBuyReceipt(raw, f.preparation, f.signature),
    ).rejects.toThrow();
});
it('uses only finalized read RPCs on the verified network and rejects unavailable history', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string')
      throw new Error('JSON RPC body required.');
    const input = JSON.parse(init.body);
    calls.push(input.method);
    if (input.method === 'getTransaction')
      expect(input.params[1]).toEqual({
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        input.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : f.raw,
    });
  });
  expect(
    await observeWarmupBuyReceipt(
      f.preparation,
      f.signature,
      AbortSignal.timeout(1000),
      fetcher as typeof fetch,
    ),
  ).toMatchObject({ acquiredRaw: '101', source: expect.any(String) });
  expect(calls).toEqual(['getGenesisHash', 'getTransaction']);
  await expect(
    observeWarmupBuyReceipt(
      f.preparation,
      f.signature,
      AbortSignal.timeout(1000),
      vi.fn(async () =>
        Response.json({ jsonrpc: '2.0', id: 1, result: 'wrong-network' }),
      ) as typeof fetch,
    ),
  ).rejects.toThrow('network mismatch');
  await expect(
    observeWarmupBuyReceipt(
      f.preparation,
      f.signature,
      AbortSignal.timeout(1000),
      vi.fn(async (_url, init) =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result:
            JSON.parse(String(init?.body)).method === 'getGenesisHash'
              ? SOLANA_MAINNET_GENESIS
              : null,
        }),
      ) as typeof fetch,
    ),
  ).rejects.toThrow('unavailable');
});
it('caps linked sell inputs and rejects cross-cycle, revision, wallet, mint and stale-slot inventory', async () => {
  const f = await fixture();
  const receipt: SavedWarmupBuyReceipt = {
    id: 'receipt',
    preparationId: f.preparation.id,
    planId: 'qa',
    planRevision: 1,
    cycle: 2,
    walletRevision: 1,
    createdAt: new Date().toISOString(),
    document: {
      ...(await decodeWarmupBuyReceipt(f.raw, f.preparation, f.signature)),
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
    },
  };
  const context = {
    planId: 'qa',
    planRevision: 1,
    cycle: 2,
    wallet: f.wallet,
    walletRevision: 1,
    mint,
  };
  const inventory = {
    wallet: f.wallet,
    mint,
    tokenProgram: TOKEN,
    decimals: 6,
    minSlot: 300,
    requestedRaw: '101',
  } as WarmupSellInventory;
  expect(warmupBuyLink(receipt, context, inventory)).toMatchObject({
    receiptId: 'receipt',
    acquiredRaw: '101',
  });
  for (const patch of [
    { cycle: 1 },
    { planRevision: 2 },
    { wallet: account },
    { mint: account },
    { walletRevision: 2 },
    { planId: 'other' },
  ])
    expect(() =>
      warmupBuyLink(receipt, { ...context, ...patch }, inventory),
    ).toThrow();
  for (const patch of [
    { requestedRaw: '102' },
    { minSlot: 299 },
    { decimals: 9 },
    { tokenProgram: account },
  ])
    expect(() =>
      warmupBuyLink(receipt, context, { ...inventory, ...patch }),
    ).toThrow();
});
it('requires explicit historical-lot selection and preserves its original provenance and fences', async () => {
  const f = await fixture();
  const receipt: SavedWarmupBuyReceipt = {
    id: 'receipt',
    preparationId: f.preparation.id,
    planId: 'qa',
    planRevision: 1,
    cycle: 2,
    walletRevision: 1,
    createdAt: new Date().toISOString(),
    document: {
      ...(await decodeWarmupBuyReceipt(f.raw, f.preparation, f.signature)),
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
    },
  };
  const context = {
    planId: 'qa',
    planRevision: 3,
    cycle: 2,
    wallet: f.wallet,
    walletRevision: 2,
    mint,
  };
  expect(() => warmupBuyLink(receipt, context)).toThrow();
  const link = warmupBuyLink(receipt, { ...context, allowHistoricalBuy: true });
  expect(link.historicalBuy).toEqual({ planRevision: 1, walletRevision: 1 });
  expect(requireStoredWarmupBuyLink(receipt, context, link)).toMatchObject({
    signature: f.signature,
    acquiredRaw: '101',
    historicalBuy: { planRevision: 1, walletRevision: 1 },
  });
  for (const patch of [
    { planId: 'other' },
    { cycle: 1 },
    { wallet: account },
    { mint: account },
    { planRevision: 0 },
    { walletRevision: 0 },
  ])
    expect(() =>
      warmupBuyLink(receipt, {
        ...context,
        ...patch,
        allowHistoricalBuy: true,
      }),
    ).toThrow();
  for (const patch of [
    { signature: 'changed' },
    { preparationSha256: 'changed' },
    { acquiredRaw: '102' },
    { historicalBuy: { planRevision: 2, walletRevision: 1 } },
    { historicalBuy: undefined },
  ])
    expect(() =>
      requireStoredWarmupBuyLink(receipt, context, { ...link, ...patch }),
    ).toThrow();
  expect(() =>
    warmupBuyLink(receipt, { ...context, allowHistoricalBuy: true }, {
      wallet: f.wallet,
      mint,
      tokenProgram: TOKEN,
      decimals: 6,
      minSlot: 300,
      requestedRaw: '102',
    } as WarmupSellInventory),
  ).toThrow();
});
