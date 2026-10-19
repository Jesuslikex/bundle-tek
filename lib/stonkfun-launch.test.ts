import { describe, expect, it } from 'vitest';
import { AccountRole, getTransactionDecoder } from '@solana/kit';
import golden from '@/test/stonkfun-launchlab-sdk-golden.json';
import {
  buildStonkLaunchMessage,
  stonkAllowConfigId,
  stonkConfigId,
  stonkCurveRuleId,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_2022_PROGRAM,
  WRAPPED_SOL,
  TOKEN_PROGRAM,
  type StonkLaunchInput,
} from './stonkfun-launch';

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
// Golden vectors were generated with @raydium-io/raydium-sdk-v2@0.2.74-alpha
// initializeWithToken2022 / buyExactInInstruction for these exact inputs.
const base: StonkLaunchInput = {
  name: 'Stonk Test',
  symbol: 'STEST',
  uri: 'https://bundle-tek.vercel.app/api/launch/metadata/' + 'a'.repeat(64),
  payer: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  quoteMint: SPYX,
  quoteTokenProgram: TOKEN_2022_PROGRAM,
  platformId: STONKFUN_STANDARD_PLATFORM,
  configId: 'B7ctMMdGvy46Am56myTtzfkNzt9kWZVTNGM2BWrJ9adg',
  supply: '1000000000000000',
  totalSellA: '793100000000000',
  totalFundRaisingB: '1143648933',
  cpmmCreatorFeeOn: 0,
  allowConfig: true,
  curveRule: true,
  devBuyRaw: '50000000',
  minTokensOutRaw: '123456789',
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: '300000000',
};
const hex = (b: ArrayLike<number>) =>
  Buffer.from(Uint8Array.from(b)).toString('hex');
const keys = (accounts: readonly { address: string; role: AccountRole }[]) =>
  accounts.map((a) => [
    a.address,
    a.role === AccountRole.WRITABLE_SIGNER ||
      a.role === AccountRole.READONLY_SIGNER,
    a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.WRITABLE,
  ]);

describe('StonkFun LaunchLab packet', () => {
  it('derives the PDAs StonkFun publishes for SPYX', async () => {
    expect(await stonkConfigId(SPYX)).toBe(base.configId);
    expect(
      await stonkAllowConfigId(STONKFUN_STANDARD_PLATFORM, base.configId),
    ).toBe('A1Eom3WAZ9jFUSMhZo7UvAQLbGqenNtPxEbyekaEsQsL');
    expect(
      await stonkCurveRuleId(STONKFUN_STANDARD_PLATFORM, base.configId),
    ).toBe('QYZp1YzqEHU67ngXphF9LAkxkxWGvpWEv3rXh4yDbWA');
  });

  it('matches the official Raydium SDK create and buy encodings byte for byte', async () => {
    const built = await buildStonkLaunchMessage(base);
    const [, create, ata, buy] = built.instructions;
    expect(create.programAddress).toBe(golden.create.program);
    expect(hex(create.data!)).toBe(golden.create.data);
    expect(keys(create.accounts!)).toEqual(golden.create.keys);
    expect(ata.programAddress).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
    expect(hex(buy.data!)).toBe(golden.buy.data);
    expect(keys(buy.accounts!)).toEqual(golden.buy.keys);
    expect(built.containsCreatorBuy).toBe(true);
    const tx = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.transaction, 'base64')),
    );
    expect(Object.keys(tx.signatures)).toEqual([base.payer, base.mint]);
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
    expect(built.packetBytes).toBeLessThanOrEqual(1232);
  });

  it('builds a create-only packet without token accounts', async () => {
    const built = await buildStonkLaunchMessage({
      ...base,
      devBuyRaw: '0',
      minTokensOutRaw: '0',
    });
    expect(built.instructions).toHaveLength(2);
    expect(built.baseTokenAccount).toBeNull();
    expect(hex(built.instructions[1].data!)).toBe(golden.create.data);
  });

  it('wraps and closes SOL for a SOL-quoted creator buy', async () => {
    const built = await buildStonkLaunchMessage({
      ...base,
      quoteMint: WRAPPED_SOL,
      quoteTokenProgram: TOKEN_PROGRAM,
      configId: await stonkConfigId(WRAPPED_SOL),
    });
    const programs = built.instructions.map((i) => i.programAddress);
    expect(programs.at(-1)).toBe(TOKEN_PROGRAM);
    expect(built.instructions.at(-1)!.data).toEqual(Uint8Array.of(9));
    expect(programs).toContain('11111111111111111111111111111111');
  });

  it('refuses mismatched config, unsupported platform and oversized creator buys', async () => {
    await expect(
      buildStonkLaunchMessage({
        ...base,
        configId: 'EyVDL6knPspd6ZtZV7CGxaJMi4Qs5sAamGwyRTTYHVCw',
      }),
    ).rejects.toThrow(/config/);
    await expect(
      buildStonkLaunchMessage({
        ...base,
        platformId: '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt',
      }),
    ).rejects.toThrow(/standard/);
    await expect(
      buildStonkLaunchMessage({ ...base, minTokensOutRaw: '500000000000001' }),
    ).rejects.toThrow(/50%/);
    await expect(
      buildStonkLaunchMessage({ ...base, minTokensOutRaw: '0' }),
    ).rejects.toThrow(/minimum/);
    await expect(
      buildStonkLaunchMessage({ ...base, symbol: 'TOOLONGSYMB' }),
    ).rejects.toThrow(/byte limits/);
    await expect(
      buildStonkLaunchMessage({ ...base, mint: base.payer }),
    ).rejects.toThrow(/distinct/);
    await expect(
      buildStonkLaunchMessage({
        ...base,
        extra: 1,
      } as unknown as StonkLaunchInput),
    ).rejects.toThrow(/Unsupported/);
  });
});
