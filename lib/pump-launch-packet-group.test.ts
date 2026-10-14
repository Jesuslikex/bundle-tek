import { expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { createHash } from 'node:crypto';
import {
  pumpCreateFixture,
  pumpFixtureQuoteAccount,
} from '../test/pump-launch-fixtures';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderMessageInput,
} from './pump-holder-message';
import { PUMP_LAUNCH_PROGRAM, PUMP_TOKEN_2022 } from './pump-launch-config';

async function fixture(
  count = 18,
  stock = false,
): Promise<PumpHolderMessageInput> {
  const create = await pumpCreateFixture(stock),
    keys = await Promise.all(
      Array.from({ length: count }, () => generateKeyPairSigner()),
    );
  return {
    create,
    developer: {
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    holders: keys.map((key, i) =>
      i % 7 === 6
        ? { address: key.address, kind: 'none' }
        : i % 2 === 0
          ? {
              address: key.address,
              kind: 'exact-base-output',
              tokenAmountRaw: '1000000',
              maximumQuoteCostRaw: '100000000',
            }
          : {
              address: key.address,
              kind: 'exact-quote-input',
              quoteAmountRaw: '1000000',
              minimumTokenOutputRaw: '1000000',
            },
    ),
  };
}
for (const mode of ['SOL', 'SPL stock', 'Token-2022 stock'] as const)
  it(`partitions complete ${mode} selections into bounded ordered unsigned packets`, async () => {
    const input = await fixture(44, mode !== 'SOL');
    if (mode === 'Token-2022 stock')
      input.create.quoteMintAccount = pumpFixtureQuoteAccount(
        undefined,
        PUMP_TOKEN_2022,
      );
    const group = await buildPumpLaunchPacketGroup(input);
    expect(group.packets.length).toBeGreaterThan(1);
    expect(group).toMatchObject({
      executionAllowed: false,
      signingAllowed: false,
      completeLaunch: false,
      atomicity: 'not-established',
      sequentialSimulationRequired: true,
      transportReviewRequired: true,
      tipIncluded: false,
    });
    const active = input.holders.flatMap((h, i) =>
      h.kind === 'none' ? [] : [i],
    );
    expect(group.packets.flatMap((p) => p.holderIndices)).toEqual(active);
    expect(group.manifest.slots).toHaveLength(input.holders.length);
    const trades = group.packets.flatMap((p) =>
      p.instructions.filter(
        (i) =>
          i.programAddress === PUMP_LAUNCH_PROGRAM && i.data?.length === 25,
      ),
    );
    expect(trades.map((i) => i.accounts![8].address)).toEqual([
      input.create.payer,
      ...active.map((i) => input.holders[i].address),
    ]);
    for (const [index, p] of group.packets.entries()) {
      expect(p.index).toBe(index);
      expect(p.packetBytes).toBeLessThanOrEqual(4096);
      expect(p.accountCount).toBeLessThanOrEqual(64);
      expect(p.requiredSigners.length).toBeLessThanOrEqual(12);
      expect(p.instructions.length).toBeLessThanOrEqual(64);
      const bytes = Buffer.from(p.transaction, 'base64'),
        tx = getTransactionDecoder().decode(bytes),
        message = getCompiledTransactionMessageDecoder().decode(
          tx.messageBytes,
        );
      expect(bytes.length).toBe(p.packetBytes);
      expect(message.version).toBe(1);
      expect(message.lifetimeToken).toBe(input.create.blockhash);
      expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
      expect(Object.keys(tx.signatures)).toEqual(p.requiredSigners);
      expect(p.requiredSigners).toEqual(
        expect.arrayContaining([
          input.create.payer,
          ...p.holderIndices.map((i) => input.holders[i].address),
          ...(index === 0 ? [input.create.mint] : []),
        ]),
      );
      expect(p.requiredSigners).toHaveLength(
        1 + p.holderIndices.length + (index === 0 ? 1 : 0),
      );
      expect(p.containsCreation).toBe(index === 0);
      expect(p.containsDeveloperBuy).toBe(index === 0);
      expect(p.buyerAccounts.map((b) => b.payer)).toEqual([
        ...(index === 0 ? [input.create.payer] : []),
        ...p.holderIndices.map((i) => input.holders[i].address),
      ]);
      expect(p.packetSha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      for (const i of p.holderIndices)
        expect(group.manifest.slots[i].packetIndex).toBe(index);
    }
    for (const slot of group.manifest.slots.filter((s) => s.kind === 'none')) {
      expect(slot.packetIndex).toBeNull();
      expect(
        group.packets.some((p) => p.requiredSigners.includes(slot.address)),
      ).toBe(false);
    }
    expect(group.manifestSha256).toBe(
      createHash('sha256').update(JSON.stringify(group.manifest)).digest('hex'),
    );
  });
it('preserves the existing one-packet bytes exactly when the full group fits', async () => {
  const input = await fixture(2),
    single = await buildPumpCreateHolderMessage(input),
    group = await buildPumpLaunchPacketGroup(input);
  expect(group.packets).toHaveLength(1);
  expect(group.packets[0].transaction).toBe(single.transaction);
  expect(group.packets[0].packetSha256).toBe(single.packetSha256);
});
it('retains all 200 slots and distinguishes count fit from atomic execution support', async () => {
  const input = await fixture(200),
    group = await buildPumpLaunchPacketGroup(input);
  expect(group.manifest.slots).toHaveLength(200);
  expect(group.activeHolderCount + group.zeroHolderCount).toBe(200);
  expect(group.packets.length).toBeGreaterThan(5);
  expect(group.jitoTransactionCountFit).toBe(false);
  expect(group.packets.flatMap((p) => p.holderIndices)).toEqual(
    input.holders.flatMap((h, i) => (h.kind === 'none' ? [] : [i])),
  );
  await expect(
    buildPumpLaunchPacketGroup({
      ...input,
      holders: [
        ...input.holders,
        { address: (await generateKeyPairSigner()).address, kind: 'none' },
      ],
    }),
  ).rejects.toThrow('200 slots');
}, 30000);
it('keeps each quote spend/minimum in one packet and covers developer-free holders', async () => {
  const input = await fixture(18, true);
  delete input.developer;
  const group = await buildPumpLaunchPacketGroup(input);
  expect(group.packets.every((p) => !p.containsDeveloperBuy)).toBe(true);
  for (const slot of group.manifest.slots.filter(
    (s) => s.kind === 'exact-quote-input',
  )) {
    const p = group.packets[slot.packetIndex!],
      trade = p.instructions.find(
        (i) =>
          i.programAddress === PUMP_LAUNCH_PROGRAM &&
          i.data?.length === 25 &&
          i.accounts![8].address === slot.address,
      )!;
    const data = Uint8Array.from(trade.data!),
      view = new DataView(data.buffer);
    expect(view.getBigUint64(8, true).toString()).toBe(slot.quoteAmountRaw);
    expect(view.getBigUint64(16, true).toString()).toBe(
      slot.minimumTokenOutputRaw,
    );
    expect(data[24]).toBe(0);
  }
});
it('hashes zero-slot identities even without instructions and snapshots supplied terms', async () => {
  const input = await fixture(7),
    first = await buildPumpLaunchPacketGroup(input),
    repeat = await buildPumpLaunchPacketGroup(input);
  expect(repeat.manifestSha256).toBe(first.manifestSha256);
  const original = structuredClone(input.holders),
    pending = buildPumpLaunchPacketGroup(input);
  input.holders[0] = { address: input.holders[0].address, kind: 'none' };
  expect((await pending).manifestSha256).toBe(first.manifestSha256);
  input.holders = original;
  input.holders[6] = {
    address: (await generateKeyPairSigner()).address,
    kind: 'none',
  };
  const changed = await buildPumpLaunchPacketGroup(input);
  expect(changed.packets.map((p) => p.packetSha256)).toEqual(
    first.packets.map((p) => p.packetSha256),
  );
  expect(changed.manifestSha256).not.toBe(first.manifestSha256);
});
it('binds public configuration evidence even when instruction bytes stay the same', async () => {
  const input = await fixture(2),
    before = await buildPumpLaunchPacketGroup(input);
  input.create.global.slot++;
  const after = await buildPumpLaunchPacketGroup(input);
  expect(after.packets.map((p) => p.packetSha256)).toEqual(
    before.packets.map((p) => p.packetSha256),
  );
  expect(after.manifestSha256).not.toBe(before.manifestSha256);
  expect(after.manifest.creationInput.global.slot).toBe(
    input.create.global.slot,
  );
  expect(after.manifest.creationInput.global.data).toBe(
    Buffer.from(input.create.global.data).toString('base64'),
  );
});
it('rejects invalid complete selections and cancellation without partial groups', async () => {
  const input = await fixture(18);
  await expect(
    buildPumpLaunchPacketGroup({
      ...input,
      holders: [{ ...input.holders[0], address: input.create.payer }],
    }),
  ).rejects.toThrow('distinct');
  const controller = new AbortController(),
    pending = buildPumpLaunchPacketGroup(input, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
