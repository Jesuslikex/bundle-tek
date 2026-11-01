import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { createVault, generateVaultWallets } from './browser-wallet-vault';
import {
  FUND_PER_TRANSACTION,
  RETURN_PER_TRANSACTION,
  chunkTransfers,
  distributionMessage,
  formatSol,
  fromBase64,
  parseSol,
  planAmounts,
  signDistributionBatch,
  verifySignedBatch,
  type DistributionBatch,
} from './sol-distribution';

type Legacy = {
  header: { numSignerAccounts: number };
  staticAccounts: string[];
  lifetimeToken: string;
  instructions: {
    programAddressIndex: number;
    accountIndices?: number[];
    data?: Uint8Array;
  }[];
};
const decodeLegacy = (message: Uint8Array) =>
  getCompiledTransactionMessageDecoder().decode(message) as unknown as Legacy;
const key = () => bs58.encode(nacl.sign.keyPair().publicKey);
const blockhash = key();

async function vault(n: number) {
  return generateVaultWallets(
    await createVault('fixture-password'),
    'solana',
    n,
  );
}

describe('SOL distribution packets', () => {
  it('builds a funder-paid fund transfer list that decodes as System transfers', () => {
    const funder = key();
    const transfers = Array.from({ length: FUND_PER_TRANSACTION }, (_, i) => ({
      address: key(),
      lamports: String(1_000_000 + i),
    }));
    const batch: DistributionBatch = {
      mode: 'fund',
      funder,
      blockhash,
      transfers,
    };
    const message = distributionMessage(batch);
    const decoded = decodeLegacy(message);
    expect(decoded.header.numSignerAccounts).toBe(1);
    expect(decoded.staticAccounts[0]).toBe(funder);
    expect(decoded.lifetimeToken).toBe(blockhash);
    expect(decoded.instructions).toHaveLength(FUND_PER_TRANSACTION);
    decoded.instructions.forEach((ix, i) => {
      expect(decoded.staticAccounts[ix.programAddressIndex]).toBe(
        '11111111111111111111111111111111',
      );
      expect(ix.accountIndices).toEqual([0, i + 1]);
      const data = new DataView(Uint8Array.from(ix.data!).buffer);
      expect(data.getUint32(0, true)).toBe(2);
      expect(data.getBigUint64(4, true)).toBe(BigInt(1_000_000 + i));
    });
    // Full-size wire transaction fits Solana's packet limit.
    expect(1 + 64 + message.length).toBeLessThanOrEqual(1232);
  });

  it('builds a return packet where every source signs and sends to the funder', () => {
    const funder = key();
    const transfers = Array.from({ length: RETURN_PER_TRANSACTION }, () => ({
      address: key(),
      lamports: '5000000',
    }));
    const message = distributionMessage({
      mode: 'return',
      funder,
      blockhash,
      transfers,
    });
    const decoded = decodeLegacy(message);
    expect(decoded.header.numSignerAccounts).toBe(1 + RETURN_PER_TRANSACTION);
    decoded.instructions.forEach((ix, i) =>
      expect(ix.accountIndices).toEqual([i + 1, 0]),
    );
    expect(
      1 + 64 * (1 + RETURN_PER_TRANSACTION) + message.length,
    ).toBeLessThanOrEqual(1232);
  });

  it('refuses duplicates, the funder as recipient, zero and oversized batches', () => {
    const funder = key(),
      a = key();
    const base = { mode: 'fund' as const, funder, blockhash };
    expect(() =>
      distributionMessage({
        ...base,
        transfers: [
          { address: a, lamports: '1' },
          { address: a, lamports: '1' },
        ],
      }),
    ).toThrow('distinct');
    expect(() =>
      distributionMessage({
        ...base,
        transfers: [{ address: funder, lamports: '1' }],
      }),
    ).toThrow('distinct');
    expect(() =>
      distributionMessage({
        ...base,
        transfers: [{ address: a, lamports: '0' }],
      }),
    ).toThrow('lamport');
    expect(() =>
      distributionMessage({
        ...base,
        transfers: Array.from({ length: FUND_PER_TRANSACTION + 1 }, () => ({
          address: key(),
          lamports: '1',
        })),
      }),
    ).toThrow('Each transaction');
    expect(
      chunkTransfers(
        'fund',
        Array.from({ length: 45 }, () => ({ address: key(), lamports: '1' })),
      ).map((c) => c.length),
    ).toEqual([20, 20, 5]);
    expect(
      chunkTransfers(
        'return',
        Array.from({ length: 17 }, () => ({ address: key(), lamports: '1' })),
      ).map((c) => c.length),
    ).toEqual([8, 8, 1]);
  });

  it('signs a fund batch in the vault and the server-side check accepts only the exact packet', async () => {
    const session = await vault(3);
    const [funder, x, y] = session.payload.wallets.map((w) => w.address);
    const batch: DistributionBatch = {
      mode: 'fund',
      funder,
      blockhash,
      transfers: [
        { address: x, lamports: '10000000' },
        { address: y, lamports: '20000000' },
      ],
    };
    const { transaction, signature } = signDistributionBatch(session, batch);
    const decoded = getTransactionDecoder().decode(fromBase64(transaction));
    expect(Object.keys(decoded.signatures)).toEqual([funder]);
    expect(verifySignedBatch(batch, transaction).signature).toBe(signature);
    expect(() =>
      verifySignedBatch(
        {
          ...batch,
          transfers: [{ address: x, lamports: '10000001' }, batch.transfers[1]],
        },
        transaction,
      ),
    ).toThrow('differs');
    const bytes = fromBase64(transaction);
    bytes[5] ^= 1;
    expect(() =>
      verifySignedBatch(batch, btoa(String.fromCharCode(...bytes))),
    ).toThrow('invalid');
  });

  it('signs a return batch with funder and every source', async () => {
    const session = await vault(3);
    const [funder, x, y] = session.payload.wallets.map((w) => w.address);
    const batch: DistributionBatch = {
      mode: 'return',
      funder,
      blockhash,
      transfers: [
        { address: x, lamports: '1' },
        { address: y, lamports: '2' },
      ],
    };
    const { transaction } = signDistributionBatch(session, batch);
    expect(verifySignedBatch(batch, transaction).signatures).toHaveLength(3);
  });

  it('refuses to sign anything when a required key is missing', async () => {
    const session = await vault(1);
    const funder = session.payload.wallets[0].address;
    expect(() =>
      signDistributionBatch(session, {
        mode: 'return',
        funder,
        blockhash,
        transfers: [{ address: key(), lamports: '1' }],
      }),
    ).toThrow('not in this browser vault');
  });

  it('parses SOL exactly and plans fixed and range amounts', () => {
    expect(parseSol('0.01')).toBe(10_000_000n);
    expect(parseSol('1.123456789')).toBe(1_123_456_789n);
    expect(() => parseSol('1.0000000001')).toThrow();
    expect(() => parseSol('-1')).toThrow();
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(planAmounts(3, { fixed: 7n })).toEqual([7n, 7n, 7n]);
    const values = [0, 0.5, 0.999999];
    let i = 0;
    const range = planAmounts(
      3,
      { min: parseSol('0.01'), max: parseSol('0.02') },
      () => values[i++],
    );
    expect(range).toEqual([10_000_000n, 15_000_000n, 20_000_000n]);
    for (const v of planAmounts(50, {
      min: parseSol('0.01'),
      max: parseSol('0.02'),
    })) {
      expect(v).toBeGreaterThanOrEqual(10_000_000n);
      expect(v).toBeLessThanOrEqual(20_000_000n);
      expect(v % 100_000n).toBe(0n);
    }
    expect(() => planAmounts(1, { min: 5n, max: 1n })).toThrow();
  });
});
