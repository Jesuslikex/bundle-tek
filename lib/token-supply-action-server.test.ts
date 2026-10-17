import { describe, expect, it } from 'vitest';
import {
  decodeSupplyActionReceipt,
  prepareSupplyAction,
  recheckSupplyAction,
} from './token-supply-action-server';
import {
  generateLockMetadataKey,
  inspectSupplyAction,
  signSupplyAction,
} from './token-supply-action';
import {
  chain,
  input,
  MINT,
  signal,
  SUPPLY,
  supplySession,
  WALLET,
} from '../test/token-supply-fixture';

describe('prepareSupplyAction', () => {
  it('prepares, simulates and rechecks an exact burn of 1% of supply', async () => {
    const c = chain('burn');
    const review = await prepareSupplyAction(
      input('burn'),
      signal(),
      c.fetcher,
    );
    expect(review).toMatchObject({
      kind: 'burn',
      supplyRaw: SUPPLY.toString(),
      amountRaw: '10000000000000',
      amount: '10000000',
      tokenDebitRaw: '10000000000000',
      solDebitLamports: '5000',
      feeLamports: '5000',
    });
    expect(c.calls).toContain('simulateTransaction');
    await inspectSupplyAction(review, review.transaction, false);
    await expect(
      recheckSupplyAction(review, signal(), c.fetcher),
    ).resolves.toBeUndefined();
  });
  it('records the Streamflow token fee and SOL cost for a lock', async () => {
    const key = generateLockMetadataKey();
    const c = chain('lock', { tokenFeeBps: 19n });
    const review = await prepareSupplyAction(
      input('lock', key.address),
      signal(),
      c.fetcher,
    );
    expect(review.tokenDebitRaw).toBe('10019000000000');
    expect(review.solDebitLamports).toBe('3010000');
    expect(review.lock!.metadata).toBe(key.address);
    expect(review.lock!.unlockAt).toBe(
      Math.floor(Date.parse(review.preparedAt) / 1000) + 86400,
    );
  });
  it('refuses more than the wallet holds, failed simulations and changed costs', async () => {
    const short = chain('burn');
    short.state.balance = 1n;
    await expect(
      prepareSupplyAction(input('burn'), signal(), short.fetcher),
    ).rejects.toThrow(/does not hold that share/);
    const failing = chain('burn');
    failing.state.simulateErr = { InstructionError: [0, 'Custom'] };
    await expect(
      prepareSupplyAction(input('burn'), signal(), failing.fetcher),
    ).rejects.toThrow(/simulation failed/);
    const drift = chain('burn');
    const review = await prepareSupplyAction(
      input('burn'),
      signal(),
      drift.fetcher,
    );
    drift.state.extraLamports = 1n;
    await expect(
      recheckSupplyAction(review, signal(), drift.fetcher),
    ).rejects.toThrow(/changed since approval/);
    drift.state.extraLamports = 0n;
    drift.state.supply += 1n;
    await expect(
      recheckSupplyAction(review, signal(), drift.fetcher),
    ).rejects.toThrow(/supply changed/);
  });
});

describe('decodeSupplyActionReceipt', () => {
  it('accepts the exact finalized burn and records the supply change', async () => {
    const c = chain('burn');
    const review = await prepareSupplyAction(
      input('burn'),
      signal(),
      c.fetcher,
    );
    const signed = await signSupplyAction(supplySession, review, () => {});
    const raw = {
      transaction: [signed.transaction, 'base64'],
      slot: 120,
      blockTime: 1800000000,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1_000_000_000, 0],
        postBalances: [999_995_000, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: '50000000000000' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: '40000000000000' },
          },
        ],
      },
    };
    const receipt = await decodeSupplyActionReceipt(
      raw,
      review,
      signed.signature,
    );
    expect(receipt).toMatchObject({
      failed: false,
      tokenChangeRaw: '-10000000000000',
      supplyChangeRaw: '-10000000000000',
      walletLamportsChange: '-5000',
    });
    await expect(
      decodeSupplyActionReceipt(
        {
          ...raw,
          meta: {
            ...raw.meta,
            postTokenBalances: [
              {
                ...raw.meta.postTokenBalances[0],
                uiTokenAmount: { amount: '0' },
              },
            ],
          },
        },
        review,
        signed.signature,
      ),
    ).rejects.toThrow(/settlement differs/);
    const failed = await decodeSupplyActionReceipt(
      { ...raw, meta: { ...raw.meta, err: { InstructionError: [0, 'X'] } } },
      review,
      signed.signature,
    );
    expect(failed).toMatchObject({ failed: true, supplyChangeRaw: null });
  });
});
