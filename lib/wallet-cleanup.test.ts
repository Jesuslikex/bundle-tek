import { describe, expect, it } from 'vitest';
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import bs58 from 'bs58';
import {
  CLEANUP_MAX_CLOSE,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WRAPPED_SOL_MINT,
  cleanupInput,
  cleanupMessage,
  cleanupTotals,
  inspectWalletCleanup,
  isCleanupBuy,
  isCleanupSell,
  signWalletCleanupBatch,
  validatedWalletCleanup,
  type CleanupTokenProgram,
} from './wallet-cleanup';
import {
  classifyCleanupAccount,
  cleanupSweep,
  decodeWalletCleanupBuyReceipt,
  decodeWalletCleanupReceipt,
  decodeWalletCleanupSellReceipt,
  prepareWalletCleanup,
  prepareWalletCleanupBuy,
  prepareWalletCleanupSells,
  recheckWalletCleanup,
} from './wallet-cleanup-server';
import {
  cleanupFixture,
  cleanupKeys,
  tokenAccountData,
} from '../test/wallet-cleanup-fixture';

const fill = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const owner = cleanupKeys(7).address;
const account = (
  data: string,
  program: string = TOKEN_PROGRAM,
  lamports = '2039280',
) => ({
  lamports,
  owner: program,
  executable: false,
  data: [data, 'base64'] as [string, string],
});
const classify = (data: string, program: CleanupTokenProgram = TOKEN_PROGRAM) =>
  classifyCleanupAccount(fill(99), program, account(data, program), owner);
const batchId = '11111111-1111-4111-8111-111111111111';
const prepare = (f: ReturnType<typeof cleanupFixture>, keep = 0n) =>
  prepareWalletCleanup(
    {
      batchId,
      wallet: f.wallet,
      walletRevision: 1,
      destination: f.destination,
      keepLamports: keep,
    },
    AbortSignal.timeout(10000),
    f.fetcher,
  );

describe('classifyCleanupAccount', () => {
  it('closes empty accounts and wrapped SOL, keeping all rent lamports', () => {
    expect(classify(tokenAccountData({ mint: fill(1), owner }))).toEqual({
      close: {
        address: fill(99),
        program: TOKEN_PROGRAM,
        mint: fill(1),
        lamports: '2039280',
        kind: 'empty',
      },
    });
    const wrapped = classify(
      tokenAccountData({
        mint: WRAPPED_SOL_MINT,
        owner,
        amount: 9n,
        native: 2039280n,
      }),
    );
    expect('close' in wrapped && wrapped.close.kind).toBe('wrapped-sol');
  });
  it('skips balances, frozen accounts and foreign close authorities', () => {
    const reason = (
      data: string,
      program: CleanupTokenProgram = TOKEN_PROGRAM,
    ) => {
      const out = classify(data, program);
      return 'skipped' in out ? out.skipped.reason : 'close';
    };
    expect(reason(tokenAccountData({ mint: fill(1), owner, amount: 1n }))).toBe(
      'holds-tokens',
    );
    expect(reason(tokenAccountData({ mint: fill(1), owner, state: 2 }))).toBe(
      'frozen',
    );
    expect(
      reason(
        tokenAccountData({ mint: fill(1), owner, closeAuthority: fill(5) }),
      ),
    ).toBe('foreign-close-authority');
    expect(
      reason(tokenAccountData({ mint: fill(1), owner, closeAuthority: owner })),
    ).toBe('close');
  });
  it('reads Token-2022 extensions: withheld fees and unknown types block closing', () => {
    const t22 = (extensions: { type: number; data: Uint8Array }[]) => {
      const out = classify(
        tokenAccountData({ mint: fill(1), owner, extensions }),
        TOKEN_2022_PROGRAM,
      );
      return 'skipped' in out ? out.skipped.reason : 'close';
    };
    expect(t22([{ type: 7, data: new Uint8Array() }])).toBe('close');
    expect(t22([{ type: 2, data: new Uint8Array(8) }])).toBe('close');
    expect(
      t22([{ type: 2, data: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0) }]),
    ).toBe('withheld-fees');
    expect(t22([{ type: 5, data: new Uint8Array(4) }])).toBe(
      'unsupported-extension',
    );
  });
  it('refuses accounts owned by someone else or with a wrong program', () => {
    expect(() =>
      classify(tokenAccountData({ mint: fill(1), owner: fill(4) })),
    ).toThrow(/owner/);
    expect(() =>
      classifyCleanupAccount(
        fill(99),
        TOKEN_PROGRAM,
        account(tokenAccountData({ mint: fill(1), owner }), TOKEN_2022_PROGRAM),
        owner,
      ),
    ).toThrow(/owner/);
    expect(() =>
      classify(
        tokenAccountData({
          mint: fill(1),
          owner,
          extensions: [{ type: 7, data: new Uint8Array() }],
        }),
      ),
    ).toThrow(/layout/);
  });
});

