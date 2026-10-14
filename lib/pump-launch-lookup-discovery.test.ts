import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { buildPumpCreateMessage } from './pump-launch-message';
import { discoverPumpLaunchLookups } from './pump-launch-lookup-discovery';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { pumpLaunchLookupTables } from './pump-launch-lookups';
const signature = bs58.encode(new Uint8Array(64).fill(3));
async function fixture() {
  const create = await pumpCreateFixture(),
    built = await buildPumpCreateMessage(create);
  const keys = built.instruction.accounts!.slice(1, 5).map((a) => a.address);
  const data = new Uint8Array(56 + keys.length * 32),
    view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, (1n << 64n) - 1n, true);
  view.setBigUint64(12, 99n, true);
  keys.forEach((key, n) =>
    data.set(getAddressEncoder().encode(key), 56 + n * 32),
  );
  const table = {
    address: (await generateKeyPairSigner()).address,
    owner: 'AddressLookupTab1e1111111111111111111111111',
    executable: false,
    data,
    slot: 100,
  };
  const transaction = {
    version: '0',
    meta: { err: null as unknown },
    transaction: {
      signatures: [signature],
      message: { addressTableLookups: [{ accountKey: table.address }] },
    },
  };
  const snapshot = {
    context: { slot: '100' },
    value: [
      {
        owner: table.owner,
        executable: false,
        data: [btoa(String.fromCharCode(...data)), 'base64'],
      },
    ],
  };
  const rpc = vi.fn(async (method: string) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getSignaturesForAddress') return [{ err: null, signature }];
    if (method === 'getTransaction') return transaction;
    if (method === 'getMultipleAccounts') return snapshot;
    throw new Error('Unexpected RPC method');
  });
  return { create, table, transaction, snapshot, rpc };
}
it('discovers bounded current active tables and opts history reads into v1', async () => {
  const f = await fixture(),
    result = await discoverPumpLaunchLookups(
      f.create,
      new AbortController().signal,
      f.rpc,
    );
  expect(result.tables.map((t) => t.address)).toEqual([f.table.address]);
  expect(result.reads).toBe(4);
  expect(result.executionAllowed).toBe(false);
  expect(result.coverage).toBe('bounded-public-history');
  expect(f.rpc).toHaveBeenCalledWith(
    'getTransaction',
    [
      signature,
      {
        encoding: 'json',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 1,
      },
    ],
    expect.any(AbortSignal),
  );
});
it('accepts successful v1 history without pretending it contains address tables', async () => {
  const f = await fixture();
  f.transaction.version = '1';
  f.transaction.transaction.message.addressTableLookups = [];
  const result = await discoverPumpLaunchLookups(
    f.create,
    new AbortController().signal,
    f.rpc,
  );
  expect(result.tables).toEqual([]);
  expect(result.reads).toBe(3);
  expect(result.unavailableTransactions).toBe(0);
});
it('reports missing and failed transactions instead of treating sampled coverage as complete', async () => {
  const f = await fixture();
  const rpc = vi.fn(async (method: string) =>
    method === 'getTransaction' ? null : f.rpc(method),
  );
  const result = await discoverPumpLaunchLookups(
    f.create,
    new AbortController().signal,
    rpc,
  );
  expect(result.unavailableTransactions).toBe(1);
  expect(result.tables).toEqual([]);
  f.transaction.meta.err = {};
  expect(
    (
      await discoverPumpLaunchLookups(
        f.create,
        new AbortController().signal,
        f.rpc,
      )
    ).unavailableTransactions,
  ).toBe(1);
});
it('cancels an in-flight provider that ignores its abort signal', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const pending = discoverPumpLaunchLookups(
    f.create,
    controller.signal,
    async (method) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      notify();
      return new Promise(() => {});
    },
  );
  await entered;
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled or timed out');
});
it('rejects non-mainnet and inconsistent observations, and skips invalid table owners', async () => {
  const f = await fixture();
  await expect(
    discoverPumpLaunchLookups(
      f.create,
      new AbortController().signal,
      async () => 'wrong-genesis',
    ),
  ).rejects.toThrow('not mainnet');
  f.snapshot.context.slot = '140';
  await expect(
    discoverPumpLaunchLookups(f.create, new AbortController().signal, f.rpc),
  ).rejects.toThrow('snapshot differs');
  f.snapshot.context.slot = '100';
  f.snapshot.value[0].owner = f.create.payer;
  const result = await discoverPumpLaunchLookups(
    f.create,
    new AbortController().signal,
    f.rpc,
  );
  expect(result.rejectedTables).toBe(1);
  expect(result.tables).toEqual([]);
});
it('limits history and propagates cancellation without reading further', async () => {
  const f = await fixture(),
    aborted = new AbortController();
  aborted.abort();
  await expect(
    discoverPumpLaunchLookups(f.create, aborted.signal, f.rpc),
  ).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
  await expect(
    discoverPumpLaunchLookups(
      f.create,
      new AbortController().signal,
      async (method) =>
        method === 'getGenesisHash'
          ? SOLANA_MAINNET_GENESIS
          : Array(9).fill({ err: null, signature }),
    ),
  ).rejects.toThrow('history is unavailable');
});
it('excludes same-slot extensions until active and rejects noncanonical table metadata', async () => {
  const f = await fixture(),
    view = new DataView(f.table.data.buffer);
  view.setBigUint64(12, 100n, true);
  f.table.data[20] = 1;
  const parsed = await pumpLaunchLookupTables([f.table], [100]);
  expect(parsed.observations[0].activeCount).toBe(1);
  expect(Object.values(parsed.mappings)[0]).toHaveLength(1);
  f.table.data[21] = 2;
  await expect(pumpLaunchLookupTables([f.table], [100])).rejects.toThrow(
    'not active or canonical',
  );
});
