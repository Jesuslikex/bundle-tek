import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  receiptWallet as wallet,
  receiptRecipient as recipient,
  receiptMint as mint,
} from '../test/devnet-receipt-fixture';
import { reviewDevnetTokenFunding } from './devnet-token-funding';
import { savedFundingIntent, fundingLink } from './devnet-saved-funding';
import { nativeFundingDocument } from '../test/devnet-receipt-fixture';
const account = (bytes: Uint8Array) => ({
  owner: TOKEN_PROGRAM_ADDRESS,
  executable: false,
  data: [Buffer.from(bytes).toString('base64'), 'base64'] as const,
  lamports: 2039280n,
});
function fixture() {
  const mintBytes = new Uint8Array(82);
  mintBytes[44] = 6;
  mintBytes[45] = 1;
  const source = new Uint8Array(165);
  source.set(bs58.decode(mint));
  source.set(bs58.decode(wallet), 32);
  source[108] = 1;
  new DataView(source.buffer).setBigUint64(64, 9007199254740993000n, true);
  return {
    wallet,
    mint,
    decimals: 6,
    remaining: [{ address: recipient, amount: '0.300001' }],
    accounts: [
      account(mintBytes),
      account(source),
      null,
      {
        owner: '11111111111111111111111111111111',
        executable: false,
        data: ['', 'base64'] as const,
        lamports: 1000000000n,
      },
    ],
    balance: 1000000000n,
    rent: 2039280n,
    slots: [100n, 101n],
  };
}
it('reviews exact SPL units and conservatively budgets account creation without Number rounding', () => {
  expect(reviewDevnetTokenFunding(fixture())).toEqual({
    requiredTokens: 300001n,
    tokenBalance: 9007199254740993000n,
    requiredSol: 4084960n,
  });
});
it('holds unsupported, missing, frozen, mismatched and stale token snapshots', () => {
  for (const index of [0, 1]) {
    const input = fixture();
    input.accounts[index] = null;
    expect(() => reviewDevnetTokenFunding(input)).toThrow();
  }
  const frozen = fixture();
  const data = Buffer.from(frozen.accounts[1]!.data[0], 'base64');
  data[108] = 2;
  frozen.accounts[1] = account(data);
  expect(() => reviewDevnetTokenFunding(frozen)).toThrow('unfrozen');
  expect(() => reviewDevnetTokenFunding({ ...fixture(), decimals: 9 })).toThrow(
    'decimals',
  );
  expect(() =>
    reviewDevnetTokenFunding({ ...fixture(), slots: [100n, 251n] }),
  ).toThrow('inconsistent');
  const short = fixture();
  short.balance = 1n;
  short.accounts[3]!.lamports = 1n;
  expect(() => reviewDevnetTokenFunding(short)).toThrow('Insufficient');
  expect(() =>
    reviewDevnetTokenFunding({
      ...fixture(),
      remaining: [{ address: recipient, amount: '9999999999999' }],
    }),
  ).toThrow();
});
it('retains per-recipient funding fingerprints across revision changes but distinguishes mint and amount', async () => {
  const input = {
    ...nativeFundingDocument,
    currency: 'USDC',
    assetAddress: mint,
    recipients: [{ address: recipient, amount: '0.300001' }],
  };
  const first = fundingLink(
    await savedFundingIntent(input, 'funding-test', 1, recipient),
  );
  expect(
    fundingLink(
      await savedFundingIntent(
        { ...input, name: 'renamed' },
        'funding-test',
        2,
        recipient,
      ),
    )?.key,
  ).toBe(first?.key);
  expect(
    fundingLink(
      await savedFundingIntent(
        { ...input, recipients: [{ address: recipient, amount: '0.3' }] },
        'funding-test',
        2,
        recipient,
      ),
    )?.key,
  ).not.toBe(first?.key);
  expect(
    fundingLink(
      await savedFundingIntent(
        {
          ...input,
          currency: 'SOL',
          assetAddress: 'So11111111111111111111111111111111111111112',
        },
        'funding-test',
        2,
        recipient,
      ),
    )?.key,
  ).not.toBe(first?.key);
});
