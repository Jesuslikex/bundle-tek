import { describe, it, expect, vi } from 'vitest';
import { toHex } from 'viem';
import {
  connectEvmWallet,
  signOwnershipMessage,
  walletError,
  type BrowserWalletProvider,
} from './evm-wallet';
import { EVM_NETWORKS, type EvmChain } from './evm-network';
const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const signature = `0x${'11'.repeat(65)}`;
function provider(chain: EvmChain = 'Base') {
  const request = vi.fn(async ({ method }: { method: string }) =>
    method === 'eth_chainId'
      ? `0x${EVM_NETWORKS[chain].id.toString(16)}`
      : method === 'personal_sign'
        ? signature
        : [address],
  );
  return { request } as BrowserWalletProvider & { request: typeof request };
}
describe('external EVM wallet protocol', () => {
  it('connects all five networks using account requests only', async () => {
    for (const chain of Object.keys(EVM_NETWORKS) as EvmChain[]) {
      const p = provider(chain);
      expect(await connectEvmWallet(p, chain)).toBe(address);
      expect(p.request.mock.calls.map(([r]) => r.method)).toEqual([
        'eth_chainId',
        'eth_requestAccounts',
        'eth_chainId',
        'eth_accounts',
      ]);
    }
  });
  it('rejects the wrong network before requesting account permission', async () => {
    const p = provider();
    await expect(connectEvmWallet(p, 'Arc')).rejects.toThrow('5042');
    expect(p.request).toHaveBeenCalledTimes(1);
  });
  it('rejects changes during account permission', async () => {
    const p = provider();
    p.request
      .mockImplementationOnce(async () => '0x2105')
      .mockImplementationOnce(async () => [address])
      .mockImplementationOnce(async () => '0x1');
    await expect(connectEvmWallet(p, 'Base')).rejects.toThrow('Switch');
  });
  it('signs UTF8 ownership text and rechecks network/account afterward', async () => {
    const p = provider(),
      message = 'Ownership only\nNot a transaction ✓';
    expect(await signOwnershipMessage(p, 'Base', address, message)).toBe(
      signature,
    );
    expect(p.request.mock.calls.map(([r]) => r.method)).toEqual([
      'eth_chainId',
      'eth_accounts',
      'personal_sign',
      'eth_chainId',
      'eth_accounts',
    ]);
    expect(p.request).toHaveBeenCalledWith({
      method: 'personal_sign',
      params: [toHex(message), address],
    });
  });
  it('never signs after account changes and discards a result if accounts change during signing', async () => {
    const p = provider();
    p.request.mockImplementation(async ({ method }) =>
      method === 'eth_chainId' ? '0x2105' : [other],
    );
    await expect(
      signOwnershipMessage(p, 'Base', address, 'Ownership'),
    ).rejects.toThrow('account changed');
    expect(
      p.request.mock.calls.some(([r]) => r.method === 'personal_sign'),
    ).toBe(false);
    let signed = false;
    p.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'personal_sign') {
        signed = true;
        return signature;
      }
      return signed ? [other] : [address];
    });
    await expect(
      signOwnershipMessage(p, 'Base', address, 'Ownership'),
    ).rejects.toThrow('account changed');
  });
  it('rejects unsupported signatures and makes declines understandable', async () => {
    const p = provider();
    p.request.mockImplementation(async ({ method }) =>
      method === 'eth_chainId'
        ? '0x2105'
        : method === 'personal_sign'
          ? '0x1234'
          : [address],
    );
    await expect(
      signOwnershipMessage(p, 'Base', address, 'Ownership'),
    ).rejects.toThrow('unsupported');
    expect(walletError({ code: 4001 })).toBe('Wallet request declined.');
  });
  it('does not request permission or sign after the view is cancelled', async () => {
    const p = provider();
    await expect(connectEvmWallet(p, 'Base', () => false)).rejects.toThrow(
      'cancelled',
    );
    expect(p.request).toHaveBeenCalledTimes(1);
    p.request.mockClear();
    await expect(
      signOwnershipMessage(p, 'Base', address, 'Ownership', () => false),
    ).rejects.toThrow('cancelled');
    expect(
      p.request.mock.calls.some(([r]) => r.method === 'personal_sign'),
    ).toBe(false);
  });
});
