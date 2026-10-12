import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import type { ImportedTokenProject } from './imported-token-project';
import {
  supplyTrackerHandoff,
  supplyTrackerWallets,
} from './supply-tracker-handoff';
import type { WorkspaceWallet } from './wallet-workspace';

const address = '11111111111111111111111111111111';
const project = {
  document: { token: { chain: 'Solana', address, name: 'Bundle token' } },
} as ImportedTokenProject;
describe('SupplyTracker scope handoff', () => {
  it('preserves exact mint and explicit groups without allowing labels to inject wallet lines', () => {
    const link = new URL(
      supplyTrackerHandoff(project, [
        { address, label: 'Treasury, external\nInjected', group: 'team' },
      ]),
    );
    expect(link.pathname).toBe('/solana.html');
    expect(link.searchParams.get('mint')).toBe(address);
    const rows = link.searchParams.get('wallets')!.split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].split(',').map((s) => s.trim())).toEqual([
      'Treasury  external Injected',
      address,
      'team',
    ]);
    expect(link.searchParams.has('token')).toBe(false);
  });
  it('uses the Robinhood JSON wallet contract and preserves external classification', () => {
    const token = '0x' + 'ab'.repeat(20);
    const evm = {
      document: { token: { chain: 'Robinhood', address: token, name: 'EVM' } },
    } as ImportedTokenProject;
    const link = new URL(
      supplyTrackerHandoff(evm, [
        { address: token, label: 'Outside', group: 'external' },
      ]),
    );
    expect(link.pathname).toBe('/robinhood.html');
    expect(link.searchParams.get('token')!.toLowerCase()).toBe(token);
    expect(JSON.parse(link.searchParams.get('wallets')!)[0].group).toBe(
      'external',
    );
    expect(link.searchParams.has('mint')).toBe(false);
    expect(() =>
      supplyTrackerHandoff(evm, [
        { address: token, label: 'A', group: 'team' },
        {
          address: getAddress(token),
          label: 'B',
          group: 'pool',
        },
      ]),
    ).toThrow('once');
  });
  it('excludes other networks and archived roster entries', () => {
    const wallets = [
      { address, chain: 'Solana', archived: false },
      { address, chain: 'Solana', archived: true },
      { address, chain: 'Base', archived: false },
    ] as WorkspaceWallet[];
    expect(supplyTrackerWallets(project, wallets)).toEqual([wallets[0]]);
  });
  it('refuses invalid addresses, duplicate scope, empty scope, over-limit scope and unsupported chains', () => {
    const w = { address, label: 'A', group: 'pool' as const };
    expect(() => supplyTrackerHandoff(project, [])).toThrow('1 to 100');
    expect(() => supplyTrackerHandoff(project, Array(101).fill(w))).toThrow(
      '1 to 100',
    );
    expect(() => supplyTrackerHandoff(project, [w, w])).toThrow('once');
    expect(() =>
      supplyTrackerHandoff(project, [{ ...w, address: 'invalid' }]),
    ).toThrow('valid');
    expect(() =>
      supplyTrackerHandoff(
        {
          document: { token: { ...project.document.token, chain: 'Base' } },
        } as ImportedTokenProject,
        [w],
      ),
    ).toThrow('supports');
  });
});
