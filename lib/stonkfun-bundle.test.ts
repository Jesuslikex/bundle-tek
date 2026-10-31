import { describe, expect, it } from 'vitest';
import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import golden from '@/test/stonkfun-curve-sdk-golden.json';
import {
  stonkConfigId,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WRAPPED_SOL,
  type StonkLaunchInput,
} from './stonkfun-launch';
import {
  buildStonkBundle,
  decodeStonkPool,
  stonkBuyExactIn,
  stonkFeeRate,
  verifyStonkBundleSigned,
} from './stonkfun-bundle';

const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const pair = (n: number) =>
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n));
const key = (n: number) => bs58.encode(pair(n).publicKey);
const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
async function launch(quote: 'sol' | 'spyx'): Promise<StonkLaunchInput> {
  const quoteMint = quote === 'sol' ? WRAPPED_SOL : SPYX;
  return {
    name: 'Bundle Test',
    symbol: 'BNDL',
    uri: 'https://bundle-tek.vercel.app/api/launch/metadata/' + 'a'.repeat(64),
    payer: key(1),
    mint: key(2),
    quoteMint,
    quoteTokenProgram: quote === 'sol' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
    platformId: STONKFUN_STANDARD_PLATFORM,
    configId: await stonkConfigId(quoteMint),
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '85000000000',
    cpmmCreatorFeeOn: 0,
    allowConfig: true,
    curveRule: true,
    devBuyRaw: '1000000000',
    minTokensOutRaw: '34026261107560',
    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    lastValidBlockHeight: '300000000',
  };
}
const holders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    holder: key(10 + i),
    buyRaw: String(100000000 * (i + 1)),
    minTokensOutRaw: String(1000 + i),
  }));
function sign(packet: string, signers: number[]) {
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(packet, 'base64')),
  );
  const signatures: Record<string, SignatureBytes> = {};
  for (const n of signers)
    signatures[address(key(n))] = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair(n).secretKey,
    ) as SignatureBytes;
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...tx,
      signatures: { ...tx.signatures, ...signatures },
    }),
  );
}

describe('StonkFun holder bundle packets', () => {
  for (const quote of ['sol', 'spyx'] as const)
    it(`packs six ${quote} holders into three packets plus a deployer tip`, async () => {
      const input = await launch(quote);
      const built = await buildStonkBundle(input, {
        holders: holders(6),
        tipAccount: TIP,
        tipLamports: '100000',
      });
      expect(built.packets.map((p) => p.kind)).toEqual([
        'holders',
        'holders',
        'holders',
        'tip',
      ]);
      expect(built.packets.map((p) => p.signers)).toEqual([
        [key(10), key(11)],
        [key(12), key(13)],
        [key(14), key(15)],
        [key(1)],
      ]);
      for (const p of built.packets) {
        const tx = getTransactionDecoder().decode(
          Uint8Array.from(Buffer.from(p.transaction, 'base64')),
        );
        expect(Buffer.from(p.transaction, 'base64').length).toBeLessThanOrEqual(
          1232,
        );
        expect(Object.values(tx.signatures).every((s) => s === null)).toBe(
          true,
        );
      }
      // Deterministic: the browser rebuilds the exact same bytes.
      const again = await buildStonkBundle(input, {
        holders: holders(6),
        tipAccount: TIP,
        tipLamports: '100000',
      });
      expect(again.sha256).toBe(built.sha256);
      expect(again.create.packetSha256).toBe(built.create.packetSha256);
    });

  it('refuses duplicate, deployer or mint holders and bad tips', async () => {
    const input = await launch('sol');
    for (const bad of [
      [...holders(1), ...holders(1)],
      [{ ...holders(1)[0], holder: key(1) }],
      [{ ...holders(1)[0], holder: key(2) }],
      holders(7),
      [],
    ])
      await expect(
        buildStonkBundle(input, {
          holders: bad,
          tipAccount: TIP,
          tipLamports: '100000',
        }),
      ).rejects.toThrow();
    for (const tipLamports of ['999', '10000001', '0'])
      await expect(
        buildStonkBundle(input, {
          holders: holders(1),
          tipAccount: TIP,
          tipLamports,
        }),
      ).rejects.toThrow();
  });

  it('accepts only exact fully signed packets', async () => {
    const built = await buildStonkBundle(await launch('sol'), {
      holders: holders(3),
      tipAccount: TIP,
      tipLamports: '100000',
    });
    const signers = [[10, 11], [12], [1]];
    const signed = built.packets.map((p, i) => sign(p.transaction, signers[i]));
    expect(verifyStonkBundleSigned(built.packets, signed)).toHaveLength(3);
    // Missing one holder signature.
    expect(() =>
      verifyStonkBundleSigned(built.packets, [
        sign(built.packets[0].transaction, [10]),
        ...signed.slice(1),
      ]),
    ).toThrow();
    // Wrong key.
    expect(() =>
      verifyStonkBundleSigned(built.packets, [
        signed[0],
        signed[1],
        sign(built.packets[2].transaction, [3]),
      ]),
    ).toThrow();
    // Reordered or truncated.
    expect(() =>
      verifyStonkBundleSigned(built.packets, [signed[1], signed[0], signed[2]]),
    ).toThrow();
    expect(() =>
      verifyStonkBundleSigned(built.packets, signed.slice(0, 2)),
    ).toThrow();
  });
});

describe('LaunchLab curve math', () => {
  it('matches Raydium SDK Curve.buyExactIn for sequential buys', () => {
    const feeRate = 2500n + 10000n + 5000n;
    for (const step of golden.steps) {
      const result = stonkBuyExactIn(
        {
          virtualA: BigInt(golden.virtualA),
          virtualB: BigInt(golden.virtualB),
          realA: BigInt(step.realA),
          realB: BigInt(step.realB),
          totalSellA: 793100000000000n,
        },
        BigInt(step.amountB),
        feeRate,
      );
      expect(result.tokensOut.toString()).toBe(step.tokensOut);
      expect(result.next.realB - BigInt(step.realB)).toBe(
        BigInt(step.amountB) - BigInt(step.totalFee),
      );
    }
  });

  it('refuses buys that would finish the curve', () => {
    expect(() =>
      stonkBuyExactIn(
        {
          virtualA: BigInt(golden.virtualA),
          virtualB: BigInt(golden.virtualB),
          realA: 0n,
          realB: 0n,
          totalSellA: 793100000000000n,
        },
        10n ** 15n,
        0n,
      ),
    ).toThrow(/finish/);
  });

  it('decodes pool reserves and fee rates at the SDK layout offsets', () => {
    const pool = new Uint8Array(200),
      view = new DataView(pool.buffer);
    view.setBigUint64(29, 7n, true);
    view.setBigUint64(37, 1n, true);
    view.setBigUint64(45, 2n, true);
    view.setBigUint64(53, 3n, true);
    view.setBigUint64(61, 4n, true);
    expect(decodeStonkPool(pool)).toEqual({
      totalSellA: 7n,
      virtualA: 1n,
      virtualB: 2n,
      realA: 3n,
      realB: 4n,
    });
    const config = new Uint8Array(400),
      platform = new Uint8Array(900);
    new DataView(config.buffer).setBigUint64(27, 2500n, true);
    new DataView(platform.buffer).setBigUint64(104, 10000n, true);
    new DataView(platform.buffer).setBigUint64(720, 5000n, true);
    expect(stonkFeeRate(config, platform)).toBe(17500n);
  });
});
