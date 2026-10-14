import { beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  generateKeyPairSigner,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  AccountRole,
  address,
  type Address,
} from '@solana/kit';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import {
  buildPumpCreateMessage,
  pumpCreateAddresses,
  type PumpCreateInput,
} from './pump-launch-message';
import {
  decodePumpLaunchConfig,
  inspectPumpQuoteMint,
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN,
  PUMP_TOKEN_2022,
  type PumpLaunchAccount,
} from './pump-launch-config';
import schema from './pump-launch-schema.json';
import { buildSavedPumpCreateComponent } from './pump-launch-preparation';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';

let payer: Address,
  mint: Address,
  globalAddress: string,
  controlAddress: string;
// Exact retained catalog identity; this fixture is not issuer/live admission proof.
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
    if (typeof value !== 'string') throw new Error('Invalid fixture address.');
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
  name: 'Global' | 'QuoteControl',
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
beforeAll(async () => {
  payer = (await generateKeyPairSigner()).address;
  mint = (await generateKeyPairSigner()).address;
  const accounts = await pumpCreateAddresses(mint);
  globalAddress = accounts.global;
  controlAddress = accounts.control;
});
it('pins the official discriminator and configuration layouts independently to Anchor names', () => {
  expect([
    ...createHash('sha256').update('global:create_v2').digest().subarray(0, 8),
  ]).toEqual(schema.instruction.discriminator);
  for (const name of ['Global', 'QuoteControl'])
    expect([
      ...createHash('sha256')
        .update('account:' + name)
        .digest()
        .subarray(0, 8),
    ]).toEqual(schema.accounts.find((a) => a.name === name)!.discriminator);
  expect(schema.instruction.accounts).toHaveLength(16);
});
it('builds a completely unsigned native create message with exactly payer and mint signers', async () => {
  const result = await buildPumpCreateMessage(input());
  expect(result).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    simulationRequired: true,
    containsInitialBuy: false,
    creator: payer,
    quote: {
      source: 'native',
      decimals: 9,
      initialVirtualQuoteReservesRaw: '30000000000',
    },
  });
  const packet = Buffer.from(result.transaction, 'base64'),
    tx = getTransactionDecoder().decode(packet);
  expect(Object.keys(tx.signatures)).toEqual([payer, mint]);
  expect(Object.values(tx.signatures)).toEqual([null, null]);
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 'legacy')
    throw new Error('Expected legacy create packet.');
  expect(message.header.numSignerAccounts).toBe(2);
  expect(message.staticAccounts.slice(0, 2)).toEqual([payer, mint]);
  expect(message.instructions).toHaveLength(2);
  expect(result.packetSha256).toBe(
    createHash('sha256').update(packet).digest('hex'),
  );
  expect(packet.length).toBeLessThanOrEqual(1232);
  expect(result.instruction.accounts).toHaveLength(16);
  expect(
    result.instruction
      .accounts!.filter((a) => a.role === AccountRole.WRITABLE_SIGNER)
      .map((a) => a.address),
  ).toEqual([mint, payer]);
});
it('encodes the exact Borsh strings, creator and 11-byte false/zero option tail', async () => {
  const data = Uint8Array.from(
    (await buildPumpCreateMessage(input())).instruction.data!,
  );
  let offset = 8;
  const view = new DataView(data.buffer),
    read = () => {
      const size = view.getUint32(offset, true);
      offset += 4;
      const s = new TextDecoder().decode(data.slice(offset, offset + size));
      offset += size;
      return s;
    };
  expect([read(), read(), read()]).toEqual(['Example', 'EX', input().uri]);
  expect(bs58.encode(data.slice(offset, offset + 32))).toBe(payer);
  offset += 32;
  expect(data.slice(offset)).toEqual(new Uint8Array(11));
});
it('keeps a globally listed quote mint, decimals, program and ATA in the actual instruction', async () => {
  const request = { ...input(), quoteMint, quoteMintAccount: quoteAccount() };
  const result = await buildPumpCreateMessage(request);
  expect(result.quote).toMatchObject({
    source: 'global',
    decimals: 8,
    tokenProgram: PUMP_TOKEN,
  });
  expect(result.instruction.accounts).toHaveLength(19);
  expect(result.instruction.accounts![16]).toMatchObject({
    address: quoteMint,
    role: AccountRole.READONLY,
  });
  expect(result.instruction.accounts![18].address).toBe(PUMP_TOKEN);
  expect(result.quoteMint).toBe(quoteMint);
});
it('requires quote-control admission for an unlisted stock mint and appends the real control PDA', async () => {
  const request = {
    ...input({ whitelisted_quote_mints: [] }),
    quoteMint,
    quoteMintAccount: quoteAccount(),
    quoteControl: {
      address: controlAddress,
      owner: PUMP_LAUNCH_PROGRAM,
      executable: false,
      slot: 100,
      data: config('QuoteControl', {
        mints: [
          { mint: quoteMint, initial_virtual_quote_reserves: 987654321n },
        ],
      }),
    },
  };
  const result = await buildPumpCreateMessage(request);
  expect(result.quote).toMatchObject({
    source: 'quote-control',
    initialVirtualQuoteReservesRaw: '987654321',
    decimals: 8,
  });
  expect(result.instruction.accounts).toHaveLength(20);
  expect(result.instruction.accounts!.at(-1)!.address).toBe(controlAddress);
  request.quoteControl.data = config('QuoteControl', {
    mints: [
      { mint: quoteMint, initial_virtual_quote_reserves: 1n },
      { mint: quoteMint, initial_virtual_quote_reserves: 2n },
    ],
  });
  await expect(buildPumpCreateMessage(request)).rejects.toThrow(/Duplicate/);
  request.quoteControl.data = config('QuoteControl', { mints: [] });
  await expect(buildPumpCreateMessage(request)).rejects.toThrow(/not listed/);
});
it('never silently turns an unsupported quote into a SOL launch', async () => {
  await expect(
    buildPumpCreateMessage({
      ...input({ whitelisted_quote_mints: [] }),
      quoteMint,
      quoteMintAccount: quoteAccount(),
    }),
  ).rejects.toThrow(/quote-control/);
  await expect(
    buildPumpCreateMessage({ ...input(), quoteMint }),
  ).rejects.toThrow(/exact selected/);
});
it('supports operable Token-2022 quote extensions while retaining issuer authority observations', async () => {
  const quote = quoteAccount(
    [
      { __kind: 'PermanentDelegate', delegate: payer },
      { __kind: 'DefaultAccountState', state: 1 },
      {
        __kind: 'TransferHook',
        authority: payer,
        programId: address('11111111111111111111111111111111'),
      },
      { __kind: 'PausableConfig', authority: null, paused: false },
    ],
    PUMP_TOKEN_2022,
  );
  const result = await buildPumpCreateMessage({
    ...input(),
    quoteMint,
    quoteMintAccount: quote,
  });
  expect(result.quote.extensions).toEqual([
    'PermanentDelegate',
    'DefaultAccountState',
    'TransferHook',
    'PausableConfig',
  ]);
  expect(result.instruction.accounts![18].address).toBe(PUMP_TOKEN_2022);
  expect(
    'extensionDetails' in result.quote && result.quote.extensionDetails[0],
  ).toMatchObject({ __kind: 'PermanentDelegate', delegate: payer });
});
it('rejects paused/frozen/active-hook/duplicate/unsupported quote extensions', () => {
  const cases: ExtensionArgs[][] = [
    [{ __kind: 'PausableConfig', authority: null, paused: true }],
    [{ __kind: 'DefaultAccountState', state: 2 }],
    [{ __kind: 'TransferHook', authority: payer, programId: payer }],
    [
      { __kind: 'PermanentDelegate', delegate: payer },
      { __kind: 'PermanentDelegate', delegate: payer },
    ],
    [{ __kind: 'NonTransferable' }],
  ];
  for (const extensions of cases)
    expect(() =>
      inspectPumpQuoteMint(quoteAccount(extensions, PUMP_TOKEN_2022)),
    ).toThrow(/extension/);
  expect(() =>
    inspectPumpQuoteMint({
      ...quoteAccount(),
      address: '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP',
    }),
  ).toThrow(/native SOL/);
});
it('rejects disabled creation, unknown global fields, malformed configuration and wrong program/PDA', async () => {
  await expect(
    buildPumpCreateMessage(input({ create_v2_enabled: false })),
  ).rejects.toThrow(/disabled/);
  for (const patch of [
    { owner: PUMP_TOKEN },
    { address: payer },
    { executable: true },
    { data: new Uint8Array(8) },
    { data: join([input().global.data, Uint8Array.of(1)]) },
  ])
    await expect(
      buildPumpCreateMessage({
        ...input(),
        global: { ...input().global, ...patch },
      }),
    ).rejects.toThrow(/Pump/);
});
it('rejects duplicate quote-control entries and truncated or oversized vectors', () => {
  const bytes = config('QuoteControl', { mints: [] });
  expect(() =>
    decodePumpLaunchConfig('QuoteControl', bytes.slice(0, -1)),
  ).toThrow(/Truncated/);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, 4097, true);
  expect(() => decodePumpLaunchConfig('QuoteControl', bytes)).toThrow(/bound/);
});
it('checks signer identities, fresh slot coherence, lifetime and UTF-8 metadata limits', async () => {
  for (const patch of [
    { mint: payer },
    { payer: globalAddress },
    { name: 'é'.repeat(17) },
    { symbol: 'a' },
    { uri: 'http://example.com/x' },
    { uri: 'https://u:p@example.com/x' },
    { uri: 'https://example.com/x#different' },
    { lastValidBlockHeight: 0n },
    { name: 'Test\u0000' },
  ])
    await expect(
      buildPumpCreateMessage({ ...input(), ...patch }),
    ).rejects.toThrow();
  await expect(
    buildPumpCreateMessage({
      ...input(),
      quoteMint,
      quoteMintAccount: { ...quoteAccount(), slot: 133 },
    }),
  ).rejects.toThrow(/slots/);
});

