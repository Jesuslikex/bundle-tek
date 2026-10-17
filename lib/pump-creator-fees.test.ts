import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import schema from './pump-creator-fee-schema.json';
import {
  buildCreatorFeeClaimMessage,
  decodeCreatorFeeClaimReceipt,
  inspectCreatorFeeClaim,
  signCreatorFeeClaim,
  vaultKey,
  CLAIM_TOKEN,
  CLAIM_WSOL,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  type CreatorFeeClaimReview,
} from './pump-creator-fees';
import {
  claimQuoteMints,
  prepareCreatorFeeClaim,
  recheckCreatorFeeClaim,
  scanCreatorFees,
  DEFAULT_CLAIM_QUOTES,
} from './pump-creator-fees-server';
import type { VaultSession } from './browser-wallet-vault';
import {
  creatorFeeFixture,
  tokenData,
  USDC,
} from '../test/creator-fee-fixture';

const signal = () => AbortSignal.timeout(10000);
const ALL = [
  'pump-sol:' + CLAIM_WSOL,
  'pump-token:' + USDC,
  'amm-token:' + CLAIM_WSOL,
];
const session = (wallet: string, seed: Uint8Array) =>
  ({
    payload: {
      wallets: [
        {
          family: 'solana',
          address: wallet,
          seed: Buffer.from(seed).toString('hex'),
        },
      ],
    },
  }) as unknown as VaultSession;

describe('pinned Pump creator fee layouts', () => {
  it('matches Anchor discriminators and Pump program ids', () => {
    expect(PUMP_PROGRAM).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(PUMP_AMM_PROGRAM).toBe(
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    );
    for (const program of Object.values(schema.programs))
      for (const i of program.instructions)
        expect(i.discriminator).toEqual([
          ...createHash('sha256')
            .update('global:' + i.name)
            .digest()
            .subarray(0, 8),
        ]);
  });
  it('compiles one collect per vault in IDL account order with only the wallet signing', async () => {
    const f = await creatorFeeFixture();
    const scan = await scanCreatorFees(
      f.wallet,
      DEFAULT_CLAIM_QUOTES,
      signal(),
      f.fetcher,
    );
    const built = await buildCreatorFeeClaimMessage({
      wallet: f.wallet,
      vaults: scan.vaults,
      unwrapNative: true,
      blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
      lastValidBlockHeight: 10n,
    });
    const m = getCompiledTransactionMessageDecoder().decode(
      built.message,
    ) as unknown as {
      header: { numSignerAccounts: number };
      staticAccounts: string[];
      instructions: {
        programAddressIndex: number;
        accountIndices?: number[];
        data?: Uint8Array;
      }[];
    };
    expect(m.header.numSignerAccounts).toBe(1);
    expect(m.staticAccounts[0]).toBe(f.wallet);
    const programs = m.instructions.map(
      (i) => m.staticAccounts[i.programAddressIndex],
    );
    // Two idempotent receiving accounts, three collects, one WSOL close.
    expect(programs).toEqual([
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      PUMP_PROGRAM,
      PUMP_AMM_PROGRAM,
      PUMP_PROGRAM,
      CLAIM_TOKEN,
    ]);
    const sol = m.instructions[2];
    expect([...sol.data!]).toEqual(
      schema.programs.pump.instructions[0].discriminator,
    );
    expect(sol.accountIndices!.map((i) => m.staticAccounts[i])).toEqual([
      f.wallet,
      f.base.pumpVault,
      '11111111111111111111111111111111',
      f.base.pumpEvents,
      PUMP_PROGRAM,
    ]);
    const amm = m.instructions[3];
    expect(amm.accountIndices!.map((i) => m.staticAccounts[i])).toEqual([
      CLAIM_WSOL,
      CLAIM_TOKEN,
      f.wallet,
      f.base.ammAuthority,
      f.wsol.ammTokenVault,
      f.wsol.destination,
      f.base.ammEvents,
      PUMP_AMM_PROGRAM,
    ]);
  });
  it('rejects substituted vaults, duplicates and unsupported shapes', async () => {
    const f = await creatorFeeFixture();
    const { vaults } = await scanCreatorFees(
      f.wallet,
      DEFAULT_CLAIM_QUOTES,
      signal(),
      f.fetcher,
    );
    const build = (v: typeof vaults, unwrapNative = false) =>
      buildCreatorFeeClaimMessage({
        wallet: f.wallet,
        vaults: v,
        unwrapNative,
        blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
        lastValidBlockHeight: 10n,
      });
    await expect(
      build([{ ...vaults[0], vault: f.wsol.ammTokenVault }]),
    ).rejects.toThrow(/address differs/);
    await expect(
      build([{ ...vaults[1], destination: f.wallet }]),
    ).rejects.toThrow(/address differs/);
    await expect(build([vaults[0], vaults[0]])).rejects.toThrow(/distinct/);
    await expect(build([{ ...vaults[1], claimableRaw: '0' }])).rejects.toThrow(
      /nothing/,
    );
    await expect(build([vaults[0]], true)).rejects.toThrow(/unwrap/);
    await expect(build([])).rejects.toThrow(/distinct/);
  });
});

