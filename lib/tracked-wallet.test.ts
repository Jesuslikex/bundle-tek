import { expect, it } from 'vitest';
import {
  validateTrackedWallet,
  validateSolanaTrackedWallet,
  validateWalletBatch,
} from './tracked-wallet';
it('validates address families, checksums and network identity before persistence', () => {
  const address = '0x52908400098527886e0f7030069857d2e4169ee7';
  expect(
    validateTrackedWallet({ address, network: 'Ethereum', label: '' }).address,
  ).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
  expect(() =>
    validateTrackedWallet({
      address: '0x52908400098527886E0f7030069857D2E4169EE7',
      network: 'Base',
      label: '',
    }),
  ).toThrow('checksum');
  expect(() =>
    validateTrackedWallet({ address, network: 'mainnet', label: '' }),
  ).toThrow('Solana');
  expect(() =>
    validateTrackedWallet({
      address: '11111111111111111111111111111111',
      network: 'Ethereum',
      label: '',
    }),
  ).toThrow('EVM');
  expect(() =>
    validateSolanaTrackedWallet({ address, network: 'Ethereum', label: '' }),
  ).toThrow('Solana');
  expect(() =>
    validateWalletBatch([
      { address, network: 'Base', label: '' },
      {
        address: address.toUpperCase().replace('0X', '0x'),
        network: 'Base',
        label: '',
      },
    ]),
  ).toThrow('duplicate');
  expect(
    validateWalletBatch([
      { address, network: 'Base', label: '' },
      { address, network: 'Ethereum', label: '' },
    ]),
  ).toHaveLength(2);
});
