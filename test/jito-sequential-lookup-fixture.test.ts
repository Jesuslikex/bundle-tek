import { expect, it, vi } from 'vitest';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { jitoSequentialEconomicsFixture } from './jito-sequential-economics-fixture';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from '../lib/swap-lookup-accounts';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from '../lib/pair-rent-evidence';
import { verifyJitoBundleEconomicObservation } from '../lib/jito-bundle-economics';
for (const side of ['Buy', 'Sell'] as const)
  for (const token2022 of [false, true])
    it(`replays coherent distinct same-bank ALT sources for four ${side} wallets token2022=${token2022}`, async () => {
      const f = await jitoSequentialEconomicsFixture({
        side,
        token2022,
        lookup: true,
        wallets: 4,
      });
      expect(f.lookupAccounts).toHaveLength(4);
      expect(new Set(f.lookupAccounts.map((a) => a.address)).size).toBe(4);
      const rent = inspectPairRentAccount(f.rentAccounts.before);
      const source = new Map(
        f.lookupAccounts.map((a) => [a.address, a.account]),
      );
      for (let i = 0; i < 4; i++) {
        const packet = f.packets[i],
          tx = getTransactionDecoder().decode(
            Buffer.from(packet.transaction, 'base64'),
          );
        const message = getCompiledTransactionMessageDecoder().decode(
          tx.messageBytes,
        );
        if (message.version !== 0) throw Error('Expected unsigned v0 swap.');
        const tables = message.addressTableLookups ?? [];
        expect(tables.map((t) => String(t.lookupTableAddress))).toEqual([
          f.lookupAccounts[i].address,
        ]);
        const rpc = vi.fn(async (method: string, params: unknown[]) => {
          expect(method).toBe('getMultipleAccounts');
          expect(params).toEqual([
            [f.lookupAccounts[i].address],
            {
              encoding: 'base64',
              commitment: 'confirmed',
              minContextSlot: 101,
            },
          ]);
          return {
            context: { slot: '101' },
            value: (params[0] as string[]).map((address) =>
              structuredClone(source.get(address)),
            ),
          };
        });
        const before = await readSwapLookupAccounts(message, 101, rpc);
        const after = await readSwapLookupAccounts(message, 101, rpc);
        expect(before).not.toBeNull();
        expect(before!.observedSlot).toBe(101);
        expect({
          writable: before!.writable,
          readonly: before!.readonly,
        }).toEqual(packet.loadedAddresses);
        expect(
          before!.tables.map(({ address, sha256, lastExtendedSlot }) => ({
            address,
            sha256,
            lastExtendedSlot,
          })),
        ).toEqual(f.observations[i].simulation.lookupObservation!.tables);
        expect(() =>
          assertSameSwapLookups(before!, after, packet.loadedAddresses),
        ).not.toThrow();
        const raw = f.lookupAccounts[i].account,
          bytes = Buffer.from(raw.data[0], 'base64');
        expect(raw.owner).toBe('AddressLookupTab1e1111111111111111111111111');
        expect(raw.executable).toBe(false);
        expect(raw.lamports).toBe(pairRentMinimumRaw(rent, bytes.length));
        const digest = Buffer.from(
          await crypto.subtle.digest('SHA-256', bytes),
        ).toString('hex');
        expect(before!.tables[0].sha256).toBe(digest);
        expect(before!.tables[0].address).toBe(f.lookupAccounts[i].address);
        expect(rpc).toHaveBeenCalledTimes(2);
      }
      expect(
        (await verifyJitoBundleEconomicObservation(f)).outcomes,
      ).toHaveLength(4);
    });
it('never aliases differing raw table bytes to one address across the selected source roster', async () => {
  const f = await jitoSequentialEconomicsFixture({
    lookup: true,
    wallets: 4,
    includeRentSysvar: true,
    exposeOtherWallets: true,
  });
  const seen = new Map<string, string>();
  for (const { address, account } of f.lookupAccounts) {
    const bytes = account.data[0];
    if (seen.has(address)) expect(seen.get(address)).toBe(bytes);
    seen.set(address, bytes);
  }
  expect(new Set(f.lookupAccounts.map((a) => a.account.data[0])).size).toBe(4);
  expect(new Set(f.lookupAccounts.map((a) => a.address)).size).toBe(4);
});
it('retains no raw lookup source for swaps without ALT and leaves the legacy tip lookup-free', async () => {
  const f = await jitoSequentialEconomicsFixture({ wallets: 4 });
  expect(f.lookupAccounts).toEqual([]);
  for (const packet of f.packets) {
    const tx = getTransactionDecoder().decode(
      Buffer.from(packet.transaction, 'base64'),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(
      message.version === 0 ? (message.addressTableLookups ?? []) : [],
    ).toEqual([]);
    expect(packet.loadedAddresses).toBeNull();
  }
});
