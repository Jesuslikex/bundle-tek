import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { generateKeyPairSigner } from '@solana/kit';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import { simulatePumpOrganicBuy } from './pump-organic-buy-simulation';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

const SYSTEM = '11111111111111111111111111111111';
const lifetime = {
  blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  lastValidBlockHeight: 900n,
};
const tokenAccount = (mint: string, owner: string, amount: bigint) => {
  const b = new Uint8Array(165);
  b.set(bs58.decode(mint), 0);
  b.set(bs58.decode(owner), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = 1;
  return {
    owner: PUMP_TOKEN_2022,
    executable: false,
    lamports: '2074080',
    data: [Buffer.from(b).toString('base64'), 'base64'],
  };
};
const wallet = (lamports: bigint) => ({
  owner: SYSTEM,
  executable: false,
  lamports: lamports.toString(),
  data: ['', 'base64'],
});

async function setup() {
  const create = await pumpCreateFixture(false);
  const holder = (await generateKeyPairSigner()).address;
  const input = {
    create,
    holder,
    tokenAmountRaw: '1000000000',
    maximumQuoteCostRaw: '5000000',
    ...lifetime,
  };
  const packet = await buildPumpOrganicBuyMessage(input);
  return { input, packet };
}
type Shape = {
  received?: bigint;
  debit?: bigint;
  err?: unknown;
  slots?: number[];
};
const rpc = (
  packet: Awaited<ReturnType<typeof setup>>['packet'],
  shape: Shape = {},
) => {
  const slots = [...(shape.slots ?? [100, 101, 101])];
  const methods: string[] = [];
  const call = async (method: string) => {
    methods.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getFeeForMessage')
      return {
        context: { slot: String(slots.shift() ?? 101) },
        value: 5000 + '',
      };
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: String(slots.shift() ?? 101) },
        value: [wallet(1_000_000_000n), null],
      };
    if (method === 'simulateTransaction')
      return {
        context: { slot: String(slots.shift() ?? 101) },
        value: {
          err: shape.err ?? null,
          unitsConsumed: '90000',
          accounts: [
            wallet(1_000_000_000n - (shape.debit ?? 4_000_000n)),
            tokenAccount(
              packet.mint,
              packet.holder,
              shape.received ?? BigInt(packet.tokenAmountRaw),
            ),
          ],
        },
      };
    throw new Error('unexpected ' + method);
  };
  return Object.assign(call, { methods });
};

it('accepts an exact simulated output within the reviewed SOL cap', async () => {
  const { input, packet } = await setup();
  const provider = rpc(packet);
  const result = await simulatePumpOrganicBuy(
    input,
    { rentAllowanceRaw: '3000000' },
    provider,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    tokenOutputRaw: '1000000000',
    solDebitRaw: '4000000',
    networkFeeRaw: '5000',
    slot: 101,
    settlementValidated: false,
    signingAllowed: false,
  });
  expect(provider.methods).toEqual([
    'getGenesisHash',
    'getFeeForMessage',
    'getMultipleAccounts',
    'simulateTransaction',
  ]);
});

it('retries until the pre-state and simulation share a bank slot', async () => {
  const { input, packet } = await setup();
  const provider = rpc(packet, { slots: [100, 101, 102, 103, 103] });
  const result = await simulatePumpOrganicBuy(
    input,
    { rentAllowanceRaw: '3000000' },
    provider,
    new AbortController().signal,
  );
  expect(result.slot).toBe(103);
  expect(
    provider.methods.filter((m) => m === 'simulateTransaction'),
  ).toHaveLength(2);
});

it('refuses failed simulations, wrong output and debits above the cap', async () => {
  const { input, packet } = await setup();
  const run = (shape: Shape) =>
    simulatePumpOrganicBuy(
      input,
      { rentAllowanceRaw: '3000000' },
      rpc(packet, shape),
      new AbortController().signal,
    );
  await expect(
    run({ err: { InstructionError: [2, 'Custom'] } }),
  ).rejects.toThrow('failed against the live curve');
  await expect(run({ received: 999_999_999n })).rejects.toThrow('exact target');
  await expect(run({ debit: 8_005_001n })).rejects.toThrow('reviewed cap');
  await expect(
    simulatePumpOrganicBuy(
      input,
      { rentAllowanceRaw: '-1' },
      rpc(packet),
      new AbortController().signal,
    ),
  ).rejects.toThrow('rent allowance');
});
