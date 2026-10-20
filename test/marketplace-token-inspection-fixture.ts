import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  getTokenEncoder,
  AccountState,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import { marketplaceOwnedFixture } from './marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import { MARKETPLACE_TOKEN_PROGRAMS } from '@/lib/marketplace-token-inspection-view';
/** Public synthetic accounts encoded with the official SDK; no private keys or provider calls. */
export function marketplaceTokenInspectionFixture(now = Date.now()) {
  const source = marketplaceOwnedFixture(now),
    inventory = buildMarketplaceOwnedInventory(source.sources, now);
  const selection = {
    address: source.a,
    walletRevision: 2,
    priceLamports: '50000000',
  };
  const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  function account(
    options: {
      id?: number;
      program?: (typeof MARKETPLACE_TOKEN_PROGRAMS)[number];
      amount?: bigint;
      owner?: string;
      delegate?: string | null;
      delegatedAmount?: bigint;
      closeAuthority?: string | null;
      nativeReserve?: bigint | null;
      frozen?: boolean;
      extensions?: ExtensionArgs[];
    } = {},
  ) {
    const program = options.program ?? MARKETPLACE_TOKEN_PROGRAMS[0];
    const bytes = Uint8Array.from(
      getTokenEncoder().encode({
        mint: address(key(7)),
        owner: address(options.owner ?? source.a),
        amount: options.amount ?? 100n,
        delegate:
          options.delegate === undefined || options.delegate === null
            ? null
            : address(options.delegate),
        delegatedAmount: options.delegatedAmount ?? 0n,
        closeAuthority:
          options.closeAuthority === undefined ||
          options.closeAuthority === null
            ? null
            : address(options.closeAuthority),
        isNative: options.nativeReserve ?? null,
        state: options.frozen ? AccountState.Frozen : AccountState.Initialized,
        extensions: options.extensions?.length ? options.extensions : null,
      }),
    );
    const raw = {
      pubkey: key(options.id ?? 3),
      account: {
        owner: program,
        executable: false,
        lamports: '2039280',
        space: String(bytes.length),
        data: [btoa(String.fromCharCode(...bytes)), 'base64'],
      },
    };
    return {
      raw,
      bytes,
      rewrite() {
        raw.account.data[0] = btoa(String.fromCharCode(...bytes));
        return raw;
      },
    };
  }
  return { source, inventory, selection, account, key };
}
