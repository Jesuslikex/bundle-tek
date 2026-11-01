import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { createVault, generateVaultWallets } from './browser-wallet-vault';
import {
  distributionRequest,
  prepareDistribution,
  submitDistribution,
} from './sol-distribution-server';
import { signDistributionBatch } from './sol-distribution';

const key = () => bs58.encode(nacl.sign.keyPair().publicKey);
const blockhash = key();
const SYSTEM = '11111111111111111111111111111111';

function fakeRpc(lamports: Record<string, bigint>, simErr: unknown = null) {
  const calls: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getLatestBlockhash')
      return { value: { blockhash, lastValidBlockHeight: 123 } };
    if (method === 'getMultipleAccounts')
      return {
        value: (params[0] as string[]).map((a) =>
          lamports[a] === undefined
            ? null
            : {
                lamports: lamports[a].toString(),
                owner: SYSTEM,
                executable: false,
                data: ['', 'base64'],
              },
        ),
      };
    if (method === 'simulateTransaction') return { value: { err: simErr } };
    throw new Error('unexpected ' + method);
  });
  return { rpc, calls };
}

describe('server SOL distribution', () => {
  it('prepares batched fund transfers after balance, rent and simulation checks', async () => {
    const funder = key();
    const wallets = Array.from({ length: 25 }, key);
    const { rpc, calls } = fakeRpc({ [funder]: 2_000_000_000n });
    const input = distributionRequest({
      mode: 'fund',
      funder,
      transfers: wallets.map((address) => ({ address, lamports: '10000000' })),
    });
    const prepared = await prepareDistribution(input, rpc);
    expect(prepared.batches.map((b) => b.transfers.length)).toEqual([20, 5]);
    expect(prepared.totalLamports).toBe('250000000');
    expect(prepared.feeLamports).toBe('10000');
    expect(calls.filter((c) => c === 'simulateTransaction')).toHaveLength(2);
  });

  it('refuses when the funder cannot cover amounts, fees and its rent minimum', async () => {
    const funder = key(),
      a = key();
    const { rpc } = fakeRpc({ [funder]: 10_000_000n });
    await expect(
      prepareDistribution(
        distributionRequest({
          mode: 'fund',
          funder,
          transfers: [{ address: a, lamports: '9500000' }],
        }),
        rpc,
      ),
    ).rejects.toThrow('too low');
  });

  it('refuses a new wallet that would stay below rent', async () => {
    const funder = key(),
      a = key();
    const { rpc } = fakeRpc({ [funder]: 1_000_000_000n });
    await expect(
      prepareDistribution(
        distributionRequest({
          mode: 'fund',
          funder,
          transfers: [{ address: a, lamports: '1000' }],
        }),
        rpc,
      ),
    ).rejects.toThrow('rent minimum');
  });

  it('returns every full balance to the funder, skipping empty wallets', async () => {
    const funder = key(),
      a = key(),
      b = key(),
      empty = key();
    const { rpc } = fakeRpc({
      [funder]: 1_000_000n,
      [a]: 3_000_000n,
      [b]: 4_000_000n,
    });
    const prepared = await prepareDistribution(
      distributionRequest({ mode: 'return', funder, wallets: [a, b, empty] }),
      rpc,
    );
    expect(prepared.skipped).toEqual([empty]);
    expect(prepared.totalLamports).toBe('7000000');
    expect(prepared.feeLamports).toBe('15000');
    expect(prepared.batches[0].transfers).toEqual([
      { address: a, lamports: '3000000' },
      { address: b, lamports: '4000000' },
    ]);
  });

  it('stops before signing when simulation fails', async () => {
    const funder = key(),
      a = key();
    const { rpc } = fakeRpc(
      { [funder]: 1_000_000_000n, [a]: 1_000_000n },
      { InstructionError: [0, 'x'] },
    );
    await expect(
      prepareDistribution(
        distributionRequest({
          mode: 'fund',
          funder,
          transfers: [{ address: a, lamports: '1000000' }],
        }),
        rpc,
      ),
    ).rejects.toThrow('simulation failed');
  });

  it('rejects malformed requests', () => {
    const funder = key();
    expect(() =>
      distributionRequest({ mode: 'fund', funder, transfers: [] }),
    ).toThrow();
    expect(() =>
      distributionRequest({ mode: 'return', funder, wallets: [funder] }),
    ).toThrow('distinct');
    expect(() =>
      distributionRequest({ mode: 'steal', funder, wallets: [key()] }),
    ).toThrow();
    expect(() =>
      distributionRequest({
        mode: 'fund',
        funder,
        transfers: [{ address: key(), lamports: '1.5' }],
      }),
    ).toThrow();
  });

  it('sends only an exact, fully signed batch', async () => {
    const session = generateVaultWallets(
      await createVault('fixture-password'),
      'solana',
      2,
    );
    const [funder, a] = session.payload.wallets.map((w) => w.address);
    const batch = {
      mode: 'fund' as const,
      funder,
      blockhash,
      transfers: [{ address: a, lamports: '5000000' }],
    };
    const { transaction, signature } = signDistributionBatch(session, batch);
    const rpc = vi.fn(async () => signature);
    await expect(submitDistribution(batch, transaction, rpc)).resolves.toBe(
      signature,
    );
    expect(rpc).toHaveBeenCalledWith('sendTransaction', [
      transaction,
      expect.objectContaining({ encoding: 'base64' }),
    ]);
    const other = vi.fn();
    await expect(
      submitDistribution(
        { ...batch, transfers: [{ address: a, lamports: '6000000' }] },
        transaction,
        other,
      ),
    ).rejects.toThrow('differs');
    expect(other).not.toHaveBeenCalled();
  });
});
