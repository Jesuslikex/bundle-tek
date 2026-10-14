import bs58 from 'bs58';
import {
  getExtensionDecoder,
  getExtensionEncoder,
  type Extension,
} from '@solana-program/token-2022';
import schema from './pump-launch-schema.json';

export const PUMP_LAUNCH_PROGRAM = schema.program;
export const PUMP_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PUMP_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const PUMP_NATIVE_QUOTE = 'So11111111111111111111111111111111111111112';
export type PumpLaunchAccount = {
  address: string;
  owner: string;
  executable: boolean;
  data: Uint8Array;
  slot: number;
};
type Type =
  | string
  | { array?: [Type, number]; vec?: Type; defined?: { name: string } };
type Struct = {
  name: string;
  type: { fields: Array<{ name: string; type: Type }> };
};
const types = schema.types as unknown as Struct[];

// Decode only the pinned IDL's bounded configuration types. Unknown nonzero tails fail.
export function decodePumpLaunchConfig(
  name: 'Global' | 'QuoteControl',
  bytes: Uint8Array,
) {
  const discriminator = schema.accounts.find(
    (a) => a.name === name,
  )!.discriminator;
  if (
    bytes.length < 8 ||
    bytes.length > 200000 ||
    discriminator.some((v, i) => bytes[i] !== v)
  )
    throw new Error('Pump launch configuration discriminator differs.');
  let offset = 8;
  const take = (size: number) => {
    if (offset + size > bytes.length)
      throw new Error('Truncated Pump launch configuration.');
    const value = bytes.slice(offset, offset + size);
    offset += size;
    return value;
  };
  function read(type: Type, depth = 0): unknown {
    if (depth > 8)
      throw new Error('Pump launch configuration nesting differs.');
    if (type === 'pubkey') return bs58.encode(take(32));
    if (type === 'u64') {
      const b = take(8);
      return new DataView(b.buffer).getBigUint64(0, true);
    }
    if (type === 'u8' || type === 'bool') {
      const n = take(1)[0];
      if (type === 'bool' && n > 1)
        throw new Error('Invalid Pump launch boolean.');
      return type === 'bool' ? n === 1 : n;
    }
    if (typeof type === 'object' && type.defined) {
      const definition = types.find((t) => t.name === type.defined!.name);
      if (!definition) throw new Error('Unknown Pump launch type.');
      return Object.fromEntries(
        definition.type.fields.map((f) => [f.name, read(f.type, depth + 1)]),
      );
    }
    if (typeof type === 'object' && (type.array || type.vec)) {
      const n = type.array
        ? type.array[1]
        : new DataView(take(4).buffer).getUint32(0, true);
      if (n > 4096)
        throw new Error(
          'Pump quote-control coverage exceeds the supported bound.',
        );
      return Array.from({ length: n }, () =>
        read(type.array ? type.array[0] : type.vec!, depth + 1),
      );
    }
    throw new Error('Unsupported Pump launch configuration type.');
  }
  const result = read({ defined: { name } }) as Record<string, unknown>;
  if (bytes.slice(offset).some((v) => v !== 0))
    throw new Error('Pump launch configuration contains unknown fields.');
  return result;
}

export function inspectPumpQuoteMint(account: PumpLaunchAccount) {
  const { data, owner } = account;
  if (account.address === '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP')
    throw new Error('Token-2022 native SOL is not an admitted Pump quote.');
  if (
    account.executable ||
    ![PUMP_TOKEN, PUMP_TOKEN_2022].includes(owner) ||
    data.length < 82
  )
    throw new Error('Pump quote mint account differs.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    ![0, 1].includes(view.getUint32(0, true)) ||
    ![0, 1].includes(view.getUint32(46, true)) ||
    data[45] !== 1 ||
    data[44] > 19
  )
    throw new Error('Pump quote mint state or precision differs.');
  const extensions: Extension[] = [];
  if (data.length !== 82) {
    if (
      owner !== PUMP_TOKEN_2022 ||
      data.length < 166 ||
      data.length > 16384 ||
      data[165] !== 1 ||
      data.slice(82, 165).some((v) => v !== 0)
    )
      throw new Error('Pump quote mint extension layout differs.');
    const allowed = [
      'MetadataPointer',
      'TokenMetadata',
      'PermanentDelegate',
      'DefaultAccountState',
      'ScaledUiAmountConfig',
      'PausableConfig',
      'ConfidentialTransferMint',
      'TransferHook',
    ];
    for (let offset = 166; offset < data.length;) {
      if (data.slice(offset).every((v) => v === 0)) break;
      if (offset + 4 > data.length)
        throw new Error('Truncated Pump quote extension.');
      const end = offset + 4 + view.getUint16(offset + 2, true);
      if (end > data.length) throw new Error('Truncated Pump quote extension.');
      const encoded = data.slice(offset, end),
        extension = getExtensionDecoder().decode(encoded);
      if (
        !allowed.includes(extension.__kind) ||
        extensions.some((e) => e.__kind === extension.__kind)
      )
        throw new Error(
          'Pump quote extension is not supported by this create path.',
        );
      const canonical = getExtensionEncoder().encode(extension);
      if (
        canonical.length !== encoded.length ||
        canonical.some((v, i) => v !== encoded[i])
      )
        throw new Error('Noncanonical Pump quote extension.');
      if (
        (extension.__kind === 'DefaultAccountState' && extension.state !== 1) ||
        (extension.__kind === 'PausableConfig' && extension.paused) ||
        (extension.__kind === 'TransferHook' &&
          extension.programId !== '11111111111111111111111111111111') ||
        (extension.__kind === 'TokenMetadata' &&
          extension.mint !== account.address) ||
        (extension.__kind === 'ScaledUiAmountConfig' &&
          ![extension.multiplier, extension.newMultiplier].every(
            (n) => Number.isFinite(n) && n > 0,
          ))
      )
        throw new Error('Pump quote extension state prevents this launch.');
      extensions.push(extension);
      offset = end;
    }
  }
  return {
    tokenProgram: owner,
    decimals: data[44],
    supplyRaw: view.getBigUint64(36, true).toString(),
    mintAuthority: view.getUint32(0, true)
      ? bs58.encode(data.slice(4, 36))
      : null,
    freezeAuthority: view.getUint32(46, true)
      ? bs58.encode(data.slice(50, 82))
      : null,
    extensions: extensions.map((e) => e.__kind),
    extensionDetails: extensions,
  };
}

