import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  address,
  getAddressEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  generateKeyPairSigner,
} from '@solana/kit';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import { buildPumpCreateMessage } from './pump-launch-message';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import schema from './pump-initial-buy-schema.json';
async function lookupFor(
  create: Awaited<ReturnType<typeof pumpCreateFixture>>,
) {
  const built = await buildPumpCreateMessage(create);
  const keys = [
    ...new Set(
      built.instruction
        .accounts!.map((a) => a.address)
        .filter((a) => a !== create.mint && a !== create.payer),
    ),
  ];
  const bytes = new Uint8Array(56 + keys.length * 32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, (1n << 64n) - 1n, true);
  view.setBigUint64(12, 99n, true);
  keys.forEach((key, n) =>
    bytes.set(getAddressEncoder().encode(key), 56 + 32 * n),
  );
  return {
    address: (await generateKeyPairSigner()).address,
    owner: 'AddressLookupTab1e1111111111111111111111111',
    executable: false,
    data: bytes,
    slot: 100,
  };
}
it('pins the buy discriminator and independent account order to the official schema', () => {
  expect(
    Array.from(
      createHash('sha256').update('global:buy_v3').digest().subarray(0, 8),
    ),
  ).toEqual(schema.instruction.discriminator);
  expect(schema.instruction.accounts.map((a) => a.name)).toEqual([
    'global',
    'base_mint',
    'quote_mint',
    'base_token_program',
    'quote_token_program',
    'bonding_curve',
    'associated_base_bonding_curve',
    'associated_quote_bonding_curve',
    'user',
    'associated_base_user',
    'associated_quote_user',
    'user_volume_accumulator',
    'fee_config',
    'buyback_fee_recipient',
    'system_program',
    'event_authority',
    'program',
  ]);
});
for (const stock of [false, true])
  it(`builds a completely unsigned atomic create + exact-output initial buy (${stock ? 'stock quote' : 'SOL'})`, async () => {
    const create = await pumpCreateFixture(stock),
      lookup = await lookupFor(create);
    const result = await buildPumpCreateAndBuyMessage({
      transactionVersion: 0,
      create,
      lookupTables: [lookup],
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '1000000000',
    });
    expect(result.containsInitialBuy).toBe(true);
    expect(result.packetBytes).toBeLessThanOrEqual(1232);
    expect(result.signingAllowed).toBe(false);
    expect(result.executionAllowed).toBe(false);
    expect(result.quoteMint).toBe(create.quoteMint);
    expect(result.instructions).toHaveLength(stock ? 5 : 4);
    const tx = getTransactionDecoder().decode(
      Uint8Array.from(atob(result.transaction), (c) => c.charCodeAt(0)),
    );
    expect(Object.keys(tx.signatures)).toEqual([create.payer, create.mint]);
    expect(Object.values(tx.signatures)).toEqual([null, null]);
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(message.version).toBe(0);
    if (message.version !== 0) throw new Error('Expected a versioned message.');
    expect(message.addressTableLookups).toHaveLength(1);
    const buy = result.instructions.at(-1)!;
    expect(buy.accounts).toHaveLength(17);
    expect(buy.accounts![8].address).toBe(create.payer);
    expect(buy.accounts![9].address).toBe(result.userBaseAccount);
    const data = new DataView(Uint8Array.from(buy.data!).buffer);
    expect(data.getBigUint64(8, true)).toBe(1000000000000n);
    expect(data.getBigUint64(16, true)).toBe(1000000000n);
    expect(data.getUint8(24)).toBe(0);
    expect(result.lookupTables[0].sha256).toBe(
      createHash('sha256').update(lookup.data).digest('hex'),
    );
  });
