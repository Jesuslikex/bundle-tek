import { beforeAll, expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  importedSellHandoff,
  currentImportedSellHandoff,
  importedHandoffWallet,
} from './imported-sell-handoff';
import type { ImportedTokenProject } from './imported-token-project';
import type { ImportedSwapReceipt } from './imported-approval-history';
import type { WorkspaceWallet } from './wallet-workspace';
let project: ImportedTokenProject,
  receipt: ImportedSwapReceipt,
  wallet: WorkspaceWallet;
beforeAll(async () => {
  const f = await nativeWarmupFixture({ lookup: true, v2: true });
  project = {
    id: crypto.randomUUID(),
    revision: 9,
    archived: false,
    updatedAt: new Date().toISOString(),
    document: {
      format: 'imported-token-project-v1',
      executionAllowed: false,
      token: {
        chain: 'Solana',
        address: f.mint,
        name: 'QA receipt token',
        symbol: 'QAR',
        decimals: 6,
        totalSupplyRaw: '1000000000',
        observedAt: new Date().toISOString(),
        source: 'fixture.test',
      },
    },
  };
  receipt = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectRevision: 7,
    walletRevision: 1,
    preparationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    document: {
      network: 'mainnet',
      mint: f.mint,
      decimals: 6,
      preparationSha256: f.order.preparation.sha256,
      signature: f.signed.signature,
      wallet: f.wallet,
      signatureVerified: true,
      commitment: 'finalized',
      side: 'Buy',
      tokenUnitsRaw: '217171',
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
    },
  };
  wallet = {
    chain: 'Solana',
    address: f.wallet,
    revision: 1,
    archived: false,
    folderId: '',
    label: 'QA receipt wallet',
    role: 'Recipient',
    updatedAt: new Date().toISOString(),
  };
});
it('creates a sell-only exact handoff from a retained buy without changing its source revision', () => {
  const handoff = importedSellHandoff(receipt, project);
  expect(handoff).toMatchObject({
    side: 'Sell',
    amount: '0.217171',
    tokenUnitsRaw: '217171',
    wallet: wallet.address,
    walletRevision: 1,
    sourceProjectRevision: 7,
    projectRevision: 9,
    receiptId: receipt.id,
  });
  expect(currentImportedSellHandoff(handoff, project)).toEqual(handoff);
  expect(receipt.projectRevision).toBe(7);
});
it.each([0, 6, 9, 255])(
  'preserves positive uint64 units without rounding at %s decimals',
  (decimals) => {
    const context = {
      ...project,
      document: {
        ...project.document,
        token: { ...project.document.token, decimals },
      },
    };
    const maximum = importedSellHandoff(
      {
        ...receipt,
        document: {
          ...receipt.document,
          decimals,
          tokenUnitsRaw: '18446744073709551615',
        },
      },
      context,
    );
    expect(currentImportedSellHandoff(maximum, context).tokenUnitsRaw).toBe(
      '18446744073709551615',
    );
    expect(
      importedSellHandoff(
        {
          ...receipt,
          document: { ...receipt.document, decimals, tokenUnitsRaw: '1' },
        },
        context,
      ).tokenUnitsRaw,
    ).toBe('1');
  },
);
it('rejects archived, foreign, future, invalid-wallet and nonfinalized receipt evidence', () => {
  const badReceipts = [
    { ...receipt, projectId: crypto.randomUUID() },
    { ...receipt, projectRevision: 10 },
    { ...receipt, walletRevision: 0 },
    { ...receipt, document: { ...receipt.document, side: 'Sell' as const } },
    { ...receipt, document: { ...receipt.document, network: 'devnet' } },
    { ...receipt, document: { ...receipt.document, commitment: 'confirmed' } },
    { ...receipt, document: { ...receipt.document, signatureVerified: false } },
    { ...receipt, document: { ...receipt.document, mint: wallet.address } },
    { ...receipt, document: { ...receipt.document, decimals: 9 } },
    { ...receipt, document: { ...receipt.document, wallet: 'invalid' } },
    { ...receipt, document: { ...receipt.document, tokenUnitsRaw: '0' } },
    {
      ...receipt,
      document: { ...receipt.document, tokenUnitsRaw: '18446744073709551616' },
    },
  ];
  for (const bad of badReceipts)
    expect(() => importedSellHandoff(bad, project)).toThrow();
  expect(() =>
    importedSellHandoff(receipt, { ...project, archived: true }),
  ).toThrow();
  expect(() =>
    importedSellHandoff(receipt, {
      ...project,
      document: {
        ...project.document,
        token: { ...project.document.token, chain: 'Base' },
      },
    }),
  ).toThrow();
});
it('rejects stale or edited handoff selections and requires the exact current active receipt wallet revision', () => {
  const handoff = importedSellHandoff(receipt, project);
  expect(importedHandoffWallet(handoff, [wallet])).toEqual(wallet);
  for (const bad of [
    { ...wallet, revision: 2 },
    { ...wallet, archived: true },
    { ...wallet, address: project.document.token.address },
    { ...wallet, chain: 'Base' as const },
  ])
    expect(importedHandoffWallet(handoff, [bad])).toBeNull();
  expect(importedHandoffWallet(handoff, [])).toBeNull();
  expect(() =>
    currentImportedSellHandoff(handoff, { ...project, revision: 10 }),
  ).toThrow();
  expect(() =>
    currentImportedSellHandoff({ ...handoff, amount: '0.217172' }, project),
  ).toThrow();
  expect(() =>
    currentImportedSellHandoff({ ...handoff, mint: wallet.address }, project),
  ).toThrow();
});