describe('scan and prepare', () => {
  it('finds claimable SOL, quote-token and PumpSwap vaults, excluding rent and empty vaults', async () => {
    const f = await creatorFeeFixture();
    const scan = await scanCreatorFees(
      f.wallet,
      DEFAULT_CLAIM_QUOTES,
      signal(),
      f.fetcher,
    );
    expect(scan.vaults.map((v) => [vaultKey(v), v.claimableRaw])).toEqual([
      ['pump-sol:' + CLAIM_WSOL, '250000000'],
      ['amm-token:' + CLAIM_WSOL, '40000000'],
      ['pump-token:' + USDC, '12500000'],
    ]);
    expect(scan.missingAccounts).toEqual([
      f.wsol.destination,
      f.usdc.destination,
    ]);
    // Absent stock mints are skipped, never guessed.
    expect(
      scan.vaults.every(
        (v) => v.quoteMint === USDC || v.quoteMint === CLAIM_WSOL,
      ),
    ).toBe(true);
  });
  it('rejects a vault token account with the wrong owner', async () => {
    const f = await creatorFeeFixture();
    f.chain.set(f.usdc.pumpTokenVault, {
      lamports: 1n,
      owner: CLAIM_TOKEN,
      data: tokenData(USDC, f.wallet, 5n),
    });
    await expect(
      scanCreatorFees(f.wallet, DEFAULT_CLAIM_QUOTES, signal(), f.fetcher),
    ).rejects.toThrow(/token account differs/);
  });
  it('prepares a reviewed, simulated packet with fee, kept rent and expected credits', async () => {
    const f = await creatorFeeFixture();
    const review = await prepareCreatorFeeClaim(
      { wallet: f.wallet, walletRevision: 3, select: ALL },
      DEFAULT_CLAIM_QUOTES,
      signal(),
      f.fetcher,
    );
    expect(review.unwrapNative).toBe(true);
    expect(review.feeLamports).toBe('5000');
    // USDC account rent is kept; the WSOL account is closed and refunded.
    expect(review.accountRentLamports).toBe('2039280');
    expect(review.simulation.walletChangeLamports).toBe(
      String(290_000_000 - 5000 - 2_039_280),
    );
    expect(review.simulation.tokens).toEqual([
      { mint: CLAIM_WSOL, account: f.wsol.destination, changeRaw: '0' },
      { mint: USDC, account: f.usdc.destination, changeRaw: '12500000' },
    ]);
    expect(Date.parse(review.expiresAt) - Date.parse(review.preparedAt)).toBe(
      60000,
    );
    await expect(
      inspectCreatorFeeClaim(review, review.transaction, false),
    ).resolves.toBeTruthy();
    // Nothing was sent while preparing.
    expect(f.calls.map((c) => c.method)).not.toContain('sendTransaction');
  });
  it('refuses selections that are no longer claimable and simulations that fail or debit', async () => {
    const f = await creatorFeeFixture();
    await expect(
      prepareCreatorFeeClaim(
        {
          wallet: f.wallet,
          walletRevision: 1,
          select: ['pump-token:' + CLAIM_WSOL],
        },
        DEFAULT_CLAIM_QUOTES,
        signal(),
        f.fetcher,
      ),
    ).rejects.toThrow(/no longer claimable/);
    f.state.simulationErr = { InstructionError: [2, 'Custom'] };
    await expect(
      prepareCreatorFeeClaim(
        { wallet: f.wallet, walletRevision: 1, select: ALL },
        DEFAULT_CLAIM_QUOTES,
        signal(),
        f.fetcher,
      ),
    ).rejects.toThrow(/simulation failed/);
    f.state.simulationErr = null;
    f.after.set(f.wallet, { ...f.chain.get(f.wallet)!, lamports: 1n });
    await expect(
      prepareCreatorFeeClaim(
        { wallet: f.wallet, walletRevision: 1, select: ALL },
        DEFAULT_CLAIM_QUOTES,
        signal(),
        f.fetcher,
      ),
    ).rejects.toThrow(/simulation differs/);
  });
  it('only accepts extra quote mints that Pump.fun lists', () => {
    expect(claimQuoteMints()).toBe(DEFAULT_CLAIM_QUOTES);
    expect(() => claimQuoteMints('11111111111111111111111111111111')).toThrow(
      /Pump.fun lists/,
    );
    expect(
      claimQuoteMints('iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF'),
    ).toHaveLength(6);
  });
});

