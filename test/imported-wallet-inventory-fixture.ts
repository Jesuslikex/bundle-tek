import type { HoldingsSnapshot } from '../lib/wallet-holdings';
import {
  acquisitionWallet,
  acquisitionMint,
} from './imported-sell-acquisition-fixture';
export function inventoryFixture(): HoldingsSnapshot {
  return {
    chain: 'Solana',
    address: acquisitionWallet,
    holdings: [
      {
        mint: acquisitionMint,
        program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        raw: '4003',
        amount: '0.004003',
        decimals: 6,
        accounts: [
          {
            address: 'public-account-a',
            raw: '1000',
            frozen: true,
            extensions: false,
          },
          {
            address: 'public-account-b',
            raw: '3003',
            frozen: false,
            extensions: false,
          },
        ],
      },
    ],
    accountCount: 2,
    slots: [
      { program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', slot: 100 },
      { program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', slot: 101 },
    ],
    minSlot: 100,
    maxSlot: 101,
    observedAt: '2026-10-11T00:00:00Z',
    source: 'fixture.test',
    commitment: 'confirmed',
  };
}