export function pumpListedQuote(input: {
  global: PumpLaunchAccount;
  quoteMint: string;
  mint?: PumpLaunchAccount;
  control?: PumpLaunchAccount;
  globalAddress: string;
  controlAddress: string;
}) {
  const { global, quoteMint, mint, control } = input;
  if (
    global.address !== input.globalAddress ||
    global.owner !== PUMP_LAUNCH_PROGRAM ||
    global.executable
  )
    throw new Error('Pump global account differs.');
  const g = decodePumpLaunchConfig('Global', global.data);
  if (
    g.create_v2_enabled !== true ||
    typeof g.token_total_supply !== 'bigint' ||
    g.token_total_supply <= 0n ||
    typeof g.initial_virtual_token_reserves !== 'bigint' ||
    g.initial_virtual_token_reserves <= 0n ||
    typeof g.initial_real_token_reserves !== 'bigint' ||
    g.initial_real_token_reserves <= 0n ||
    g.initial_real_token_reserves > g.initial_virtual_token_reserves ||
    g.initial_real_token_reserves > g.token_total_supply
  )
    throw new Error(
      'Pump create is disabled or its reserve configuration differs.',
    );
  const common = {
    createdTokenDecimals: 6 as const,
    tokenSupplyRaw: g.token_total_supply.toString(),
    initialVirtualTokenReservesRaw: g.initial_virtual_token_reserves.toString(),
  };
  if (quoteMint === PUMP_NATIVE_QUOTE) {
    if (
      typeof g.initial_virtual_sol_reserves !== 'bigint' ||
      g.initial_virtual_sol_reserves <= 0n
    )
      throw new Error('Pump native quote reserves unavailable.');
    return {
      ...common,
      source: 'native' as const,
      decimals: 9,
      tokenProgram: PUMP_TOKEN,
      initialVirtualQuoteReservesRaw: g.initial_virtual_sol_reserves.toString(),
      extensions: [] as string[],
    };
  }
  if (!mint || mint.address !== quoteMint)
    throw new Error('Read the exact selected quote mint.');
  const details = inspectPumpQuoteMint(mint);
  if ((g.whitelisted_quote_mints as string[]).includes(quoteMint)) {
    if (
      typeof g.initial_virtual_quote_reserves !== 'bigint' ||
      g.initial_virtual_quote_reserves <= 0n
    )
      throw new Error('Pump listed quote reserves unavailable.');
    return {
      ...common,
      ...details,
      source: 'global' as const,
      initialVirtualQuoteReservesRaw:
        g.initial_virtual_quote_reserves.toString(),
    };
  }
  if (
    !control ||
    control.address !== input.controlAddress ||
    control.owner !== PUMP_LAUNCH_PROGRAM ||
    control.executable
  )
    throw new Error('Read Pump quote-control to establish quote admission.');
  const c = decodePumpLaunchConfig('QuoteControl', control.data);
  const entries = c.mints as Array<{
    mint: string;
    initial_virtual_quote_reserves: bigint;
  }>;
  if (new Set(entries.map((e) => e.mint)).size !== entries.length)
    throw new Error('Duplicate Pump quote-control mint.');
  const entry = entries.find((e) => e.mint === quoteMint);
  if (!entry || entry.initial_virtual_quote_reserves <= 0n)
    throw new Error(
      'Selected quote is not listed. Nested Pump-coin quotes need a separate chain resolver.',
    );
  return {
    ...common,
    ...details,
    source: 'quote-control' as const,
    initialVirtualQuoteReservesRaw:
      entry.initial_virtual_quote_reserves.toString(),
  };
}
