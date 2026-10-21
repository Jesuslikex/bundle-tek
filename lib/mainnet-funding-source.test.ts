import { expect, it } from 'vitest';
import { exchangeFundingReviewFixture } from '../test/exchange-funding-review-fixture';
import {
  mainnetFundingSource,
  FUNDING_SOURCE_UNAVAILABLE,
} from './mainnet-funding-source';
it('selects exactly one canonical active saved source and projects public fields only', () => {
  const { funder } = exchangeFundingReviewFixture();
  const input = {
    wallets: [null, { ...funder, privateKey: 'must-not-be-projected' }],
    folders: [],
  };
  const result = mainnetFundingSource(input, funder.address);
  expect(result).toEqual([funder]);
  expect(result[0]).not.toHaveProperty('privateKey');
  result[0].label = 'new label';
  expect(input.wallets[1]?.label).toBe(funder.label);
});
it.each([
  'missing',
  'duplicates',
  'oversized',
  'archived',
  'numeric-archive',
  'revision',
  'role',
  'stamp',
  'folder',
  'tags',
  'source',
] as const)('refuses %s metadata with a fixed safe error', (kind) => {
  const { funder } = exchangeFundingReviewFixture();
  const wallet: Record<string, unknown> = { ...funder };
  let wallets: unknown[] = [wallet],
    source = funder.address;
  if (kind === 'missing') wallets = [];
  if (kind === 'duplicates') wallets.push({ ...funder, archived: true });
  if (kind === 'oversized')
    wallets = Array.from({ length: 501 }, () => ({ ...funder }));
  if (kind === 'archived') wallet.archived = true;
  if (kind === 'numeric-archive') wallet.archived = 0;
  if (kind === 'revision') wallet.revision = '2';
  if (kind === 'role') wallet.role = 'https://private.test/secret';
  if (kind === 'stamp') wallet.updatedAt = 'not a date';
  if (kind === 'folder') wallet.folderIds = ['same', 'same'];
  if (kind === 'tags') wallet.tags = ['bad,tag'];
  if (kind === 'source') source = ' ' + source;
  expect(() => mainnetFundingSource({ wallets }, source)).toThrow(
    FUNDING_SOURCE_UNAVAILABLE,
  );
});
