import bs58 from 'bs58';
import { generateKeyPairSigner } from '@solana/kit';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import schema from '../lib/pump-launch-schema.json';
import {
  pumpCreateAddresses,
  type PumpCreateInput,
} from '../lib/pump-launch-message';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN,
  type PumpLaunchAccount,
} from '../lib/pump-launch-config';
export async function pumpLaunchFixture() {
  const payerSigner = await generateKeyPairSigner(),
    mintSigner = await generateKeyPairSigner();
  const payer = payerSigner.address,
    mint = mintSigner.address;
  const pdas = await pumpCreateAddresses(mint),
    globalAddress = pdas.global,
    controlAddress = pdas.control;
  const quoteMint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  type FieldType =
    | string
    | {
        array?: [FieldType, number];
        vec?: FieldType;
        defined?: { name: string };
      };
  type Definition = {
    name: string;
    type: { fields: Array<{ name: string; type: FieldType }> };
  };
  function encode(type: FieldType, value: unknown): Uint8Array {
    if (type === 'pubkey') {
      if (value === undefined) return new Uint8Array(32);
      if (typeof value !== 'string')
        throw new Error('Invalid fixture address.');
      return bs58.decode(value);
    }
    if (type === 'bool' || type === 'u8')
      return Uint8Array.of(Number(value || 0));
    if (type === 'u64') {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(
        0,
        BigInt((value as number) || 0),
        true,
      );
      return bytes;
    }
    if (typeof type === 'object' && type.defined) {
      const fields = (schema.types as unknown as Definition[]).find(
        (t) => t.name === type.defined!.name,
      )!.type.fields;
      return join(
        fields.map((f) =>
          encode(f.type, (value as Record<string, unknown>)?.[f.name]),
        ),
      );
    }
    if (typeof type === 'object' && type.array)
      return join(
        Array.from({ length: type.array[1] }, (_, i) =>
          encode(type.array![0], (value as unknown[])?.[i]),
        ),
      );
    if (typeof type === 'object' && type.vec) {
      const values = (value || []) as unknown[],
        length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, values.length, true);
      return join([length, ...values.map((v) => encode(type.vec!, v))]);
    }
    throw new Error('Unsupported fixture field');
  }
  function join(parts: Uint8Array[]) {
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    return bytes;
  }
  function config(
    name: 'Global' | 'QuoteControl' | 'BondingCurve',
    fields: Record<string, unknown>,
  ) {
    return join([
      Uint8Array.from(
        schema.accounts.find((a) => a.name === name)!.discriminator,
      ),
      encode({ defined: { name } }, fields),
    ]);
  }
  function quoteAccount(
    extensions?: ExtensionArgs[],
    owner = PUMP_TOKEN,
  ): PumpLaunchAccount {
    const bytes = new Uint8Array(82);
    bytes[44] = 8;
    bytes[45] = 1;
    new DataView(bytes.buffer).setBigUint64(36, 10000000000000000n, true);
    let data = bytes;
    if (extensions) {
      const header = new Uint8Array(166);
      header.set(bytes);
      header[165] = 1;
      data = join([
        header,
        ...extensions.map((e) =>
          Uint8Array.from(getExtensionEncoder().encode(e)),
        ),
      ]);
    }
    return { address: quoteMint, owner, executable: false, data, slot: 100 };
  }
  function input(overrides: Record<string, unknown> = {}): PumpCreateInput {
    return {
      name: 'Example',
      symbol: 'EX',
      uri: 'https://bundle.example/api/launch/metadata/' + 'a'.repeat(64),
      payer,
      mint,
      quoteMint: PUMP_NATIVE_QUOTE,
      blockhash: bs58.encode(new Uint8Array(32).fill(7)),
      lastValidBlockHeight: 1000n,
      global: {
        address: globalAddress,
        owner: PUMP_LAUNCH_PROGRAM,
        executable: false,
        slot: 100,
        data: config('Global', {
          create_v2_enabled: true,
          token_total_supply: 1000000000000000n,
          initial_virtual_token_reserves: 1073000000000000n,
          initial_real_token_reserves: 793100000000000n,
          initial_virtual_sol_reserves: 30000000000n,
          initial_virtual_quote_reserves: 100000000n,
          whitelisted_quote_mints: [quoteMint],
          ...overrides,
        }),
      },
    };
  }

  return {
    payerSigner,
    mintSigner,
    payer,
    mint,
    pdas,
    globalAddress,
    controlAddress,
    quoteMint,
    input,
    quoteAccount,
    config,
    join,
  };
}