describe('signing, recheck and receipts', () => {
  async function prepared() {
    const f = await creatorFeeFixture();
    const review = await prepareCreatorFeeClaim(
      { wallet: f.wallet, walletRevision: 1, select: ALL },
      DEFAULT_CLAIM_QUOTES,
      signal(),
      f.fetcher,
    );
    return { f, review };
  }
  it('signs only the exact reviewed packet with the matching vault wallet', async () => {
    const { f, review } = await prepared();
    const signed = await signCreatorFeeClaim(
      session(f.wallet, f.seed),
      review,
      () => {},
    );
    const checked = await inspectCreatorFeeClaim(
      review,
      signed.transaction,
      true,
    );
    expect(checked.signature).toBe(signed.signature);
    await expect(
      signCreatorFeeClaim(
        session(f.wallet, new Uint8Array(32).fill(1)),
        review,
        () => {},
      ),
    ).rejects.toThrow(/expired or changed/);
    await expect(
      signCreatorFeeClaim(
        session(f.wallet, f.seed),
        { ...review, expiresAt: review.preparedAt },
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      signCreatorFeeClaim(session(f.wallet, f.seed), review, () => {
        throw new Error('stale');
      }),
    ).rejects.toThrow('stale');
  });
  it('rejects tampered reviews, packets and foreign signatures', async () => {
    const { f, review } = await prepared();
    const signed = await signCreatorFeeClaim(
      session(f.wallet, f.seed),
      review,
      () => {},
    );
    const tampered: CreatorFeeClaimReview = {
      ...review,
      unwrapNative: false,
      newAccounts: [],
    };
    await expect(
      inspectCreatorFeeClaim(tampered, signed.transaction, true),
    ).rejects.toThrow();
    const bytes = Buffer.from(signed.transaction, 'base64');
    bytes[bytes.length - 1] ^= 1;
    await expect(
      inspectCreatorFeeClaim(review, bytes.toString('base64'), true),
    ).rejects.toThrow(/differs/);
    const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
    const raw = Buffer.from(signed.transaction, 'base64');
    raw.set(nacl.sign.detached(raw.subarray(65), other.secretKey), 1);
    await expect(
      inspectCreatorFeeClaim(review, raw.toString('base64'), true),
    ).rejects.toThrow(/signature/);
    await expect(
      inspectCreatorFeeClaim(
        { ...review, expiresAt: '2099-01-01T00:00:00Z' },
        review.transaction,
        false,
      ),
    ).rejects.toThrow(/review differs/);
  });
  it('rechecks before sending and refuses expiry, a new WSOL account or a debit', async () => {
    const { f, review } = await prepared();
    await expect(
      recheckCreatorFeeClaim(review, signal(), f.fetcher),
    ).resolves.toBeUndefined();
    f.state.blockhashValid = false;
    await expect(
      recheckCreatorFeeClaim(review, signal(), f.fetcher),
    ).rejects.toThrow(/expired/);
    f.state.blockhashValid = true;
    f.after.set(f.usdc.destination, null);
    f.chain.set(f.usdc.destination, {
      lamports: 1n,
      owner: CLAIM_TOKEN,
      data: tokenData(USDC, f.wallet, 9n),
    });
    await expect(
      recheckCreatorFeeClaim(review, signal(), f.fetcher),
    ).rejects.toThrow(/debit/);
    f.chain.set(f.wsol.destination, {
      lamports: 1n,
      owner: CLAIM_TOKEN,
      data: tokenData(CLAIM_WSOL, f.wallet, 0n),
    });
    await expect(
      recheckCreatorFeeClaim(review, signal(), f.fetcher),
    ).rejects.toThrow(/WSOL/);
  });
  it('decodes finalized success and failure receipts for the exact signature', async () => {
    const { f, review } = await prepared();
    const signed = await signCreatorFeeClaim(
      session(f.wallet, f.seed),
      review,
      () => {},
    );
    const keys = (
      await inspectCreatorFeeClaim(review, signed.transaction, true)
    ).accountKeys;
    const usdcIndex = keys.indexOf(f.usdc.destination);
    const balances = (wallet: number) =>
      keys.map((_, i) => (i === 0 ? String(wallet) : '1'));
    const raw = (err: unknown, walletAfter: number, usdcAfter: string) => ({
      slot: '1500',
      blockTime: '1760000000',
      version: 'legacy',
      transaction: [signed.transaction, 'base64'],
      meta: {
        err,
        fee: '5000',
        preBalances: balances(1_000_000_000),
        postBalances: balances(walletAfter),
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: String(usdcIndex),
            mint: USDC,
            uiTokenAmount: { amount: usdcAfter },
          },
        ],
      },
    });
    const ok = await decodeCreatorFeeClaimReceipt(
      raw(null, 1_000_000_000 + 290_000_000 - 5000 - 2_039_280, '12500000'),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(ok.failed).toBe(false);
    expect(ok.walletChangeLamports).toBe(
      String(290_000_000 - 5000 - 2_039_280),
    );
    expect(ok.tokens.find((t) => t.mint === USDC)!.changeRaw).toBe('12500000');
    const failed = await decodeCreatorFeeClaimReceipt(
      raw({ InstructionError: [2, 'Custom'] }, 1_000_000_000 - 5000, '0'),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(failed.failed).toBe(true);
    expect(failed.error).toContain('InstructionError');
    await expect(
      decodeCreatorFeeClaimReceipt(
        raw(null, 1_000_000_000 - 9_000_000, '0'),
        review,
        signed.signature,
        'rpc.test',
      ),
    ).rejects.toThrow(/settlement differs/);
    await expect(
      decodeCreatorFeeClaimReceipt(
        raw(null, 1_000_000_000, '0'),
        review,
        bs58.encode(new Uint8Array(64).fill(3)),
        'rpc.test',
      ),
    ).rejects.toThrow(/signature differs/);
  });
});
