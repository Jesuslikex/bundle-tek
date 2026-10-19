import { describe, expect, it } from 'vitest';
import { AccountRole, getTransactionDecoder } from '@solana/kit';
import golden from '@/test/launchlab-platform-sdk-golden.json';
import {
  LAUNCHLAB_CURVES,
  LAUNCHLAB_PLATFORMS,
  USD1,
  buildLaunchLabMessage,
  type LaunchLabInput,
  type LaunchLabVenue,
} from './launchlab-platform-launch';
import { WRAPPED_SOL } from './stonkfun-launch';

// Golden vectors were generated with @raydium-io/raydium-sdk-v2@0.2.74-alpha
// initializeV2 / buyExactInInstruction for these exact inputs.
const input = (
  venue: LaunchLabVenue,
  quoteMint: string,
  over: Partial<LaunchLabInput> = {},
): LaunchLabInput => ({
  venue,
  name: 'Bonk Test',
  symbol: 'BTEST',
  uri: 'https://bundle-tek.vercel.app/api/launch/metadata/' + 'a'.repeat(64),
  payer: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  quoteMint,
  platformId: LAUNCHLAB_PLATFORMS[venue],
  configId: LAUNCHLAB_CURVES[quoteMint].configId,
  supply: LAUNCHLAB_CURVES[quoteMint].supply,
  totalSellA: LAUNCHLAB_CURVES[quoteMint].totalSellA,
  totalFundRaisingB: LAUNCHLAB_CURVES[quoteMint].totalFundRaisingB,
  allowConfig: true,
  curveRule: true,
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
const vectors = golden as Record<
  string,
  {
    configId: string;
    create: { program: string; data: string; keys: unknown[] };
    buy: { program: string; data: string; keys: unknown[] };
  }
>;

describe('LaunchLab platform packets', () => {
  for (const venue of ['LetsBonk', 'Surge'] as const)
    for (const quote of [WRAPPED_SOL, USD1])
      it(`matches the Raydium SDK for ${venue} with ${quote.slice(0, 4)}`, async () => {
        const v = vectors[`${venue}/${quote}`];
        const built = await buildLaunchLabMessage(input(venue, quote));
        expect(built.configId).toBe(v.configId);
        const [create, buy] = built.instructions.filter(
          (i) => i.programAddress === v.create.program,
        );
        expect(create.programAddress).toBe(v.create.program);
        expect(hex(create.data!)).toBe(v.create.data);
        expect(keys(create.accounts!)).toEqual(v.create.keys);
        expect(hex(buy.data!)).toBe(v.buy.data);
        expect(keys(buy.accounts!)).toEqual(v.buy.keys);
        const tx = getTransactionDecoder().decode(
          Buffer.from(built.transaction, 'base64'),
        );
        expect(Object.keys(tx.signatures)).toEqual([
          input(venue, quote).payer,
          input(venue, quote).mint,
        ]);
        expect(built.packetBytes).toBeLessThanOrEqual(1232);
      });

  it('omits the optional platform accounts and the buy when not needed', async () => {
    const built = await buildLaunchLabMessage(
      input('LetsBonk', WRAPPED_SOL, {
        allowConfig: false,
        curveRule: false,
        devBuyRaw: '0',
        minTokensOutRaw: '0',
      }),
    );
    expect(built.instructions).toHaveLength(2);
    expect(built.instructions[1].accounts).toHaveLength(18);
    expect(built.containsCreatorBuy).toBe(false);
    expect(built.baseTokenAccount).toBeNull();
  });

  it('fits a full-length identity with a SOL creator buy', async () => {
    const built = await buildLaunchLabMessage(
      input('LetsBonk', WRAPPED_SOL, {
        name: 'N'.repeat(32),
        symbol: 'S'.repeat(10),
        curveRule: false,
      }),
    );
    expect(built.packetBytes).toBeLessThanOrEqual(1232);
    expect(
      built.instructions.some(
        (i) =>
          i.programAddress === 'ComputeBudget111111111111111111111111111111',
      ),
    ).toBe(false);
  });

  it('refuses another platform, curve or venue', async () => {
    await expect(
      buildLaunchLabMessage(
        input('LetsBonk', WRAPPED_SOL, {
          platformId: LAUNCHLAB_PLATFORMS.Surge,
        }),
      ),
    ).rejects.toThrow(/registered LetsBonk platform/);
    await expect(
      buildLaunchLabMessage(
        input('Surge', WRAPPED_SOL, { totalFundRaisingB: '1' }),
      ),
    ).rejects.toThrow(/reviewed defaults/);
    await expect(
      buildLaunchLabMessage({
        ...input('Surge', WRAPPED_SOL),
        venue: 'PumpFun' as LaunchLabVenue,
      }),
    ).rejects.toThrow(/venue/);
    await expect(
      buildLaunchLabMessage(
        input('Surge', WRAPPED_SOL, { devBuyRaw: '0', minTokensOutRaw: '5' }),
      ),
    ).rejects.toThrow(/create-only/);
  });
});
