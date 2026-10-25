import { describe, expect, it } from 'vitest';
import {
  assessWarmupReadiness,
  WARMUP_READINESS_DISCLOSURES,
  WARMUP_TOKEN_ACCOUNT_RENT_LAMPORTS,
  WarmupReadinessInputError,
} from './warmup-readiness';

const walletA = '11111111111111111111111111111111';
const walletB = 'SysvarRent111111111111111111111111111111111';

/** fee reserve 0.01 SOL + 2,039,280 lamports of token-account rent. */
const required = '0.01203928';

describe('readiness requirement', () => {
  it('adds token-account rent to the fee reserve on Solana', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: '1' }],
    });
    expect(WARMUP_TOKEN_ACCOUNT_RENT_LAMPORTS).toBe(2_039_280n);
    expect(result.perWalletRequired).toBe(required);
    expect(result.breakdown).toEqual({
      feeReserve: '0.01',
      tokenAccountRent: '0.00203928',
    });
    expect(result.currency).toBe('SOL');
  });

  it('omits token-account rent when the first account is expected to exist', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      chargeTokenAccountRent: false,
      balances: [{ address: walletA, nativeBalance: '1' }],
    });
    expect(result.perWalletRequired).toBe('0.01');
    expect(result.breakdown.tokenAccountRent).toBe('0');
  });

  it('does not invent EVM rent costs', () => {
    const result = assessWarmupReadiness({
      chain: 'Base',
      feeReserve: '0.001',
      balances: [
        {
          address: '0x1111111111111111111111111111111111111111',
          nativeBalance: '1',
        },
      ],
    });
    expect(result.perWalletRequired).toBe('0.001');
    expect(result.breakdown.tokenAccountRent).toBe('0');
    expect(result.currency).toBe('ETH');
  });
});

describe('per-wallet status', () => {
  it('treats an exactly-funded wallet as ready', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: required }],
    });
    expect(result.wallets).toEqual([
      {
        address: walletA,
        status: 'ready',
        balance: required,
        required,
        shortfall: null,
      },
    ]);
    expect(result.readyCount).toBe(1);
    expect(result.totalShortfall).toBe('0');
  });

  it('reports the exact shortfall below the requirement', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: '0.012' }],
    });
    expect(result.wallets[0]).toMatchObject({
      status: 'needs-funding',
      shortfall: '0.00003928',
    });
    expect(result.fundingCount).toBe(1);
    expect(result.totalShortfall).toBe('0.00003928');
  });

  it('treats an unfunded wallet as needing the full requirement', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: '0' }],
    });
    expect(result.wallets[0]).toMatchObject({
      status: 'needs-funding',
      shortfall: required,
    });
  });

  it('never counts an unknown read as zero or as ready', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: null }],
    });
    expect(result.wallets[0]).toEqual({
      address: walletA,
      status: 'unknown',
      balance: null,
      required,
      shortfall: null,
    });
    expect(result.unknownCount).toBe(1);
    expect(result.readyCount).toBe(0);
    expect(result.fundingCount).toBe(0);
    expect(result.totalShortfall).toBe('0');
  });

  it('treats a malformed balance as unknown rather than guessing', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: 'not-a-number' }],
    });
    expect(result.wallets[0].status).toBe('unknown');
  });

  it('sums shortfalls across wallets and separates ready ones', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [
        { address: walletA, nativeBalance: '0.02' },
        { address: walletB, nativeBalance: '0.012' },
      ],
    });
    expect(result.wallets.map((w) => w.status)).toEqual([
      'ready',
      'needs-funding',
    ]);
    expect(result.wallets[0].shortfall).toBeNull();
    expect(result.totalShortfall).toBe('0.00003928');
    expect(result.readyCount).toBe(1);
    expect(result.fundingCount).toBe(1);
  });
});

describe('input refusal and honest guarantees', () => {
  it('refuses an invalid fee reserve with a field-specific error', () => {
    for (const feeReserve of ['', 'abc', '-1', '0.0000000001']) {
      try {
        assessWarmupReadiness({
          chain: 'Solana',
          feeReserve,
          balances: [{ address: walletA, nativeBalance: '1' }],
        });
        throw new Error(`expected a refusal for ${feeReserve}`);
      } catch (error) {
        expect(error).toBeInstanceOf(WarmupReadinessInputError);
        expect((error as WarmupReadinessInputError).field).toBe('feeReserve');
      }
    }
  });

  it('refuses duplicate or empty wallet selections', () => {
    for (const balances of [
      [],
      [
        { address: walletA, nativeBalance: '1' },
        { address: walletA, nativeBalance: '1' },
      ],
    ]) {
      try {
        assessWarmupReadiness({
          chain: 'Solana',
          feeReserve: '0.01',
          balances,
        });
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(WarmupReadinessInputError);
        expect((error as WarmupReadinessInputError).field).toBe('wallets');
      }
    }
  });

  it('states the operator linkage and the absence of any write or volume path', () => {
    const result = assessWarmupReadiness({
      chain: 'Solana',
      feeReserve: '0.01',
      balances: [{ address: walletA, nativeBalance: '1' }],
    });
    expect(result.volumeGeneration).toBe(false);
    expect(result.writesTransactions).toBe(false);
    expect(result.disclosures).toBe(WARMUP_READINESS_DISCLOSURES);
    expect(result.disclosures.join(' ')).toMatch(/one operator/);
    expect(result.disclosures.join(' ')).toMatch(
      /never signs, sends or schedules/,
    );
    expect(result.disclosures.join(' ')).toMatch(
      /does not make it independent/,
    );
  });
});
