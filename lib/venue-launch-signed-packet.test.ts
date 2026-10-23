import { beforeAll, describe, expect, it } from 'vitest';
import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import dbcGolden from '../test/meteora-dbc-sdk-golden.json';
import {
  buildMeteoraDbcMessage,
  WRAPPED_SOL,
  type MeteoraDbcInput,
} from './meteora-dbc-launch';
import type { MeteoraDbcReview } from './meteora-dbc-launch-service';
import {
  buildStonkLaunchMessage,
  stonkConfigId,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_PROGRAM,
  type StonkLaunchInput,
} from './stonkfun-launch';
import type { StonkLaunchReview } from './stonkfun-launch-service';
import { verifyVenueLaunchSignedPacket } from './venue-launch-signed-packet';

type Review = MeteoraDbcReview | StonkLaunchReview;
const payer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const mint = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const payerAddress = bs58.encode(payer.publicKey);
const mintAddress = bs58.encode(mint.publicKey);
const decode = (packet: string) =>
  getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(packet, 'base64')),
  );
const encode = (
  tx: Parameters<ReturnType<typeof getTransactionEncoder>['encode']>[0],
) => getBase64Decoder().decode(getTransactionEncoder().encode(tx));
function sign(transaction: string, wrongPayer = false) {
  const tx = decode(transaction);
  const signatures: Record<string, SignatureBytes> = {};
  for (const [key, pair] of [
    [payerAddress, wrongPayer ? other : payer],
    [mintAddress, mint],
  ] as const)
    signatures[address(key)] = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair.secretKey,
    ) as SignatureBytes;
  return encode({ ...tx, signatures });
}
const commonInput = {
  name: 'Recovery Test',
  symbol: 'RCT',
  uri: 'https://bundle.test/api/launch/metadata/' + 'a'.repeat(64),
  payer: payerAddress,
  mint: mintAddress,
  quoteMint: WRAPPED_SOL,
  devBuyRaw: '0',
  minTokensOutRaw: '0',
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: '300000000',
};
const terms = {
  projectId: 'recovery-test',
  updatedAt: '2026-10-23T00:00:00.000Z',
  releaseId: 'a'.repeat(64),
  payer: payerAddress,
  payerRevision: 1,
  mint: mintAddress,
  devBuyRaw: '0',
  solLimitLamports: '100000000',
};
const commonSummary = {
  quoteSymbol: 'SOL',
  quoteDecimals: 9,
  supplyRaw: '1000000000000000',
  devBuyRaw: '0',
  tokensOutRaw: '0',
  devSupplyBps: 0,
  solCostLamports: '10000',
  solLimitLamports: terms.solLimitLamports,
  unitsConsumed: 100000,
};
const reviews = {} as Record<'dbc' | 'stonk', Review>;
beforeAll(async () => {
  const dbcInput: MeteoraDbcInput = {
    ...commonInput,
    config: dbcGolden.config,
    baseTokenType: 0,
    firstSwapWithMinFee: false,
  };
  const dbc = await buildMeteoraDbcMessage(dbcInput);
  reviews.dbc = {
    format: 'meteora-dbc-launch-review-v1',
    terms: { ...terms, config: dbcInput.config },
    input: dbcInput,
    transaction: dbc.transaction,
    sha256: dbc.packetSha256,
    // Intentionally expired. Authentication of retained signatures must still work.
    expiresAt: '2000-01-01T00:00:00.000Z',
    summary: {
      ...commonSummary,
      config: dbcInput.config,
      feeClaimer: payerAddress,
      pool: dbc.pool,
      baseDecimals: 6,
      tokenStandard: 'SPL',
      migrationThresholdRaw: '85000000000',
      creatorTradingFeePercent: 0,
      poolCreationFeeLamports: '0',
    },
  };
  const stonkInput: StonkLaunchInput = {
    ...commonInput,
    quoteTokenProgram: TOKEN_PROGRAM,
    platformId: STONKFUN_STANDARD_PLATFORM,
    configId: await stonkConfigId(WRAPPED_SOL),
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '85000000000',
    cpmmCreatorFeeOn: 0,
    allowConfig: true,
    curveRule: true,
  };
  const stonk = await buildStonkLaunchMessage(stonkInput);
  reviews.stonk = {
    format: 'stonkfun-launch-review-v1',
    terms,
    input: stonkInput,
    transaction: stonk.transaction,
    sha256: stonk.packetSha256,
    expiresAt: '2000-01-01T00:00:00.000Z',
    summary: {
      ...commonSummary,
      platformName: 'Synthetic StonkFun',
      pool: stonk.pool,
      raiseRaw: stonkInput.totalFundRaisingB,
      startMarketCapUsd: null,
      graduationMarketCapUsd: null,
      pricingObservedAt: '2000-01-01T00:00:00.000Z',
    },
  };
});