describe('cleanupMessage', () => {
  it('compiles closes to the destination followed by the sweep, verified with an independent decoder', () => {
    const wallet = owner,
      destination = fill(8);
    const message = cleanupMessage({
      wallet,
      destination,
      blockhash: fill(3),
      close: [
        { address: fill(20), program: TOKEN_PROGRAM },
        { address: fill(21), program: TOKEN_2022_PROGRAM },
      ],
      sweepLamports: 123n,
    });
    const tx = getTransactionDecoder().decode(
      getBase64Encoder().encode(
        btoa(String.fromCharCode(1, ...new Uint8Array(64), ...message)),
      ),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(compiled.header).toEqual({
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 3,
    });
    expect(compiled.staticAccounts).toEqual([
      wallet,
      destination,
      fill(20),
      fill(21),
      SYSTEM_PROGRAM,
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
    ]);
    if (compiled.version !== 'legacy') throw new Error('Expected legacy.');
    const ix = compiled.instructions;
    expect(ix).toHaveLength(3);
    expect(ix[0]).toMatchObject({
      programAddressIndex: 5,
      accountIndices: [2, 1, 0],
    });
    expect(Array.from(ix[0].data!)).toEqual([9]);
    expect(ix[1]).toMatchObject({
      programAddressIndex: 6,
      accountIndices: [3, 1, 0],
    });
    expect(ix[2]).toMatchObject({
      programAddressIndex: 4,
      accountIndices: [0, 1],
    });
    const data = ix[2].data!;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(123n);
  });
  it('omits unused programs, fits the maximum close count and refuses empty or oversized work', () => {
    const close = Array.from({ length: CLEANUP_MAX_CLOSE }, (_, i) => ({
      address: fill(100 + i),
      program: TOKEN_2022_PROGRAM as typeof TOKEN_2022_PROGRAM,
    }));
    const message = cleanupMessage({
      wallet: owner,
      destination: fill(8),
      blockhash: fill(3),
      close: [
        ...close.slice(0, 19),
        { address: fill(150), program: TOKEN_PROGRAM },
      ],
      sweepLamports: 1n,
    });
    expect(message.length + 65).toBeLessThanOrEqual(1232);
    const onlyClose = cleanupMessage({
      wallet: owner,
      destination: fill(8),
      blockhash: fill(3),
      close: close.slice(0, 1),
      sweepLamports: 0n,
    });
    expect(onlyClose[2]).toBe(1);
    expect(() =>
      cleanupMessage({
        wallet: owner,
        destination: fill(8),
        blockhash: fill(3),
        close: [],
        sweepLamports: 0n,
      }),
    ).toThrow();
    expect(() =>
      cleanupMessage({
        wallet: owner,
        destination: fill(8),
        blockhash: fill(3),
        close: [...close, close[0]],
        sweepLamports: 0n,
      }),
    ).toThrow();
    expect(() =>
      cleanupMessage({
        wallet: owner,
        destination: owner,
        blockhash: fill(3),
        close: [],
        sweepLamports: 5n,
      }),
    ).toThrow();
  });
});

describe('cleanup inputs and sweep', () => {
  it('validates wallets, destination and kept balance', () => {
    const base = {
      destination: fill(8),
      wallets: [{ address: owner, revision: 2 }],
    };
    expect(cleanupInput(base).keepLamports).toBe(0n);
    expect(() =>
      cleanupInput({ ...base, wallets: [{ address: fill(8), revision: 1 }] }),
    ).toThrow(/differ/);
    expect(() =>
      cleanupInput({ ...base, wallets: [base.wallets[0], base.wallets[0]] }),
    ).toThrow(/duplicate/);
    expect(() => cleanupInput({ ...base, keepLamports: '1000' })).toThrow(
      /rent minimum/,
    );
    expect(cleanupInput({ ...base, keepLamports: '890880' }).keepLamports).toBe(
      890880n,
    );
  });
  it('sweeps everything except the fee and kept amount', () => {
    expect(cleanupSweep(20_000n, 0n, 5_000n)).toEqual({
      keep: 0n,
      sweep: 15_000n,
    });
    expect(cleanupSweep(2_000_000n, 1_000_000n, 5_000n)).toEqual({
      keep: 1_000_000n,
      sweep: 995_000n,
    });
    expect(cleanupSweep(10_000n, 1_000_000n, 5_000n)).toEqual({
      keep: 5_000n,
      sweep: 0n,
    });
    expect(() => cleanupSweep(4_999n, 0n, 5_000n)).toThrow(/fee/);
  });
});

describe('prepare, sign, recheck and receipts', () => {
  it('prepares one exact simulated packet per wallet with closeable, skipped and swept totals', async () => {
    const f = cleanupFixture();
    const review = (await prepare(f))!;
    expect(review.close.map((c) => c.kind).sort()).toEqual([
      'empty',
      'empty',
      'wrapped-sol',
    ]);
    expect(review.skipped.map((s) => s.reason).sort()).toEqual([
      'frozen',
      'holds-tokens',
      'withheld-fees',
    ]);
    expect(review.reclaimLamports).toBe(f.reclaim.toString());
    expect(review.sweepLamports).toBe('19995000');
    expect(review.keepLamports).toBe('0');
    expect(cleanupTotals([review])).toMatchObject({
      received: f.reclaim + 19_995_000n,
      closed: 3,
      skipped: 3,
    });
    expect(f.calls).toContain('simulateTransaction');
    await expect(
      inspectWalletCleanup(review, review.transaction, false),
    ).resolves.toBeTruthy();
    await expect(
      inspectWalletCleanup(
        { ...review, sweepLamports: '19994999', keepLamports: '1' },
        review.transaction,
        false,
      ),
    ).rejects.toThrow();
    await expect(
      inspectWalletCleanup(
        { ...review, destination: fill(9) },
        review.transaction,
        false,
      ),
    ).rejects.toThrow();
  });
  it('refuses a simulation whose post-state differs or errors', async () => {
    const f = cleanupFixture();
    f.state.simulationDrift = -1n;
    await expect(prepare(f)).rejects.toThrow(/settlement/);
    f.state.simulationDrift = 0n;
    f.state.simulationErr = { InstructionError: [0, 'Custom'] };
    await expect(prepare(f)).rejects.toThrow(/simulation failed/);
  });
  it('returns nothing to do for an empty wallet that only covers its fee', async () => {
    const f = cleanupFixture();
    f.state.walletLamports = 5000n;
    const review = await prepareWalletCleanup(
      {
        batchId,
        wallet: f.wallet,
        walletRevision: 1,
        destination: f.destination,
        keepLamports: 0n,
      },
      AbortSignal.timeout(10000),
      Object.assign(async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        if (body.method === 'getTokenAccountsByOwner')
          return Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: { context: { slot: 100 }, value: [] },
          });
        return f.fetcher(url as string, init);
      }) as typeof fetch,
    );
    expect(review).toBeNull();
  });
  it('keeps a requested balance and folds sub-rent keeps into the sweep', async () => {
    const f = cleanupFixture();
    f.state.keepLamports = 1_000_000n;
    const review = (await prepare(f, 1_000_000n))!;
    expect(review.keepLamports).toBe('1000000');
    expect(review.sweepLamports).toBe('18995000');
  });
  it('signs a whole batch only when every wallet is in the vault', async () => {
    const f = cleanupFixture();
    const review = (await prepare(f))!;
    const other = cleanupKeys(30);
    await expect(
      signWalletCleanupBatch(await f.session(other), [review], () => {}),
    ).rejects.toThrow(/Nothing was signed/);
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    const checked = await inspectWalletCleanup(
      review,
      signed.transaction,
      true,
    );
    expect(checked.signature).toBe(signed.signature);
    await expect(
      signWalletCleanupBatch(
        {} as never,
        [
          review,
          { ...review, batchId: '22222222-2222-4222-8222-222222222222' },
        ],
        () => {},
      ),
    ).rejects.toThrow(/one reviewed cleanup batch/);
  });
  it('rechecks unchanged state before submission and refuses changed balances', async () => {
    const f = cleanupFixture();
    const review = (await prepare(f))!;
    await expect(
      recheckWalletCleanup(review, AbortSignal.timeout(10000), f.fetcher),
    ).resolves.toBeUndefined();
    f.state.walletLamports += 1n;
    await expect(
      recheckWalletCleanup(review, AbortSignal.timeout(10000), f.fetcher),
    ).rejects.toThrow(/balance changed/);
    f.state.walletLamports -= 1n;
    f.state.blockhashValid = false;
    await expect(
      recheckWalletCleanup(review, AbortSignal.timeout(10000), f.fetcher),
    ).rejects.toThrow(/expired/);
  });
  it('decodes finalized success and failure receipts against the exact signed packet', async () => {
    const f = cleanupFixture();
    const review = (await prepare(f))!;
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    const ok = await decodeWalletCleanupReceipt(
      f.receipt(review, signed.transaction),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(ok).toMatchObject({
      closedAccounts: 3,
      destinationChangeLamports: (f.reclaim + 19_995_000n).toString(),
      walletChangeLamports: '-20000000',
    });
    await expect(
      validatedWalletCleanup({
        id: review.id,
        batchId: review.batchId,
        wallet: review.wallet,
        walletRevision: 1,
        state: 'finalized',
        signature: signed.signature,
        document: review,
        receipt: ok,
        failure: null,
        createdAt: review.preparedAt,
        updatedAt: review.preparedAt,
      }),
    ).resolves.toBeTruthy();
    f.state.receiptDrift = 1n;
    await expect(
      decodeWalletCleanupReceipt(
        f.receipt(review, signed.transaction),
        review,
        signed.signature,
        'rpc.test',
      ),
    ).rejects.toThrow(/settlement/);
    f.state.receiptDrift = 0n;
    f.state.receiptErr = { InstructionError: [2, 'Custom'] };
    const failed = await decodeWalletCleanupReceipt(
      f.receipt(review, signed.transaction),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(failed).toMatchObject({ failed: true, networkFeeLamports: '5000' });
    await expect(
      decodeWalletCleanupReceipt(
        f.receipt(review, review.transaction),
        review,
        signed.signature,
        'rpc.test',
      ),
    ).rejects.toThrow();
  });
});

