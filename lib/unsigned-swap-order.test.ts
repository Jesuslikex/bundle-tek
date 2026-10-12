import { expect, it, vi } from 'vitest';
import { solanaTransferMessage } from './solana-funding';
import { reviewUnsignedSwapOrder } from './unsigned-swap-order';
import { prepareSolanaSwap, WRAPPED_SOL } from './warmup-swap-quote';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const other = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const bytes = () =>
  Uint8Array.from([
    1,
    ...new Uint8Array(64),
    128,
    ...solanaTransferMessage(
      wallet,
      other,
      '11111111111111111111111111111111',
      1n,
    ),
    0,
  ]);
const wire = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const fixture = () => ({
  transaction: wire(bytes()),
  transactionVersion: 0,
  taker: wallet,
  gasless: false,
  signatureFeeLamports: 5000,
  signatureFeePayer: wallet,
  prioritizationFeeLamports: 0,
  prioritizationFeePayer: null,
  rentFeeLamports: 2039280,
  rentFeePayer: wallet,
  lastValidBlockHeight: '123456',
  inputMint: WRAPPED_SOL,
  outputMint: mint,
  inAmount: '1000000',
  outAmount: '1000',
  otherAmountThreshold: '995',
  swapMode: 'ExactIn',
  slippageBps: 50,
  router: 'metis',
  requestId: 'must-be-stripped',
});
it('reviews a real decoded unsigned v0 envelope without claiming its transfer instructions are a swap', async () => {
  const result = await reviewUnsignedSwapOrder(fixture(), wallet);
  expect(result).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    wallet,
    instructionCount: 1,
    lookupTableCount: 0,
    estimatedFeesLamports: '2044280',
  });
  expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.instructionReview.instructions[0]).toMatchObject({
    action: 'Native SOL transfer',
    amountRaw: '1',
    recognized: true,
  });
  expect(result.instructionReview.instructionsVerified).toBe(false);
  expect(result).not.toHaveProperty('requestId');
});
it('rejects wrong signer, sponsored fees, signatures and malformed transaction envelopes', async () => {
  for (const patch of [
    { taker: other },
    { gasless: true },
    { transactionVersion: 1 },
    { signatureFeePayer: other },
    { rentFeeLamports: -1 },
    { rentFeeLamports: 9007199254740992 },
    { lastValidBlockHeight: '1e6' },
    { transaction: 'garbage' },
  ])
    await expect(
      reviewUnsignedSwapOrder({ ...fixture(), ...patch }, wallet),
    ).rejects.toThrow();
  await expect(
    reviewUnsignedSwapOrder({ ...fixture(), taker: other }, other),
  ).rejects.toThrow();
  const signed = bytes();
  signed[1] = 1;
  await expect(
    reviewUnsignedSwapOrder(
      { ...fixture(), transaction: wire(signed) },
      wallet,
    ),
  ).rejects.toThrow();
  await expect(
    reviewUnsignedSwapOrder(
      { ...fixture(), transaction: wire(Uint8Array.from([...bytes(), 0])) },
      wallet,
    ),
  ).rejects.toThrow();
});
it('requests a wallet-bound exact order without execute or referral parameters', async () => {
  const fetcher = vi.fn(async (_url: unknown) => Response.json(fixture()));
  const result = await prepareSolanaSwap(
    { tokenMint: mint, side: 'Buy', amount: '0.001', decimals: 6, wallet },
    'key',
    AbortSignal.timeout(1000),
    fetcher as typeof fetch,
  );
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.pathname).toBe('/swap/v2/order');
  expect(url.searchParams.get('taker')).toBe(wallet);
  expect(url.searchParams.get('maxSupportedTransactionVersion')).toBe('0');
  expect(url.searchParams.has('referralAccount')).toBe(false);
  expect(result.preparation.instructionsVerified).toBe(false);
  expect(result).not.toHaveProperty('requestId');
});
