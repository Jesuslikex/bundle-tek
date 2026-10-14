import { expect, it } from 'vitest';
import { counterPreparationFixture } from '../test/counter-preparation-fixture';
import { routeWallet } from '../test/jupiter-route-fixture';
import { prepareCounterBuyProposal } from './counter-buy-preparation';
import {
  assessCounterBuySimulationBalances,
  type CounterSimulationBalanceEvidence,
} from './counter-buy-simulation-balances';
import { WRAPPED_SOL } from './warmup-swap-quote';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
async function fixture() {
  const f = counterPreparationFixture();
  let calls = 0;
  const prepared = await prepareCounterBuyProposal(
    f.plan,
    f.identity,
    '1005',
    routeWallet,
    'key',
    new AbortController().signal,
    async () => Response.json(++calls === 1 ? f.quote : f.swap),
  );
  const balance = (amount: string, patch = {}) => ({
    accountIndex: '2',
    mint: prepared.quote.outputMint,
    owner: routeWallet,
    programId: TOKEN,
    uiTokenAmount: { amount, decimals: String(prepared.tokenDecimals) },
    ...patch,
  });
  const evidence: CounterSimulationBalanceEvidence = {
    sha256: prepared.preparation.sha256,
    observedAt: new Date().toISOString(),
    simulationSlot: '101',
    feeSlot: '100',
    networkFeeLamports: '5000',
    err: null,
    unitsConsumed: '10000',
    preBalances: [
      '100000000',
      ...Array(prepared.preparation.accountCount - 1).fill('0'),
    ],
    postBalances: [
      '99994000',
      ...Array(prepared.preparation.accountCount - 1).fill('0'),
    ],
    preTokenBalances: [balance('9007199254740993')],
    postTokenBalances: [
      balance(
        (9007199254740993n + BigInt(prepared.quote.outputTargetRaw)).toString(),
      ),
    ],
  };
  return { prepared, evidence, balance };
}
it('checks exact output above safe Number precision and independent input/fee limits without signing clearance', async () => {
  const f = await fixture(),
    before = structuredClone(f.prepared);
  expect(
    await assessCounterBuySimulationBalances(f.prepared, f.evidence, '5000'),
  ).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    status: 'Matched balances',
    maximumTotalNetDebitRaw: '6005',
    netWalletDebitRaw: '6000',
    checks: {
      exactOutput: true,
      netWalletDebitWithinLimit: true,
      networkFeeWithinAllowance: true,
      wrappedSolUnchanged: true,
    },
  });
  expect(f.prepared).toEqual(before);
});
it('rejects both too few and too many output atoms for an ExactOut target', async () => {
  const f = await fixture();
  for (const difference of [-1n, 1n]) {
    const changed = {
      ...f.evidence,
      postTokenBalances: [
        f.balance(
          (
            9007199254740993n +
            BigInt(f.prepared.quote.outputTargetRaw) +
            difference
          ).toString(),
        ),
      ],
    };
    expect(
      await assessCounterBuySimulationBalances(f.prepared, changed, '5000'),
    ).toMatchObject({ status: 'Mismatch', checks: { exactOutput: false } });
  }
});
it('withholds proof when metadata or ownership/program observations are missing', async () => {
  const f = await fixture();
  for (const patch of [
    { postTokenBalances: undefined },
    { preTokenBalances: undefined },
    { postTokenBalances: [f.balance('1', { owner: undefined })] },
  ])
    expect(
      await assessCounterBuySimulationBalances(
        f.prepared,
        { ...f.evidence, ...patch },
        '5000',
      ),
    ).toMatchObject({
      status: 'Unavailable',
      checks: { tokenMetadataComplete: null, exactOutput: null },
    });
});
it('rejects unrelated token debits and WSOL consumption or residue', async () => {
  const f = await fixture();
  for (const mint of [WRAPPED_SOL, '11111111111111111111111111111111'])
    for (const [before, after] of [
      ['10', '0'],
      ['0', '10'],
    ]) {
      const patch = { mint, accountIndex: '1' };
      const evidence = {
        ...f.evidence,
        preTokenBalances: [
          ...(f.evidence.preTokenBalances as unknown[]),
          f.balance(before, patch),
        ],
        postTokenBalances: [
          ...(f.evidence.postTokenBalances as unknown[]),
          f.balance(after, patch),
        ],
      };
      const result = await assessCounterBuySimulationBalances(
        f.prepared,
        evidence,
        '5000',
      );
      expect(result.status).toBe(
        mint === WRAPPED_SOL || before === '10'
          ? 'Mismatch'
          : 'Matched balances',
      );
    }
});
it('rejects token precision/program changes and another owner receiving the output', async () => {
  const f = await fixture();
  for (const patch of [
    { owner: '11111111111111111111111111111111' },
    { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
  ]) {
    const evidence = {
      ...f.evidence,
      preTokenBalances: [f.balance('0', patch)],
      postTokenBalances: [f.balance(f.prepared.quote.outputTargetRaw, patch)],
    };
    expect(
      (await assessCounterBuySimulationBalances(f.prepared, evidence, '5000'))
        .status,
    ).toBe('Mismatch');
  }
  const decimals = String(f.prepared.tokenDecimals + 1),
    balance = (amount: string) =>
      f.balance(amount, { uiTokenAmount: { amount, decimals } });
  expect(
    (
      await assessCounterBuySimulationBalances(
        f.prepared,
        {
          ...f.evidence,
          preTokenBalances: [balance('0')],
          postTokenBalances: [balance(f.prepared.quote.outputTargetRaw)],
        },
        '5000',
      )
    ).checks.outputPrecision,
  ).toBe(false);
});
it('rejects excessive net SOL debit or insufficient independent fee allowance', async () => {
  const f = await fixture();
  expect(
    await assessCounterBuySimulationBalances(
      f.prepared,
      { ...f.evidence, postBalances: ['99993994', ...Array(6).fill('0')] },
      '5000',
    ),
  ).toMatchObject({
    status: 'Mismatch',
    checks: { netWalletDebitWithinLimit: false },
  });
  expect(
    await assessCounterBuySimulationBalances(f.prepared, f.evidence, '4999'),
  ).toMatchObject({
    status: 'Mismatch',
    checks: { networkFeeWithinAllowance: false },
  });
  for (const limit of ['-1', '1e6', '18446744073709551616'])
    await expect(
      assessCounterBuySimulationBalances(f.prepared, f.evidence, limit),
    ).rejects.toThrow();
});
it('rejects substituted packets, hashes, expiry, stale slots, replacement blockhashes and invalid compute evidence', async () => {
  const f = await fixture();
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { simulationSlot: '99' },
    { feeSlot: '99' },
    { simulationSlot: '133' },
    { replacementBlockhash: { blockhash: 'PRIVATE' } },
    { unitsConsumed: '1400001' },
    { unitsConsumed: '0' },
    { postBalances: [] },
    { err: undefined },
    { loadedAddresses: { readonly: [routeWallet], writable: [] } },
    { observedAt: 'invalid' },
  ])
    await expect(
      assessCounterBuySimulationBalances(
        f.prepared,
        { ...f.evidence, ...patch },
        '5000',
      ),
    ).rejects.toThrow();
  await expect(
    assessCounterBuySimulationBalances(
      { ...f.prepared, expiresAt: new Date(Date.now() + 60000).toISOString() },
      f.evidence,
      '5000',
    ),
  ).rejects.toThrow();
  await expect(
    assessCounterBuySimulationBalances(
      f.prepared,
      f.evidence,
      '5000',
      Date.parse(f.prepared.expiresAt),
    ),
  ).rejects.toThrow();
  await expect(
    assessCounterBuySimulationBalances(
      { ...f.prepared, observedAt: 'invalid' },
      f.evidence,
      '5000',
    ),
  ).rejects.toThrow();
  await expect(
    assessCounterBuySimulationBalances(
      { ...f.prepared, quote: { ...f.prepared.quote, contextSlot: NaN } },
      f.evidence,
      '5000',
    ),
  ).rejects.toThrow();
});
it('sanitizes failed simulation results and never assesses successful balances from them', async () => {
  const f = await fixture();
  const result = await assessCounterBuySimulationBalances(
    f.prepared,
    {
      ...f.evidence,
      err: { private: 'PRIVATE-UPSTREAM' },
      unitsConsumed: '0',
      preBalances: undefined,
      postBalances: undefined,
    },
    '5000',
  );
  expect(result).toMatchObject({
    status: 'Mismatch',
    executionAllowed: false,
    checks: { simulationSucceeded: false },
    netWalletDebitRaw: null,
    tokenChanges: [],
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
