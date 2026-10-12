import { it, expect } from 'vitest';
import bs58 from 'bs58';
import type { MintHoldingsSnapshot } from './wallet-mint-holdings';
import { importedMintInventory } from './imported-mint-inventory';
import { TOKEN_PROGRAMS } from './wallet-holdings';
const wallet = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2));
const fixture = (): MintHoldingsSnapshot => ({
  format: 'solana-mint-holdings-v1',
  scope: 'mint',
  chain: 'Solana',
  address: wallet,
  mint,
  program: TOKEN_PROGRAMS[0],
  decimals: 6,
  raw: '4003',
  frozenRaw: '1000',
  unfrozenRaw: '3003',
  amount: '0.004003',
  accounts: [3, 4].map((n, i) => ({
    address: bs58.encode(new Uint8Array(32).fill(n)),
    raw: i ? '3003' : '1000',
    frozen: !i,
    extensions: false,
    extensionTypes: [],
  })),
  accountCount: 2,
  mintSlot: 100,
  slots: [101, 102],
  slot: 102,
  observedAt: new Date().toISOString(),
  source: 'rpc.test',
  commitment: 'confirmed',
  mintExtensions: [],
});
it('projects complete mint coverage with an explicit scope and exact frozen/unfrozen amounts', () => {
  expect(
    importedMintInventory(fixture(), wallet, 1, mint, 6).observation,
  ).toMatchObject({
    scope: 'mint',
    raw: '4003',
    frozenRaw: '1000',
    unfrozenRaw: '3003',
    minSlot: 101,
    maxSlot: 102,
  });
});
it.each([
  'mint',
  'wallet',
  'scope',
  'count',
  'duplicate',
  'slot',
  'units',
  'frozen',
  'amount',
  'extension',
])('rejects altered persisted mint evidence: %s', (kind) => {
  const s = fixture();
  if (kind === 'mint') s.mint = wallet;
  if (kind === 'wallet') s.address = mint;
  if (kind === 'scope') (s as unknown as { scope: string }).scope = 'wallet';
  if (kind === 'count') s.accountCount++;
  if (kind === 'duplicate') s.accounts[1].address = s.accounts[0].address;
  if (kind === 'slot') s.slots[1] = 99;
  if (kind === 'units') s.raw = '4004';
  if (kind === 'frozen') s.frozenRaw = '999';
  if (kind === 'amount') s.amount = '4';
  if (kind === 'extension') s.accounts[0].extensions = true;
  expect(() => importedMintInventory(s, wallet, 1, mint, 6)).toThrow();
});