describe('cleanup sells', () => {
  const sells = (f: ReturnType<typeof cleanupFixture>) =>
    prepareWalletCleanupSells(
      {
        batchId,
        wallet: f.wallet,
        walletRevision: 1,
        destination: f.destination,
      },
      'key',
      AbortSignal.timeout(10000),
      f.fetcher,
      f.sell.deps,
    );
  it('prepares one simulated whole-balance sell per held mint and signs it like any cleanup packet', async () => {
    const f = cleanupFixture();
    const {
      sells: [review],
      errors,
      remaining,
    } = await sells(f);
    expect(errors).toEqual([]);
    expect(remaining).toBe(0);
    expect(review).toMatchObject({
      format: 'wallet-cleanup-sell-v1',
      mint: f.sell.mint,
      decimals: 6,
      amountRaw: '5',
      minimumOutLamports: '995000',
      sourceAccount: f.sell.simulation.source,
    });
    expect(isCleanupSell(review)).toBe(true);
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    await expect(
      inspectWalletCleanup(review, signed.transaction, true),
    ).resolves.toMatchObject({ signature: signed.signature });
    await expect(
      inspectWalletCleanup(
        { ...review, sha256: 'a'.repeat(64) },
        signed.transaction,
        true,
      ),
    ).rejects.toThrow();
    expect(cleanupTotals([review])).toMatchObject({
      sells: 1,
      minimumSellOut: 995000n,
    });
    // The packet must pay the paired buyer, not leave the proceeds on the seller.
    expect(review.transferLamports).toBe(review.minimumOutLamports);
    const packet = getTransactionDecoder().decode(
      getBase64Encoder().encode(review.transaction),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      packet.messageBytes,
    );
    expect(message.staticAccounts).toContain(review.destination);
  });
  it('reports a holding as unsellable when the simulation does not deliver the minimum or uses another account', async () => {
    const f = cleanupFixture();
    f.sell.simulation.nativeChangeRaw = '-4000000';
    expect((await sells(f)).errors[0].error).toMatch(/did not deliver/);
    f.sell.simulation.nativeChangeRaw = '995000';
    f.sell.simulation.source = fill(1);
    expect((await sells(f)).sells).toEqual([]);
    f.sell.simulation.source = cleanupFixture().sell.simulation.source;
    f.sell.simulation.inputAmountMatches = null;
    expect((await sells(f)).sells).toEqual([]);
  });
  it('decodes finalized sell receipts and refuses partial sales', async () => {
    const f = cleanupFixture();
    const {
      sells: [review],
    } = await sells(f);
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    const ok = await decodeWalletCleanupSellReceipt(
      f.sell.receipt(signed.transaction),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(ok).toMatchObject({
      kind: 'sell',
      soldRaw: '5',
      deliveredLamports: '995000',
      nativeChangeLamports: '990000',
    });
    await expect(
      decodeWalletCleanupSellReceipt(
        f.sell.receipt(signed.transaction, 4n),
        review,
        signed.signature,
        'rpc.test',
      ),
    ).rejects.toThrow(/amount differs/);
    const failed = await decodeWalletCleanupSellReceipt(
      f.sell.receipt(signed.transaction, 0n, {
        InstructionError: [0, 'Custom'],
      }),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(failed).toMatchObject({ failed: true });
  });
});

describe('cleanup buys', () => {
  const buys = (f: ReturnType<typeof cleanupFixture>, lamports = 1_000_000n) =>
    prepareWalletCleanupBuy(
      { batchId, wallet: f.wallet, walletRevision: 1, mint: f.buy.mint, lamports },
      'key',
      AbortSignal.timeout(10000),
      f.fetcher,
      f.buy.deps,
    );
  it('buys the token back on the buyer with exactly the SOL the sell delivered', async () => {
    const f = cleanupFixture();
    const review = await buys(f);
    expect(review).toMatchObject({
      format: 'wallet-cleanup-buy-v1',
      mint: f.buy.mint,
      destination: f.buy.mint,
      decimals: 6,
      amountInLamports: '1000000',
      expectedOutRaw: '5',
      minimumOutRaw: '4',
    });
    expect(isCleanupBuy(review)).toBe(true);
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    await expect(
      inspectWalletCleanup(review, signed.transaction, true),
    ).resolves.toMatchObject({ signature: signed.signature });
    expect(cleanupTotals([review])).toMatchObject({
      buys: 1,
      minimumBuyOut: 4n,
    });
  });
  it('refuses a buy that spends more than the delivered SOL or simulates flat', async () => {
    const f = cleanupFixture();
    f.buy.simulation.nativeChangeRaw = '-9000000';
    await expect(buys(f)).rejects.toThrow(/did not spend/);
    f.buy.simulation.nativeChangeRaw = '0';
    await expect(buys(f)).rejects.toThrow(/did not spend/);
    f.buy.simulation.nativeChangeRaw = '-9000000';
    f.buy.simulation.inputAmountMatches = null;
    await expect(buys(f)).rejects.toThrow(/did not spend/);
    await expect(buys(f, 0n)).rejects.toThrow(/no SOL/);
  });
  it('decodes finalized buy receipts and refuses a short fill', async () => {
    const f = cleanupFixture();
    const review = await buys(f);
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [review],
      () => {},
    );
    const ok = await decodeWalletCleanupBuyReceipt(
      f.buy.receipt(signed.transaction),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(ok).toMatchObject({ kind: 'buy', boughtRaw: '5' });
    await expect(
      decodeWalletCleanupBuyReceipt(
        f.buy.receipt(signed.transaction, 0n),
        review,
        signed.signature,
        'rpc.test',
      ),
    ).rejects.toThrow(/less than the minimum/);
    const failed = await decodeWalletCleanupBuyReceipt(
      f.buy.receipt(signed.transaction, 0n, { InstructionError: [0, 'Custom'] }),
      review,
      signed.signature,
      'rpc.test',
    );
    expect(failed).toMatchObject({ failed: true });
  });
});
