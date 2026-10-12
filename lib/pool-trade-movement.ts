import type { PoolTrade } from './pool-trades';
import bs58 from 'bs58';
import {
  requireMovementClassification,
  type WalletMovementClassification,
} from './wallet-movement-classification';
import { walletAddress } from './wallet-workspace';
export type PoolTradeMovementContext = {
  projectId: string;
  revision: number;
  pool: string;
  mint: string;
  decimals: number;
  tapeObservedAt: string;
  trade: PoolTrade;
};
export type PoolTradeMovement = {
  format: 'pool-trade-movement-v1';
  executionAllowed: false;
  projectId: string;
  revision: number;
  pool: string;
  mint: string;
  wallet: string;
  signature: string;
  tradeId: string;
  tapeObservedAt: string;
  slot: number;
  providerBlock: number;
  blockAgrees: boolean;
  blockTime: number | null;
  commitment: 'confirmed';
  failed: boolean;
  walletSigner: boolean;
  providerSide: 'Buy' | 'Sell';
  sideAgrees: boolean | null;
  tokenChange: {
    beforeRaw: string;
    afterRaw: string;
    changeRaw: string;
    decimals: number;
  } | null;
  classification: WalletMovementClassification;
  observedAt: string;
  source: string;
};
export function requirePoolTradeMovement(
  value: PoolTradeMovement,
  context: PoolTradeMovementContext,
) {
  if (
    !value ||
    value.format !== 'pool-trade-movement-v1' ||
    value.executionAllowed !== false ||
    value.projectId !== context.projectId ||
    value.revision !== context.revision ||
    value.pool !== context.pool ||
    value.mint !== context.mint ||
    value.wallet !== context.trade.sender ||
    value.signature !== context.trade.transaction ||
    value.tradeId !== context.trade.id ||
    value.tapeObservedAt !== context.tapeObservedAt ||
    value.providerSide !== context.trade.side ||
    value.providerBlock !== context.trade.block ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    value.commitment !== 'confirmed' ||
    typeof value.failed !== 'boolean' ||
    typeof value.walletSigner !== 'boolean' ||
    (value.blockTime !== null &&
      (!Number.isSafeInteger(value.blockTime) || value.blockTime < 0)) ||
    value.blockAgrees !== (value.slot === value.providerBlock) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.source !== 'string' ||
    !/^[a-z0-9.-]{1,253}$/.test(value.source)
  )
    throw new Error('On-chain movement context differs.');
  walletAddress(value.wallet, 'Solana');
  walletAddress(value.mint, 'Solana');
  if (value.signature.length > 88 || bs58.decode(value.signature).length !== 64)
    throw new Error('Invalid transaction signature.');
  if (value.tokenChange) {
    const t = value.tokenChange;
    if (
      t.decimals !== context.decimals ||
      !/^(0|[1-9]\d{0,19})$/.test(t.beforeRaw) ||
      !/^(0|[1-9]\d{0,19})$/.test(t.afterRaw) ||
      !/^-?(0|[1-9]\d{0,19})$/.test(t.changeRaw) ||
      BigInt(t.afterRaw) - BigInt(t.beforeRaw) !== BigInt(t.changeRaw) ||
      BigInt(t.beforeRaw) > (1n << 64n) - 1n ||
      BigInt(t.afterRaw) > (1n << 64n) - 1n
    )
      throw new Error('On-chain token change differs.');
  }
  requireMovementClassification(
    value.classification,
    value.tokenChange?.changeRaw ?? '0',
  );
  const knownSide = ['buy', 'sell'].includes(value.classification.kind);
  if (
    value.sideAgrees !==
      (knownSide
        ? value.classification.kind === value.providerSide.toLowerCase()
        : null) ||
    ((!value.tokenChange || value.failed) &&
      value.classification.kind !== 'unknown') ||
    (knownSide && !value.walletSigner)
  )
    throw new Error('On-chain classification evidence differs.');
  return value;
}
