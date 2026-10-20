import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { solanaTransferMessage } from '@/lib/solana-funding';
import { preparationHistoryFixture } from './imported-preparation-history-fixture';
import {
  decodeWarmupBuyReceipt,
  decodeWarmupReceipt,
  type SavedWarmupBuyReceipt,
} from '@/lib/warmup-buy-receipt';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import type { WarmupSigningReview } from '@/lib/warmup-signing';
import { warmupBuyLink } from '@/lib/warmup-buy-link';
/** Synthetic signed transfer envelopes with controlled token balance metadata, NOT a live DEX or funded swap. */
export async function warmupSessionSettlementFixture() {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  try {
    const wallet = bs58.encode(pair.publicKey),
      mint = bs58.encode(new Uint8Array(32).fill(3)),
      account = bs58.encode(new Uint8Array(32).fill(2));
    const wrap = 'So11111111111111111111111111111111111111112';
    const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    async function make(side: 'Buy' | 'Sell', n: number) {
      const message = Uint8Array.from([
        128,
        ...solanaTransferMessage(
          wallet,
          account,
          '11111111111111111111111111111111',
          BigInt(n),
        ),
        0,
      ]);
      const sig = nacl.sign.detached(message, pair.secretKey),
        signature = bs58.encode(sig);
      const unsigned = Uint8Array.from([1, ...new Uint8Array(64), ...message]),
        signed = Uint8Array.from([1, ...sig, ...message]);
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', unsigned.buffer)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      const preparation: SavedWarmupPreparation = {
        id: id(n),
        planId: 'synthetic-settlement',
        planRevision: 1,
        walletRevision: 1,
        cycle: 1,
        createdAt: new Date().toISOString(),
        document: {
          ...preparationHistoryFixture(),
          side,
          wallet,
          inputMint: side === 'Buy' ? wrap : mint,
          outputMint: side === 'Sell' ? wrap : mint,
          inAmountRaw: side === 'Buy' ? '1000000' : '101',
          minimumOutRaw: side === 'Buy' ? '100' : '900000',
          transaction: {
            ...preparationHistoryFixture().transaction,
            sha256: sha,
            bytes: unsigned.length,
            instructionCount: 1,
          },
          inventory: null,
        },
      };
      const approval: WarmupSigningReview = {
        id: id(n + 10),
        preparationId: preparation.id,
        wallet,
        sha256: sha,
        network: 'mainnet',
        expiresAt: preparation.document.expiresAt,
        maximumFeeLamports: '5000',
        inputRaw: preparation.document.inAmountRaw,
        minimumOutputRaw: preparation.document.minimumOutRaw,
        inputMint: preparation.document.inputMint,
        outputMint: preparation.document.outputMint,
        transaction: wire(unsigned),
        lastValidBlockHeight: '200',
      };
      const balance = (amount: string) => ({
        accountIndex: '1',
        mint,
        owner: wallet,
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: { amount, decimals: '6' },
      });
      const raw = {
        version: '0',
        slot: String(299 + n),
        blockTime: null,
        transaction: [wire(signed), 'base64'],
        meta: {
          err: null,
          fee: '5000',
          loadedAddresses: { writable: [], readonly: [] },
          preBalances: ['10000000', '1', '1'],
          postBalances: [side === 'Buy' ? '8995000' : '10895000', '1', '1'],
          preTokenBalances: [balance(side === 'Buy' ? '0' : '101')],
          postTokenBalances: [balance(side === 'Buy' ? '101' : '0')],
        },
      };
      return { preparation, approval, signature, raw, receiptId: id(n + 20) };
    }
    const buy = await make('Buy', 1);
    const buyDocument = {
      ...(await decodeWarmupBuyReceipt(
        buy.raw,
        buy.preparation,
        buy.signature,
      )),
      observedAt: new Date().toISOString(),
      source: 'synthetic.test',
    };
    const savedBuy: SavedWarmupBuyReceipt = {
      id: buy.receiptId,
      preparationId: buy.preparation.id,
      planId: buy.preparation.planId,
      planRevision: 1,
      cycle: 1,
      walletRevision: 1,
      createdAt: new Date().toISOString(),
      document: buyDocument,
    };
    const sell = await make('Sell', 2);
    sell.preparation.document.buyReceipt = warmupBuyLink(savedBuy, {
      planId: savedBuy.planId,
      planRevision: 1,
      walletRevision: 1,
      wallet,
      mint,
      cycle: 1,
    });
    sell.approval.buyReceipt = structuredClone(
      sell.preparation.document.buyReceipt,
    );
    const { acquiredRaw: consumedRaw, ...core } = await decodeWarmupReceipt(
      sell.raw,
      sell.preparation,
      sell.signature,
      'Sell',
      sell.approval,
    );
    const sellDocument = {
      ...core,
      consumedRaw,
      buyReceiptId: buy.receiptId,
      observedAt: new Date().toISOString(),
      source: 'synthetic.test',
      limitations: 'Synthetic finalized sell fixture.',
    };
    return { wallet, mint, buy, sell, buyDocument, sellDocument };
  } finally {
    pair.secretKey.fill(0);
  }
}
