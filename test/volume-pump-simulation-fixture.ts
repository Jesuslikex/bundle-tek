import bs58 from 'bs58';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import schema from '../lib/pump-native-route-schema.json';
import state from '../lib/pump-launch-schema.json';
import { volumeConstructionInput, key } from './volume-bundle-fixture';
import {
  constructVolumeBundle,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
} from '../lib/volume-bundle-construction';
import {
  volumePumpAccounts,
  validateVolumePumpRoute,
  VOLUME_PUMP,
  VOLUME_PUMP_FEE,
} from '../lib/volume-bundle-route';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import type {
  VolumeSimulationRpc,
  VolumeSimulationAccount,
} from '../lib/volume-bundle-simulation';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';
export const pumpNow = Date.parse('2026-10-18T08:00:00.000Z');
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function config(
  name: 'Global' | 'BondingCurve',
  values: Record<string, unknown>,
) {
  const definition = state.types.find((t) => t.name === name)!;
  const out: number[] = [
    ...state.accounts.find((a) => a.name === name)!.discriminator,
  ];
  const write = (type: unknown, value: unknown) => {
    if (type === 'pubkey')
      out.push(...bs58.decode(typeof value === 'string' ? value : key(91)));
    else if (type === 'bool' || type === 'u8') out.push(Number(value ?? 0));
    else if (type === 'u64') {
      const b = new Uint8Array(8);
      if (
        value !== undefined &&
        typeof value !== 'number' &&
        typeof value !== 'string' &&
        typeof value !== 'bigint'
      )
        throw new Error('Synthetic integer required');
      new DataView(b.buffer).setBigUint64(0, BigInt(value ?? 0), true);
      out.push(...b);
    } else {
      const [inner, n] = (type as { array: [unknown, number] }).array;
      for (let i = 0; i < n; i++)
        write(inner, (value as unknown[] | undefined)?.[i]);
    }
  };
  for (const f of definition.type.fields) write(f.type, values[f.name]);
  return encode(Uint8Array.from(out));
}
export async function volumePumpFixture() {
  const input = volumeConstructionInput(),
    identities = { creator: key(20), feeRecipient: key(21) };
  const roles = await volumePumpAccounts(
    input.mint,
    input.plan.rounds[0].wallet,
    identities,
  );
  input.tokenAccount = roles.associated_user;
  const writable = new Set([
    'fee_recipient',
    'bonding_curve',
    'associated_bonding_curve',
    'associated_user',
    'creator_vault',
    'global_volume_accumulator',
    'user_volume_accumulator',
  ]);
  const ix = (kind: 'buy' | 'sell') => {
    const variant = schema.instructions.find((i) => i.name === kind)!,
      b = new Uint8Array(kind === 'buy' ? 26 : 24),
      v = new DataView(b.buffer);
    b.set(variant.discriminator.match(/../g)!.map((h) => parseInt(h, 16)));
    v.setBigUint64(8, BigInt(input.tokenAmountRaw), true);
    v.setBigUint64(
      16,
      BigInt(
        kind === 'buy'
          ? input.plan.rounds[0].buyLamports
          : input.minimumSellLamports,
      ),
      true,
    );
    return {
      programAddress: VOLUME_PUMP,
      accounts: variant.accounts.map((name) => ({
        address: roles[name],
        role: (name === 'user' ? 3 : writable.has(name) ? 1 : 0) as 0 | 1 | 3,
      })),
      dataBase64: encode(b),
    };
  };
  input.buy = [ix('buy')];
  input.sell = [ix('sell')];
  const review = await constructVolumeBundle(input),
    route = await validateVolumePumpRoute(review, identities);
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
    ).messageBytes,
  );
  const keys = message.staticAccounts.map(String),
    addresses = [...keys, PAIR_RENT, CLOCK],
    index = (key: string) => addresses.indexOf(key);
  const system = (): VolumeSimulationAccount => ({
    owner: VOLUME_SYSTEM,
    executable: false,
    lamports: '1000000000',
    data: ['', 'base64'],
  });
  const before = addresses.map(system);
  const get = (key: string) => before[index(key)];
  const token = (owner: string, amount: bigint) => {
    const b = new Uint8Array(165);
    b.set(bs58.decode(input.mint));
    b.set(bs58.decode(owner), 32);
    new DataView(b.buffer).setBigUint64(64, amount, true);
    b[108] = 1;
    return {
      owner: VOLUME_TOKEN,
      executable: false,
      lamports: '2039280',
      data: [encode(b), 'base64'] as [string, 'base64'],
    };
  };
  before[index(input.tokenAccount)] = token(review.wallet, 0n);
  before[index(roles.associated_bonding_curve)] = token(
    roles.bonding_curve,
    1000000n,
  );
  const mb = new Uint8Array(82);
  new DataView(mb.buffer).setBigUint64(36, 2000000n, true);
  mb[44] = 6;
  mb[45] = 1;
  Object.assign(get(input.mint), {
    owner: VOLUME_TOKEN,
    data: [encode(mb), 'base64'],
  });
  for (const [name, values] of [
    ['Global', { initialized: true, fee_recipient: identities.feeRecipient }],
    [
      'BondingCurve',
      {
        creator: identities.creator,
        quote_mint: VOLUME_SYSTEM,
        real_token_reserves: 1000000,
        token_total_supply: 2000000,
        virtual_token_reserves: 2000000,
        virtual_quote_reserves: 1000000000,
        real_quote_reserves: 1000000000,
      },
    ],
  ] as const) {
    Object.assign(get(name === 'Global' ? roles.global : roles.bonding_curve), {
      owner: VOLUME_PUMP,
      data: [config(name, values), 'base64'],
    });
  }
  for (const name of ['global_volume_accumulator', 'user_volume_accumulator'])
    get(roles[name]).owner = VOLUME_PUMP;
  get(roles.fee_config).owner = VOLUME_PUMP_FEE;
  for (const program of [
    VOLUME_PUMP,
    VOLUME_PUMP_FEE,
    VOLUME_TOKEN,
    VOLUME_SYSTEM,
  ])
    Object.assign(get(program), {
      owner: 'BPFLoader2111111111111111111111111111111111',
      executable: true,
    });
  const clock = (slot: number) => {
    const b = new Uint8Array(40),
      v = new DataView(b.buffer);
    v.setBigUint64(0, BigInt(slot), true);
    v.setBigInt64(32, BigInt(pumpNow / 1000), true);
    return {
      owner: SYSVAR,
      executable: false,
      lamports: '1',
      data: [encode(b), 'base64'] as [string, 'base64'],
    };
  };
  before[index(CLOCK)] = clock(1000);
  const rent = new Uint8Array(17),
    rentView = new DataView(rent.buffer);
  rentView.setBigUint64(0, 3480n, true);
  rentView.setFloat64(8, 2, true);
  rent[16] = 50;
  before[index(PAIR_RENT)] = {
    owner: SYSVAR,
    executable: false,
    lamports: '1',
    data: [encode(rent), 'base64'],
  };
  const after = structuredClone(before);
  after[0].lamports = '999893000';
  after[index(input.tipRecipient)].lamports = '1000002000';
  after[index(roles.bonding_curve)].lamports = '1000100000';
  after[index(CLOCK)] = clock(1001);
  const native = () => {
    const b = new Uint8Array(12),
      v = new DataView(b.buffer);
    v.setUint32(0, 2, true);
    v.setBigUint64(4, 50000000n, true);
    return {
      programIdIndex: index(VOLUME_SYSTEM),
      accounts: [0, index(roles.bonding_curve)],
      data: bs58.encode(b),
    };
  };
  const transfer = (sell: boolean) => {
    const b = new Uint8Array(10),
      v = new DataView(b.buffer);
    b[0] = 12;
    v.setBigUint64(1, BigInt(input.tokenAmountRaw), true);
    b[9] = 6;
    return {
      programIdIndex: index(VOLUME_TOKEN),
      accounts: [
        index(sell ? input.tokenAccount : roles.associated_bonding_curve),
        index(input.mint),
        index(sell ? roles.associated_bonding_curve : input.tokenAccount),
        index(sell ? review.wallet : roles.bonding_curve),
      ],
      data: bs58.encode(b),
    };
  };
  const simulation = {
    context: { slot: 1001 },
    value: {
      err: null,
      accounts: after,
      unitsConsumed: 150000,
      replacementBlockhash: null,
      innerInstructions: [
        { index: 0, instructions: [native(), transfer(false)] },
        { index: 1, instructions: [transfer(true)] },
      ],
    },
  };
  const calls: { method: string; params: unknown[]; signal: AbortSignal }[] =
    [];
  let snapshots = 0;
  const rpc: VolumeSimulationRpc = async (method, params, signal) => {
    calls.push({ method, params: structuredClone(params), signal });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getMultipleAccounts') {
      const slot = ++snapshots === 1 ? 1000 : 1002;
      const value = structuredClone(before);
      value[index(CLOCK)] = clock(slot);
      return { context: { slot }, value };
    }
    if (method === 'getFeeForMessage')
      return { context: { slot: 1000 }, value: 5000 };
    if (method === 'isBlockhashValid')
      return { context: { slot: snapshots === 1 ? 1000 : 1002 }, value: true };
    if (method === 'getBlockHeight') return 400;
    if (method === 'simulateTransaction') return structuredClone(simulation);
    throw new Error('Fixture refuses unlisted methods');
  };
  return {
    input,
    review,
    route,
    roles,
    before,
    after,
    simulation,
    rpc,
    calls,
    index,
    addresses,
  };
}
