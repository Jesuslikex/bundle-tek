import { describe, it, expect } from 'vitest';
import { recoverMessageAddress } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  createVault,
  generateVaultWallets,
  encryptVault,
  unlockVault,
} from './browser-wallet-vault';
import {
  ownershipMessage,
  validateOwnershipChallenge,
  type OwnershipChallenge,
} from './wallet-ownership-message';
import { signVaultOwnership } from './vault-ownership';
import type { LaunchChain } from './launch-plan';
import { EVM_NETWORKS } from './evm-network';
const origin = 'https://pulseforge.test';
function challenge(chain: LaunchChain, address: string): OwnershipChallenge {
  const id = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + 300_000).toISOString();
  return {
    id,
    chain,
    address,
    issuedAt,
    expiresAt,
    chainId: chain === 'Solana' ? null : EVM_NETWORKS[chain].id,
    message: ownershipMessage(origin, chain, address, id, issuedAt, expiresAt),
  };
}
describe('restricted vault ownership signing', () => {
  it('independently verifies a restored Solana vault signature over the exact ownership challenge', async () => {
    const initial = generateVaultWallets(
      await createVault('disposable test vault passphrase'),
      'solana',
      1,
    );
    const session = await unlockVault(
      await encryptVault(initial),
      'disposable test vault passphrase',
    );
    const wallet = session.payload.wallets[0];
    const value = challenge('Solana', wallet.address);
    const signature = await signVaultOwnership(
      session,
      wallet.id,
      'Solana',
      value,
      origin,
    );
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(value.message),
        bs58.decode(signature),
        bs58.decode(wallet.address),
      ),
    ).toBe(true);
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(value.message + '\nchanged'),
        bs58.decode(signature),
        bs58.decode(wallet.address),
      ),
    ).toBe(false);
  });
  it('recovers the correct EVM account for each network-bound message', async () => {
    const session = generateVaultWallets(
      await createVault('disposable test vault passphrase'),
      'evm',
      1,
    );
    const wallet = session.payload.wallets[0];
    for (const chain of Object.keys(
      EVM_NETWORKS,
    ) as (keyof typeof EVM_NETWORKS)[]) {
      const value = challenge(chain, wallet.address);
      const signature = await signVaultOwnership(
        session,
        wallet.id,
        chain,
        value,
        origin,
      );
      expect(
        await recoverMessageAddress({
          message: value.message,
          signature: signature as `0x${string}`,
        }),
      ).toBe(wallet.address);
    }
  });
  it('rejects arbitrary payloads, extra instructions and wrong site/address/network/chain IDs before signing', async () => {
    const session = generateVaultWallets(
      await createVault('disposable test vault passphrase'),
      'evm',
      1,
    );
    const wallet = session.payload.wallets[0];
    const value = challenge('Base', wallet.address);
    for (const invalid of [
      { ...value, message: 'Send ETH' },
      { ...value, message: value.message + '\nAuthorize transfer' },
      { ...value, chainId: 1 },
      { ...value, chain: 'Ethereum' },
      { ...value, address: '0x0000000000000000000000000000000000000001' },
    ]) {
      await expect(
        signVaultOwnership(session, wallet.id, 'Base', invalid, origin),
      ).rejects.toThrow('ownership message');
    }
    await expect(
      signVaultOwnership(
        session,
        wallet.id,
        'Base',
        value,
        'https://other.test',
      ),
    ).rejects.toThrow('ownership message');
    await expect(
      signVaultOwnership(session, wallet.id, 'Solana', value, origin),
    ).rejects.toThrow('network');
    await expect(
      signVaultOwnership(session, 'missing', 'Base', value, origin),
    ).rejects.toThrow('network');
  });
  it('rejects expired/future/noncanonical dates and an extended lifetime', async () => {
    const session = generateVaultWallets(
      await createVault('disposable test vault passphrase'),
      'evm',
      1,
    );
    const wallet = session.payload.wallets[0];
    const value = challenge('Base', wallet.address);
    expect(() =>
      validateOwnershipChallenge(
        value,
        origin,
        'Base',
        wallet.address,
        Date.parse(value.expiresAt),
      ),
    ).toThrow();
    expect(() =>
      validateOwnershipChallenge(
        value,
        origin,
        'Base',
        wallet.address,
        Date.parse(value.issuedAt) - 31_000,
      ),
    ).toThrow();
    for (const modified of [
      {
        ...value,
        expiresAt: new Date(Date.parse(value.issuedAt) + 600_000).toISOString(),
      },
      { ...value, issuedAt: 'invalid' },
      { ...value, id: 'invalid' },
    ]) {
      await expect(
        signVaultOwnership(session, wallet.id, 'Base', modified, origin),
      ).rejects.toThrow();
    }
  });
});
