import { describe, expect, it } from 'vitest';
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import golden from '@/test/meteora-dbc-sdk-golden.json';
import {
  DBC_CONFIG_SIZE,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM,
  USDC,
  WRAPPED_SOL,
  buildMeteoraDbcMessage,
  parseDbcConfig,
  type MeteoraDbcInput,
} from './meteora-dbc-launch';

// Golden vectors were generated with @meteora-ag/dynamic-bonding-curve-sdk@2.0.0
// creator.createPoolWithFirstBuy for these exact inputs (mocked RPC: SPL quote
// mint, missing token accounts, standard PoolConfig).
type Ix = { program: string; data: string; keys: [string, boolean, boolean][] };
const g = golden as unknown as Record<string, Ix[]> & {
  config: string;
  payer: string;
  mint: string;
};
const input = (over: Partial<MeteoraDbcInput> = {}): MeteoraDbcInput => ({
  name: 'Meteora Test',
  symbol: 'MTEST',
  uri: 'https://bundle-tek.vercel.app/api/launch/metadata/' + 'a'.repeat(64),
  payer: g.payer,
  mint: g.mint,
  config: g.config,
  quoteMint: WRAPPED_SOL,
  baseTokenType: 0,
  firstSwapWithMinFee: false,
  devBuyRaw: '50000000',
  minTokensOutRaw: '123456789',
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: '300000000',
  ...over,
});
const hex = (b: ArrayLike<number>) =>
  Buffer.from(Uint8Array.from(b)).toString('hex');
const keys = (accounts: readonly { address: string; role: AccountRole }[]) =>
  accounts.map((a) => [
    a.address,
    a.role === AccountRole.WRITABLE_SIGNER ||
      a.role === AccountRole.READONLY_SIGNER,
    a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.WRITABLE,
  ]);
async function expectGolden(over: Partial<MeteoraDbcInput>, vector: Ix[]) {
  const built = await buildMeteoraDbcMessage(input(over));
  expect(
    built.instructions.map((ix) => ({
      program: ix.programAddress,
      data: hex(ix.data!),
      keys: keys(ix.accounts ?? []),
    })),
  ).toEqual(vector);
  expect(built.packetBytes).toBeLessThanOrEqual(1232);
  return built;
}

describe('Meteora DBC packets', () => {
  it('matches the SDK for a classic SPL token with a SOL creator buy', async () => {
    const built = await expectGolden({}, g.splSolBuy);
    expect(built.containsCreatorBuy).toBe(true);
    expect(built.baseTokenAccount).toBe(g.splSolBuy[2].keys[1][0]);
  });
  it('matches the SDK for a USDC creator buy', () =>
    expectGolden({ quoteMint: USDC }, g.splUsdcBuy));
  it('matches the SDK for Token-2022 with the minimum-fee first swap', () =>
    expectGolden(
      { baseTokenType: 1, firstSwapWithMinFee: true },
      g.t22SolBuyMinFee,
    ));
  it('matches the SDK for create only', async () => {
    const built = await expectGolden(
      { devBuyRaw: '0', minTokensOutRaw: '0' },
      g.splSolCreate,
    );
    expect(built.baseTokenAccount).toBeNull();
  });

  it('derives the fixed program authorities', async () => {
    const pda = async (seed: string) =>
      (
        await getProgramDerivedAddress({
          programAddress: address(DBC_PROGRAM),
          seeds: [new TextEncoder().encode(seed)],
        })
      )[0];
    expect(await pda('pool_authority')).toBe(DBC_POOL_AUTHORITY);
    expect(await pda('__event_authority')).toBe(DBC_EVENT_AUTHORITY);
  });

  it('refuses unsupported quotes, identities, amounts and extra options', async () => {
    await expect(
      buildMeteoraDbcMessage(
        input({ quoteMint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB' }),
      ),
    ).rejects.toThrow(/SOL or USDC/);
    await expect(
      buildMeteoraDbcMessage(input({ mint: g.payer })),
    ).rejects.toThrow(/distinct/);
    await expect(
      buildMeteoraDbcMessage(input({ minTokensOutRaw: '0' })),
    ).rejects.toThrow(/minimum/);
    await expect(
      buildMeteoraDbcMessage(input({ devBuyRaw: '0' })),
    ).rejects.toThrow(/create-only/);
    await expect(
      buildMeteoraDbcMessage(input({ uri: 'http://x.test/a' })),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      buildMeteoraDbcMessage(input({ name: 'x'.repeat(33) })),
    ).rejects.toThrow(/byte limits/);
    await expect(
      buildMeteoraDbcMessage(input({ baseTokenType: 2 })),
    ).rejects.toThrow(/standard/);
    await expect(
      buildMeteoraDbcMessage({ ...input(), extra: 1 } as never),
    ).rejects.toThrow(/Unsupported/);
  });
});

describe('Meteora DBC config decoding', () => {
  const encoder = getAddressEncoder();
  const config = (edit: (b: Uint8Array, v: DataView) => void = () => {}) => {
    const b = new Uint8Array(DBC_CONFIG_SIZE),
      v = new DataView(b.buffer);
    b.set([26, 108, 14, 123, 116, 230, 129, 43], 0);
    b.set(encoder.encode(address(WRAPPED_SOL)), 8);
    b.set(encoder.encode(address(g.payer)), 40);
    v.setBigUint64(104, 25_000_000n, true);
    b[233] = 1;
    b[235] = 6;
    b[236] = 1;
    v.setBigUint64(264, 85_000_000_000n, true);
    b[365] = 1;
    v.setBigUint64(368, 1_000_000n, true);
    edit(b, v);
    return b;
  };
  it('reads the IDL offsets', () => {
    expect(parseDbcConfig(config())).toMatchObject({
      quoteMint: WRAPPED_SOL,
      feeClaimer: g.payer,
      tokenType: 0,
      tokenDecimal: 6,
      migrationOption: 1,
      migrationQuoteThreshold: 85_000_000_000n,
      enableFirstSwapWithMinFee: true,
      poolCreationFee: 1_000_000n,
    });
  });
  it('refuses configs the SDK refuses for new pools', () => {
    expect(() => parseDbcConfig(config((b) => (b[0] = 0)))).toThrow(/standard/);
    expect(() => parseDbcConfig(config().slice(0, 1000))).toThrow(/standard/);
    expect(() => parseDbcConfig(config((b) => (b[130] = 2)))).toThrow(
      /rate-limiter/,
    );
    expect(() => parseDbcConfig(config((b) => (b[233] = 0)))).toThrow(
      /DAMM v1/,
    );
    expect(() => parseDbcConfig(config((b) => (b[246] = 3)))).toThrow(
      /mint authority/,
    );
  });
});