describe.each(['dbc', 'stonk'] as const)(
  '%s retained signed packets',
  (venue) => {
    it('authenticates both signatures of an expired real builder packet and returns the payer signature', async () => {
      const review = reviews[venue];
      const signed = sign(review.transaction);
      await expect(verifyVenueLaunchSignedPacket(review, signed)).resolves.toBe(
        bs58.encode(decode(signed).signatures[address(payerAddress)]!),
      );
    });

    it('rejects unsigned, missing, corrupted and wrong-key signatures', async () => {
      const review = reviews[venue];
      const signed = sign(review.transaction);
      const tx = decode(signed);
      const damaged = Uint8Array.from(tx.signatures[address(mintAddress)]!);
      damaged[10] ^= 1;
      const packets = [
        review.transaction,
        sign(review.transaction, true),
        encode({
          ...tx,
          signatures: { ...tx.signatures, [mintAddress]: null },
        }),
        encode({
          ...tx,
          signatures: {
            ...tx.signatures,
            [mintAddress]: damaged as SignatureBytes,
          },
        }),
      ];
      for (const packet of packets)
        await expect(
          verifyVenueLaunchSignedPacket(review, packet),
        ).rejects.toThrow();
    });

    it('rejects a validly signed different message', async () => {
      const review = reviews[venue];
      const built =
        review.format === 'meteora-dbc-launch-review-v1'
          ? await buildMeteoraDbcMessage({ ...review.input, name: 'Different' })
          : await buildStonkLaunchMessage({
              ...review.input,
              name: 'Different',
            });
      await expect(
        verifyVenueLaunchSignedPacket(review, sign(built.transaction)),
      ).rejects.toThrow();
    });

    it('rejects changed input, unsigned packet, packet digest, pool and review terms', async () => {
      const review = reviews[venue];
      const signed = sign(review.transaction);
      const changes = [
        { input: { ...review.input, name: 'Different' } },
        { transaction: signed },
        { sha256: '0'.repeat(64) },
        { summary: { ...review.summary, pool: payerAddress } },
        { terms: { ...review.terms, payer: mintAddress } },
        { terms: { ...review.terms, mint: payerAddress } },
        { terms: { ...review.terms, devBuyRaw: '1' } },
        { summary: { ...review.summary, devBuyRaw: '1' } },
      ];
      for (const change of changes)
        await expect(
          verifyVenueLaunchSignedPacket(
            { ...review, ...change } as Review,
            signed,
          ),
        ).rejects.toThrow();
    });

    it('rejects noncanonical, oversized, truncated and trailing packet bytes', async () => {
      const review = reviews[venue];
      const signed = sign(review.transaction);
      const raw = Buffer.from(signed, 'base64');
      const packets = [
        '',
        'a'.repeat(1804),
        '%%%',
        signed + '\n',
        signed.slice(0, -4),
        Buffer.concat([raw, Uint8Array.of(1)]).toString('base64'),
        // Required signatures are encoded in the first compact-u16 byte.
        Buffer.concat([Uint8Array.of(1), raw.subarray(1)]).toString('base64'),
        Buffer.concat([Uint8Array.of(3), raw.subarray(1)]).toString('base64'),
      ];
      for (const packet of packets)
        await expect(
          verifyVenueLaunchSignedPacket(review, packet),
        ).rejects.toThrow();
    });

    it('rejects malformed review envelopes, formats and signer keys', async () => {
      const review = reviews[venue];
      const signed = sign(review.transaction);
      const malformed: unknown[] = [
        null,
        [],
        {},
        { ...review, format: 'other-launch-review-v1' },
        { ...review, input: null },
        { ...review, terms: [] },
        { ...review, summary: null },
        { ...review, sha256: null },
        { ...review, transaction: 7 },
        { ...review, input: { ...review.input, payer: 'invalid' } },
        { ...review, input: { ...review.input, mint: payerAddress } },
      ];
      for (const value of malformed)
        await expect(
          verifyVenueLaunchSignedPacket(value as Review, signed),
        ).rejects.toThrow();
    });
  },
);

it('rejects a DBC config that differs across retained input, terms or summary', async () => {
  const review = reviews.dbc;
  const signed = sign(review.transaction);
  for (const change of [
    { terms: { ...review.terms, config: payerAddress } },
    { summary: { ...review.summary, config: payerAddress } },
  ])
    await expect(
      verifyVenueLaunchSignedPacket({ ...review, ...change } as Review, signed),
    ).rejects.toThrow();
});
