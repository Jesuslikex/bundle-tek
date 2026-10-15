import { address } from '@solana/kit';
import { pairQuoteMint } from './imported-pair-quote-fixture';
import { pairWalletTokenAccount } from './pair-wallet-fixture';
import type { pairOrderFixture } from './pair-order-fixture';
import { inspectPairMintAccount } from '../lib/pair-mint-evidence';
import { pairAssociatedAddress } from '../lib/pair-wallet-evidence';
import { SWAP_TOKEN } from '../lib/swap-token-program-evidence';
/** Add a wallet-controlled canonical USDC intermediate to a real encoded route fixture. */
export async function pairIntermediate(
  f: Awaited<ReturnType<typeof pairOrderFixture>>,
) {
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rawMint = pairQuoteMint(6, SWAP_TOKEN);
  const metadata = await inspectPairMintAccount(rawMint, mint),
    key = await pairAssociatedAddress(metadata, f.wallet);
  const prior = pairWalletTokenAccount(mint, f.wallet, SWAP_TOKEN, '50000000');
  f.orderState.auxiliaryMints.set(mint, rawMint);
  f.orderState.otherAccounts.set(key, prior);
  f.orderState.transform = (m) => {
    m.staticAccounts.splice(3, 0, address(key));
    m.instructions = m.instructions.map((ix) => ({
      ...ix,
      programAddressIndex:
        ix.programAddressIndex >= 3
          ? ix.programAddressIndex + 1
          : ix.programAddressIndex,
      accountIndices: ix.accountIndices?.map((i) => (i >= 3 ? i + 1 : i)),
    }));
    for (const value of [mint, SWAP_TOKEN])
      if (!m.staticAccounts.includes(address(value))) {
        m.staticAccounts.push(address(value));
        m.header.numReadonlyNonSignerAccounts++;
      }
    m.instructions[0].accountIndices!.push(
      3,
      ...[mint, SWAP_TOKEN].map((value) =>
        m.staticAccounts.indexOf(address(value)),
      ),
    );
    return m;
  };
  return { key, mint, prior };
}