it('rejects unimplemented create options rather than silently dropping them', async () => {
  await expect(
    buildPumpCreateMessage({
      ...input(),
      holderRewards: true,
    } as PumpCreateInput),
  ).rejects.toThrow(/Unsupported Pump create option/);
  const f = savedFixture();
  const changed = structuredClone(f.doc);
  changed.options.settings.pumpfun.holderRewards = true;
  f.row.document = JSON.stringify(changed);
  await expect(
    buildSavedPumpCreateComponent(f.db, 'alice', f.terms),
  ).rejects.toThrow(/additional reviewed/);
});

function savedFixture() {
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  );
  const imageId = createHash('sha256').update(image).digest('hex');
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: 'Example',
      ticker: 'EX',
      description: 'Reviewed identity',
    },
    identity: { ...EMPTY_IDENTITY, artworkUrl: '/api/artwork/' + imageId },
    options: DEFAULT_VENUE_OPTIONS,
  });
  const terms = {
    projectId: 'p',
    updatedAt: '2026-10-14T00:00:00.000Z',
    releaseId: 'a'.repeat(64),
    origin: 'https://bundle.example',
    context: {
      payer,
      mint,
      blockhash: input().blockhash,
      lastValidBlockHeight: 1000n,
      global: input().global,
    },
  };
  const row = {
    document: JSON.stringify(doc),
    source_document: JSON.stringify(doc),
    updated_at: terms.updatedAt,
    archived: 0,
    image: Array.from(new Uint8Array(image)),
    mime: 'image/png',
    metadata: JSON.stringify({
      name: doc.plan.tokenName,
      symbol: doc.plan.ticker,
      description: doc.plan.description,
      image:
        terms.origin + '/api/launch/metadata/' + terms.releaseId + '/image',
    }),
  };
  const calls: unknown[][] = [];
  let reads = 0;
  const state = {
    row: row as typeof row | null,
    onRead: (_count: number) => {},
  };
  const db = {
    prepare: (sql: string) => {
      expect(sql).toContain('m.owner_id=p.owner_id');
      expect(sql).toContain('p.owner_id=?');
      return {
        bind: (...values: unknown[]) => {
          calls.push(values);
          return {
            first: async () => {
              state.onRead(++reads);
              return values[0] === 'alice' ? structuredClone(state.row) : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, terms, row, doc, calls, state };
}
it('binds a create component to owned released artwork/metadata and the saved quote identity', async () => {
  const f = savedFixture();
  const result = await buildSavedPumpCreateComponent(f.db, 'alice', f.terms);
  expect(result).toMatchObject({
    projectId: 'p',
    metadataReleaseId: f.terms.releaseId,
    metadataUri: f.terms.origin + '/api/launch/metadata/' + f.terms.releaseId,
    quoteMint: PUMP_NATIVE_QUOTE,
    completeLaunch: false,
    containsInitialBuy: false,
    requestedDeveloperBuy: 5,
  });
  expect(f.calls).toEqual([
    ['alice', 'p', f.terms.releaseId],
    ['alice', 'p', f.terms.releaseId],
  ]);
  await expect(
    buildSavedPumpCreateComponent(f.db, 'bob', f.terms),
  ).rejects.toThrow(/owned active/);
});
it('rejects changed public identity, forged artwork and launch-context overrides', async () => {
  const f = savedFixture();
  const changed = structuredClone(f.doc);
  changed.plan.tokenName = 'Different';
  f.row.document = JSON.stringify(changed);
  await expect(
    buildSavedPumpCreateComponent(f.db, 'alice', f.terms),
  ).rejects.toThrow(/exact saved identity/);
  f.row.document = JSON.stringify(f.doc);
  f.row.image[40] ^= 1;
  await expect(
    buildSavedPumpCreateComponent(f.db, 'alice', f.terms),
  ).rejects.toThrow(/artwork differs/);
  await expect(
    buildSavedPumpCreateComponent(f.db, 'alice', {
      ...f.terms,
      context: {
        ...f.terms.context,
        name: 'Override',
      } as unknown as typeof f.terms.context,
    }),
  ).rejects.toThrow(/cannot override/);
});
it('retains a released identity across funding-only edits but rejects preparation-time project drift', async () => {
  const f = savedFixture();
  const updated = structuredClone(f.doc);
  updated.plan.developerBuy = 2;
  f.row.document = JSON.stringify(updated);
  expect(
    (await buildSavedPumpCreateComponent(f.db, 'alice', f.terms))
      .requestedDeveloperBuy,
  ).toBe(2);
  const g = savedFixture();
  g.state.onRead = (n) => {
    if (n === 2) g.row.archived = 1;
  };
  await expect(
    buildSavedPumpCreateComponent(g.db, 'alice', g.terms),
  ).rejects.toThrow(/changed during preparation/);
});
