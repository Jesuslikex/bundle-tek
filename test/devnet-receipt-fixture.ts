import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { address } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
export const receiptKeyPair = nacl.sign.keyPair.fromSeed(
  new Uint8Array(32).fill(7),
);
export const receiptWallet = bs58.encode(receiptKeyPair.publicKey);
export const receiptRecipient = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
);
export const receiptMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const receiptSignature = bs58.encode(new Uint8Array(64).fill(9));
export const receiptClaim = {
  wallet: receiptWallet,
  mint: receiptMint,
  recipients: [{ address: receiptRecipient, amount: '0.300000001' }],
};
export async function tokenReceiptFixture() {
  const [source] = await findAssociatedTokenPda({
    owner: address(receiptWallet),
    mint: address(receiptMint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destination] = await findAssociatedTokenPda({
    owner: address(receiptRecipient),
    mint: address(receiptMint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const balance = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex,
    owner,
    mint: receiptMint,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: { amount, decimals: 9, uiAmount: null },
  });
  return {
    slot: 12345,
    blockTime: Math.floor(Date.now() / 1000) - 60,
    meta: {
      err: null,
      preTokenBalances: [
        balance(1, receiptWallet, '1000000000'),
        balance(2, receiptRecipient, '0'),
      ],
      postTokenBalances: [
        balance(1, receiptWallet, '699999999'),
        balance(2, receiptRecipient, '300000001'),
      ],
    },
    transaction: {
      signatures: [receiptSignature],
      message: {
        accountKeys: [
          { pubkey: receiptWallet, signer: true, writable: true },
          { pubkey: source, signer: false, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [
          {
            programId: TOKEN_PROGRAM_ADDRESS,
            parsed: {
              type: 'transferChecked',
              info: {
                authority: receiptWallet,
                mint: receiptMint,
                source,
                destination,
                tokenAmount: { amount: '300000001', decimals: 9 },
              },
            },
          },
        ],
      },
    },
  };
}
export const nativeFundingInput = {
  kind: 'sol' as const,
  wallet: receiptWallet,
  fundingId: 'funding-test',
  fundingRevision: 1,
  recipient: receiptRecipient,
  amount: '0.300000001',
};
export const nativeFundingDocument = {
  name: 'Native funding QA',
  chain: 'Solana',
  currency: 'SOL',
  source: 'Wallet',
  sourceLabel: '',
  funderAddress: receiptWallet,
  startAt: '2020-01-01T00:00:00.000Z',
  delaySeconds: 0,
  recipients: [{ address: receiptRecipient, amount: '0.300000001' }],
};
export function nativeReceiptFixture(failed = false) {
  return {
    slot: 12345,
    blockTime: Math.floor(Date.now() / 1000) - 60,
    meta: {
      err: failed ? { InstructionError: [0, { Custom: 1 }] } : null,
      fee: '5000',
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
      preBalances: ['1000000000', '0', '1'],
      postBalances: failed
        ? ['999995000', '0', '1']
        : ['699994999', '300000001', '1'],
    },
    transaction: {
      signatures: [receiptSignature],
      message: {
        accountKeys: [
          { pubkey: receiptWallet, signer: true, writable: true },
          { pubkey: receiptRecipient, signer: false, writable: true },
          {
            pubkey: '11111111111111111111111111111111',
            signer: false,
            writable: false,
          },
        ],
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: receiptWallet,
                destination: receiptRecipient,
                lamports: '300000001',
              },
            },
          },
        ],
      },
    },
  };
}
export function memoReceiptFixture() {
  return {
    slot: 12345,
    blockTime: Math.floor(Date.now() / 1000) - 60,
    meta: { err: null },
    transaction: {
      signatures: [receiptSignature],
      message: {
        accountKeys: [{ pubkey: receiptWallet, signer: true }],
        instructions: [
          {
            programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            parsed: 'PulseForge verified devnet wallet 2026-10-10T00:00:00Z',
          },
        ],
      },
    },
  };
}

export function failedMemoReceiptFixture() {
  const tx = memoReceiptFixture();
  return {
    ...tx,
    meta: {
      err: { InstructionError: [0, 'ComputationalBudgetExceeded'] },
      fee: 5000,
      preBalances: [1000000],
      postBalances: [995000],
    },
  };
}
export async function failedTokenReceiptFixture() {
  const tx = await tokenReceiptFixture();
  return {
    ...tx,
    meta: {
      ...tx.meta,
      err: { InstructionError: [0, { Custom: 1 }] },
      fee: 5000,
      preBalances: [1000000, 2039280, 2039280],
      postBalances: [995000, 2039280, 2039280],
      postTokenBalances: structuredClone(tx.meta.preTokenBalances),
    },
  };
}
