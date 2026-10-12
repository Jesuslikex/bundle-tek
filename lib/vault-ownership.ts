import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import type { VaultSession } from './browser-wallet-vault';
import type { LaunchChain } from './launch-plan';
import { validateOwnershipChallenge } from './wallet-ownership-message';

// Only a canonical, origin/network/address-bound ownership challenge is signable.
// No transaction, raw-payload or arbitrary-message entry point is exposed.
export async function signVaultOwnership(
  session: VaultSession,
  walletId: string,
  chain: LaunchChain,
  value: unknown,
  origin: string,
  now = Date.now(),
): Promise<string> {
  const wallet = session.payload.wallets.find(
    (wallet) => wallet.id === walletId,
  );
  if (!wallet || wallet.family !== (chain === 'Solana' ? 'solana' : 'evm'))
    throw new Error('Choose a vault key for this network.');
  const challenge = validateOwnershipChallenge(
    value,
    origin,
    chain,
    wallet.address,
    now,
  );
  if (!/^[0-9a-f]{64}$/.test(wallet.seed))
    throw new Error('Vault key is invalid.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (part) =>
    parseInt(part, 16),
  );
  try {
    if (wallet.family === 'evm') {
      const account = privateKeyToAccount(`0x${wallet.seed}`);
      if (account.address !== wallet.address) throw new Error();
      return await account.signMessage({ message: challenge.message });
    }
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      if (bs58.encode(pair.publicKey) !== wallet.address) throw new Error();
      return bs58.encode(
        nacl.sign.detached(
          new TextEncoder().encode(challenge.message),
          pair.secretKey,
        ),
      );
    } finally {
      pair.secretKey.fill(0);
    }
  } catch {
    throw new Error('Vault ownership signing failed.');
  } finally {
    seed.fill(0);
  }
}
