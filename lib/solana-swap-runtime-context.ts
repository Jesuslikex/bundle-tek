import type { PairMintMetadata } from './pair-mint-evidence';
import type { PairWalletEvidence } from './pair-wallet-evidence';
import type { SolanaPairPreparation } from './warmup-swap-quote';
/** Internal observed evidence only. This type grants no ownership, trusted policy or signing authority. */
export type SolanaSwapRuntimeAsset = Pick<
  PairMintMetadata,
  | 'address'
  | 'program'
  | 'decimals'
  | 'amountPolicy'
  | 'extensions'
  | 'issuerControls'
>;
export type SolanaSwapRuntimeReference = {
  side: 'Buy' | 'Sell';
  inputRaw: string;
  pair: {
    base: SolanaSwapRuntimeAsset;
    quote: SolanaSwapRuntimeAsset;
    mintPolicy: {
      slot: number;
      recheckSlot: number;
      baseSha256: string;
      quoteSha256: string;
      unixTimestamp: string;
      recheckUnixTimestamp: string;
    };
    sha256: string;
  };
  quote: Pick<SolanaPairPreparation, 'minimumOutAmount' | 'platformFee'>;
};
export type SolanaSwapRuntimeContext = {
  quote: SolanaSwapRuntimeReference;
  wallet: string;
  expiresAt: string;
  contextSha256: string;
  evidence: Pick<
    PairWalletEvidence,
    | 'slot'
    | 'accounts'
    | 'unixTimestamp'
    | 'nativeBalanceRaw'
    | 'systemRentMinimumRaw'
  >;
  funding: { userFeeAndRentLimitRaw: string };
};
