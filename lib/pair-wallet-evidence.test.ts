import { afterEach, expect, it } from 'vitest';
import {
  pairWalletFixture,
  pairWalletTokenAccount,
} from '../test/pair-wallet-fixture';
import {
  readPairWalletEvidence,
  assessPairWalletFunding,
  assertStablePairWalletEvidence,
  requiredPairAccountExtensions,
} from './pair-wallet-evidence';
import { quoteOwnedImportedPair } from './imported-pair-quote-service';
import { SWAP_TOKEN } from './swap-token-program-evidence';
import { readPairMintEvidence } from './pair-mint-evidence';
import { pairQuoteMint } from '../test/imported-pair-quote-fixture';
import { address } from '@solana/kit';
let f: Awaited<ReturnType<typeof pairWalletFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const read = (v: NonNullable<typeof f>) =>
  readPairWalletEvidence(v.mintEvidence, v.wallet, v.rpc, v.clock.now);
function mutate(
  v: NonNullable<typeof f>,
  index: number,
  edit: (b: Uint8Array, d: DataView) => void,
) {
  const raw = v.accounts[index]!,
    bytes = Uint8Array.from(atob(raw.data[0]), (c) => c.charCodeAt(0));
  edit(bytes, new DataView(bytes.buffer));
  raw.data[0] = btoa(String.fromCharCode(...bytes));
}
it('checks actual stock-required account extensions and independent scaled/raw balances', async () => {
  f = await pairWalletFixture();
  const evidence = await read(f);
  expect(
    requiredPairAccountExtensions(f.mintEvidence.mints[1]).map((e) => e.__kind),
  ).toEqual(['ImmutableOwner', 'PausableAccount', 'TransferHookAccount']);
  expect(evidence).toMatchObject({
    scope: 'canonical-associated-accounts',
    nativeBalanceRaw: '1000000000',
    accounts: [
      {
        mint: f.baseMint,
        status: 'Ready',
        amountRaw: '20000000',
        amount: '20',
      },
      {
        mint: f.asset.address,
        status: 'Ready',
        byteLength: 179,
        expectedByteLength: 179,
        amountRaw: '500000000',
        amount: '5',
      },
    ],
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(f.rpc).toHaveBeenCalledWith('getMinimumBalanceForRentExemption', [
    179,
    { commitment: 'confirmed' },
  ]);
});
it('displays a non-unit scale from raw account units without changing raw spendable balance', async () => {
  f = await pairWalletFixture();
  f.mints[1] = pairQuoteMint(8, f.mints[1].owner, [
    {
      __kind: 'ScaledUiAmountConfig',
      authority: address('11111111111111111111111111111111'),
      multiplier: 2,
      newMultiplier: 2,
      newMultiplierEffectiveTimestamp: 0n,
    },
  ]);
  f.mintEvidence = await readPairMintEvidence(
    { inputMint: f.baseMint, outputMint: f.asset.address },
    100,
    f.rpc,
    f.clock.now,
  );
  f.accounts[1] = pairWalletTokenAccount(
    f.asset.address,
    f.wallet,
    f.mintEvidence.mints[1].program,
    '500000000',
    [{ __kind: 'ImmutableOwner' }],
  );
  const e = await read(f);
  expect(e.accounts[1]).toMatchObject({
    amountRaw: '500000000',
    spendableRaw: '500000000',
    amount: '10',
  });
});
it.each(['zero', 'invalid'] as const)(
  'rejects %s rent evidence instead of reporting sufficient reserves',
  async (mode) => {
    f = await pairWalletFixture();
    f.state.rentBySize.set(179, mode === 'zero' ? '0' : '-1');
    await expect(read(f)).rejects.toThrow();
  },
);
it.each([
  'frozen',
  'delegate',
  'close-authority',
  'uninitialized',
  'below-rent',
] as const)('withholds spendable units for %s custody', async (mode) => {
  f = await pairWalletFixture();
  mutate(f, 1, (b, v) => {
    if (mode === 'frozen') b[108] = 2;
    if (mode === 'uninitialized') b[108] = 0;
    if (mode === 'delegate') v.setUint32(72, 1, true);
    if (mode === 'close-authority') v.setUint32(129, 1, true);
  });
  if (mode === 'below-rent') f.accounts[1]!.lamports = '1';
  const evidence = await read(f);
  expect(evidence.accounts[1].spendableRaw).toBe('0');
  expect(evidence.accounts[1].status).not.toBe('Ready');
});
it('reports missing required setup instead of admitting a bare Token-2022 account', async () => {
  f = await pairWalletFixture();
  f.accounts[1] = pairWalletTokenAccount(
    f.asset.address,
    f.wallet,
    f.mintEvidence.mints[1].program,
    '1',
    [{ __kind: 'ImmutableOwner' }],
  );
  const e = await read(f);
  expect(e.accounts[1]).toMatchObject({
    status: 'Needs extension setup',
    spendableRaw: '0',
    missingExtensions: ['PausableAccount', 'TransferHookAccount'],
  });
});
it.each([
  'mint',
  'owner',
  'program',
  'unknown-extension',
  'transferring',
  'option',
  'native',
  'delegated-units',
] as const)('rejects %s account evidence', async (mode) => {
  f = await pairWalletFixture();
  if (mode === 'program') f.accounts[1]!.owner = SWAP_TOKEN;
  else if (mode === 'unknown-extension')
    f.accounts[1] = pairWalletTokenAccount(
      f.asset.address,
      f.wallet,
      f.mintEvidence.mints[1].program,
      '1',
      [{ __kind: 'NonTransferableAccount' }],
    );
  else if (mode === 'transferring')
    f.accounts[1] = pairWalletTokenAccount(
      f.asset.address,
      f.wallet,
      f.mintEvidence.mints[1].program,
      '1',
      [{ __kind: 'TransferHookAccount', transferring: true }],
    );
  else
    mutate(f, 1, (b, v) => {
      if (mode === 'mint') b[0] ^= 1;
      if (mode === 'owner') b[32] ^= 1;
      if (mode === 'option') v.setUint32(72, 2, true);
      if (mode === 'native') v.setUint32(109, 1, true);
      if (mode === 'delegated-units') v.setBigUint64(121, 1n, true);
    });
  await expect(read(f)).rejects.toThrow();
});
it('compares exact rechecked balances and does not pool other accounts or native SOL into stock funds', async () => {
  f = await pairWalletFixture();
  const before = await read(f);
  const quote = await quoteOwnedImportedPair(
    f.db,
    'alice',
    f.request,
    new AbortController().signal,
    f.dependencies,
  );
  const funding = assessPairWalletFunding(quote, before, '10000000');
  expect(funding).toMatchObject({
    inputMint: f.asset.address,
    canRequestUnsignedOrder: true,
    feesEstimated: false,
    walletOwnershipVerified: false,
    signingAllowed: false,
  });
  const changed = structuredClone(before);
  changed.accounts[1].amountRaw = '0';
  changed.accounts[1].spendableRaw = '0';
  expect(
    assessPairWalletFunding(quote, changed, '10000000').inputBalanceSufficient,
  ).toBe(false);
  expect(() => assertStablePairWalletEvidence(before, changed)).toThrow(
    'changed',
  );
  const noSol = structuredClone(before);
  noSol.nativeBalanceRaw = '0';
  expect(
    assessPairWalletFunding(quote, noSol, '10000000').nativeReserveSufficient,
  ).toBe(false);
});