it('refuses an oversized packet instead of dropping its buy or changing terms', async () => {
  const create = await pumpCreateFixture();
  await expect(
    buildPumpCreateAndBuyMessage({
      transactionVersion: 0,
      create,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '1000000000',
    }),
  ).rejects.toThrow('address table or bundle');
});
it('rejects partial fills, invalid amounts, reserve exhaustion and recipient overrides', async () => {
  const create = await pumpCreateFixture(),
    base = {
      transactionVersion: 0 as const,
      create,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '1000000000',
    };
  for (const amount of ['0', '-1', '01', '1.5', '18446744073709551616'])
    await expect(
      buildPumpCreateAndBuyMessage({ ...base, tokenAmountRaw: amount }),
    ).rejects.toThrow('u64');
  await expect(
    buildPumpCreateAndBuyMessage({
      ...base,
      tokenAmountRaw: '793100000000000',
    }),
  ).rejects.toThrow('must leave tokens');
  await expect(
    buildPumpCreateAndBuyMessage({ ...base, buybackRecipientIndex: 8 }),
  ).rejects.toThrow('recipient configuration');
  await expect(
    buildPumpCreateAndBuyMessage({ ...base, partialFill: true } as typeof base),
  ).rejects.toThrow('Unsupported');
});
it('rejects wrong-owner, deactivated, truncated, future and inconsistent address-table observations', async () => {
  const create = await pumpCreateFixture(),
    lookup = await lookupFor(create),
    base = {
      transactionVersion: 0 as const,
      create,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '1000000000',
    };
  for (const changed of [
    { ...lookup, owner: create.payer },
    { ...lookup, executable: true },
    { ...lookup, data: lookup.data.slice(0, 57) },
    { ...lookup, slot: 140 },
  ])
    await expect(
      buildPumpCreateAndBuyMessage({ ...base, lookupTables: [changed] }),
    ).rejects.toThrow();
  const deactivated = structuredClone(lookup);
  new DataView(deactivated.data.buffer).setBigUint64(4, 10n, true);
  await expect(
    buildPumpCreateAndBuyMessage({ ...base, lookupTables: [deactivated] }),
  ).rejects.toThrow('not active');
  const future = structuredClone(lookup);
  new DataView(future.data.buffer).setBigUint64(12, 101n, true);
  await expect(
    buildPumpCreateAndBuyMessage({ ...base, lookupTables: [future] }),
  ).rejects.toThrow('not active');
  await expect(
    buildPumpCreateAndBuyMessage({ ...base, lookupTables: [lookup, lookup] }),
  ).rejects.toThrow('distinct');
});
for (const stock of [false, true])
  it(`builds an inline v1 atomic launch with explicit limits and tail signatures (${stock ? 'stock quote' : 'SOL'})`, async () => {
    const create = await pumpCreateFixture(stock);
    create.name = 'A'.repeat(32);
    create.symbol = 'X'.repeat(13);
    create.uri = `https://bundle-tek.vercel.app/api/launch/metadata/${'a'.repeat(64)}`;
    const built = await buildPumpCreateAndBuyMessage({
      create,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '1000000000',
    });
    expect(built.transactionVersion).toBe(1);
    expect(built.packetLimit).toBe(4096);
    expect(built.packetBytes).toBeLessThanOrEqual(4096);
    expect(built.lookupTables).toEqual([]);
    const instructionCount = stock ? 4 : 3;
    expect(built.instructions).toHaveLength(instructionCount);
    expect(built.instructions.map((i) => i.programAddress)).not.toContain(
      'ComputeBudget111111111111111111111111111111',
    );
    if (stock) {
      const setup = built.instructions[2];
      expect(setup.programAddress).toBe(
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      );
      expect(Array.from(setup.data!)).toEqual([1]);
      expect(setup.accounts![1].address).toBe(built.buybackAccount);
    }
    const bytes = Uint8Array.from(atob(built.transaction), (c) =>
        c.charCodeAt(0),
      ),
      view = new DataView(bytes.buffer);
    // Decode the documented wire header directly, independently of the builder's SDK.
    expect(bytes[0]).toBe(0x81);
    expect(bytes[1]).toBe(2);
    expect(view.getUint32(4, true)).toBe(15);
    expect(bytes[40]).toBe(instructionCount);
    const accounts = bytes[41],
      configOffset = 42 + accounts * 32;
    expect(accounts).toBeLessThanOrEqual(64);
    expect(Array.from(bytes.slice(42, 74))).toEqual(
      Array.from(getAddressEncoder().encode(address(create.payer))),
    );
    expect(Array.from(bytes.slice(74, 106))).toEqual(
      Array.from(getAddressEncoder().encode(address(create.mint))),
    );
    expect(view.getBigUint64(configOffset, true)).toBe(0n);
    expect(view.getUint32(configOffset + 8, true)).toBe(1400000);
    expect(view.getUint32(configOffset + 12, true)).toBe(64 * 1024 * 1024);
    const headers = configOffset + 16;
    let offset = headers + instructionCount * 4;
    for (let index = 0; index < instructionCount; index++) {
      const header = headers + index * 4,
        accountCount = bytes[header + 1],
        dataLength = view.getUint16(header + 2, true);
      const data = bytes.slice(
        offset + accountCount,
        offset + accountCount + dataLength,
      );
      expect(Array.from(data)).toEqual(
        Array.from(built.instructions[index].data!),
      );
      offset += accountCount + dataLength;
    }
    expect(offset).toBe(bytes.length - 128);
    expect(bytes.slice(offset).every((b) => b === 0)).toBe(true);
    // The existing Kit 7 decoder must also read the future signing envelope correctly.
    const decoded = getTransactionDecoder().decode(bytes);
    expect(Object.keys(decoded.signatures)).toEqual([
      create.payer,
      create.mint,
    ]);
    expect(Object.values(decoded.signatures)).toEqual([null, null]);
    expect(built.signingAllowed).toBe(false);
    expect(built.executionAllowed).toBe(false);
    await expect(
      buildPumpCreateAndBuyMessage({
        create,
        tokenAmountRaw: '1',
        maximumQuoteCostRaw: '1',
        lookupTables: [await lookupFor(create)],
      }),
    ).rejects.toThrow('cannot use');
  });
