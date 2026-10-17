import { expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { PUMP_LAUNCH_PROGRAM } from './pump-launch-config';

const lifetime = {
  blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  lastValidBlockHeight: 900n,
};

for (const stock of [false, true])
  it(`builds a holder-only unsigned buy without the create instruction (${stock ? 'stock' : 'SOL'})`, async () => {
    const create = await pumpCreateFixture(stock);
    const holder = (await generateKeyPairSigner()).address;
    const built = await buildPumpOrganicBuyMessage({
      create,
      holder,
      tokenAmountRaw: '1000000000',
      maximumQuoteCostRaw: '5000000',
      ...lifetime,
    });
    expect(built).toMatchObject({
      format: 'pump-organic-buy-unsigned-v1',
      holder,
      mint: create.mint,
      requiredSigners: [holder],
      tokenAmountRaw: '1000000000',
      maximumQuoteCostRaw: '5000000',
      lastValidBlockHeight: '900',
      simulationRequired: true,
      signingAllowed: false,
      executionAllowed: false,
    });
    const tx = getTransactionDecoder().decode(
      Buffer.from(built.transaction, 'base64'),
    );
    expect(Object.keys(tx.signatures)).toEqual([holder]);
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(message.header.numSignerAccounts).toBe(1);
    expect(message.staticAccounts[0]).toBe(holder);
    expect(String(message.lifetimeToken)).toBe(lifetime.blockhash);
    // Only the final instruction targets Pump, and it is the buy, not create.
    const pump = built.instructions.filter(
      (i) => String(i.programAddress) === PUMP_LAUNCH_PROGRAM,
    );
    expect(pump).toHaveLength(1);
    expect(built.instructions.at(-1)).toBe(pump[0]);
    const data = pump[0].data!;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getBigUint64(8, true)).toBe(1000000000n);
    expect(view.getBigUint64(16, true)).toBe(5000000n);
  });

it('rejects the deployer, the mint, unknown options and invalid amounts', async () => {
  const create = await pumpCreateFixture(false);
  const holder = (await generateKeyPairSigner()).address;
  const base = {
    create,
    holder,
    tokenAmountRaw: '1000',
    maximumQuoteCostRaw: '1000',
    ...lifetime,
  };
  await expect(
    buildPumpOrganicBuyMessage({ ...base, holder: create.payer }),
  ).rejects.toThrow('differ');
  await expect(
    buildPumpOrganicBuyMessage({ ...base, holder: create.mint }),
  ).rejects.toThrow('differ');
  await expect(
    buildPumpOrganicBuyMessage({ ...base, extra: 1 } as never),
  ).rejects.toThrow('Unsupported');
  await expect(
    buildPumpOrganicBuyMessage({ ...base, tokenAmountRaw: '0' }),
  ).rejects.toThrow('canonical');
});
