import { expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import schema from './pump-exact-quote-schema.json';
import { PUMP_LAUNCH_PROGRAM } from './pump-launch-config';
async function fixture(stock = false) {
  const create = await pumpCreateFixture(stock);
  const wallets = await Promise.all(
    Array.from(
      { length: 3 },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
  const holders: PumpHolderBuy[] = [
    {
      address: wallets[0],
      kind: 'exact-base-output',
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    {
      address: wallets[1],
      kind: 'exact-quote-input',
      quoteAmountRaw: '1000000',
      minimumTokenOutputRaw: '1000000',
    },
    { address: wallets[2], kind: 'none' },
  ];
  return {
    create,
    holders,
    developer: {
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
  };
}
for (const stock of [false, true])
  it(`builds one creation plus ordered developer/holder buys with all exact unsigned signers (${stock ? 'stock' : 'SOL'})`, async () => {
    const f = await fixture(stock),
      built = await buildPumpCreateHolderMessage(f);
    expect(built).toMatchObject({
      transactionVersion: 1,
      containsHolderBuys: true,
      containsDeveloperBuy: true,
      executionAllowed: false,
      signingAllowed: false,
      simulationRequired: true,
      activeHolderCount: 2,
      migrationSimulationRequired: true,
    });
    expect(built.holderSlots).toEqual(f.holders);
    expect(built.requiredSigners).toHaveLength(4);
    expect(built.requiredSigners).toContain(f.create.mint);
    expect(built.requiredSigners).not.toContain(f.holders[2].address);
    const tx = getTransactionDecoder().decode(
      Buffer.from(built.transaction, 'base64'),
    );
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(message).toMatchObject({ version: 1, configMask: 15 });
    expect(built.packetBytes).toBeLessThanOrEqual(4096);
    const trades = built.instructions.filter(
      (i) => i.programAddress === PUMP_LAUNCH_PROGRAM && i.data?.length === 25,
    );
    expect(trades).toHaveLength(3);
    expect(trades.map((i) => i.accounts![8].address)).toEqual([
      f.create.payer,
      f.holders[0].address,
      f.holders[1].address,
    ]);
    const quote = trades[2];
    expect(Array.from(quote.data!.slice(0, 8))).toEqual([
      225, 247, 80, 30, 213, 179, 132, 136,
    ]);
    expect(quote.accounts).toHaveLength(17);
    const bytes = Uint8Array.from(quote.data!),
      view = new DataView(bytes.buffer);
    expect(view.getBigUint64(8, true)).toBe(1000000n);
    expect(view.getBigUint64(16, true)).toBe(1000000n);
    expect(trades.every((i) => i.data![24] === 0)).toBe(true);
    expect(schema.instruction.args.map((a) => a.name)).toEqual([
      'spendable_quote_in',
      'min_tokens_out',
      'partial_fill',
    ]);
  });
it('supports holder-only buys while retaining the separate mint and creation fee payer', async () => {
  const f = await fixture(),
    built = await buildPumpCreateHolderMessage({
      create: f.create,
      holders: f.holders,
    });
  expect(built.containsDeveloperBuy).toBe(false);
  expect(built.requiredSigners[0]).toBe(f.create.payer);
  expect(built.buyerAccounts.map((b) => b.payer)).toEqual(
    f.holders.slice(0, 2).map((h) => h.address),
  );
});
it('rejects duplicate roles, mixed denominations, missing minima, curve exhaustion and cancellation', async () => {
  const f = await fixture();
  await expect(
    buildPumpCreateHolderMessage({
      ...f,
      holders: [{ ...f.holders[0], address: f.create.payer }],
    }),
  ).rejects.toThrow('distinct');
  await expect(
    buildPumpCreateHolderMessage({
      ...f,
      holders: [{ ...f.holders[1], tokenAmountRaw: '1' } as PumpHolderBuy],
    }),
  ).rejects.toThrow('denomination');
  await expect(
    buildPumpCreateHolderMessage({
      ...f,
      holders: [
        {
          address: f.holders[1].address,
          kind: 'exact-quote-input',
          quoteAmountRaw: '1',
          minimumTokenOutputRaw: '0',
        },
      ],
    }),
  ).rejects.toThrow('positive');
  await expect(
    buildPumpCreateHolderMessage({
      ...f,
      holders: [
        {
          address: f.holders[0].address,
          kind: 'exact-base-output',
          tokenAmountRaw: '793100000000000',
          maximumQuoteCostRaw: '100000000',
        },
      ],
    }),
  ).rejects.toThrow('leave tokens');
  const controller = new AbortController();
  controller.abort();
  await expect(
    buildPumpCreateHolderMessage(f, controller.signal),
  ).rejects.toThrow('cancelled');
});
it('rejects complete oversized holder groups without returning a silently truncated packet', async () => {
  const f = await fixture();
  const holders: PumpHolderBuy[] = await Promise.all(
    Array.from({ length: 44 }, async () => ({
      address: (await generateKeyPairSigner()).address,
      kind: 'exact-base-output' as const,
      tokenAmountRaw: '1',
      maximumQuoteCostRaw: '100000000',
    })),
  );
  await expect(buildPumpCreateHolderMessage({ ...f, holders })).rejects.toThrow(
    'no slots were removed',
  );
});

it('rejects the signer count when the signer-only byte lower bound fits', async () => {
  const f = await fixture();
  const holders: PumpHolderBuy[] = await Promise.all(
    Array.from({ length: 18 }, async () => ({
      address: (await generateKeyPairSigner()).address,
      kind: 'exact-base-output' as const,
      tokenAmountRaw: '1',
      maximumQuoteCostRaw: '100000000',
    })),
  );
  await expect(buildPumpCreateHolderMessage({ ...f, holders })).rejects.toThrow(
    'no partial packet was returned',
  );
});
