import { expect, it } from 'vitest';
import { savedAutoSellOutcome } from './auto-sell-outcome';
import { validatedAutoSellOutcomeReference } from './auto-sell-outcome-reference';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
it('reads the exact expired original approval without treating its saved status as a receipt or authority', () => {
  const page = autoSellOutcomePage(),
    before = structuredClone(page);
  expect(savedAutoSellOutcome(page, ref)).toEqual({
    state: 'submitted',
    signature: ref.signature,
    updatedAt: '2026-10-01T00:01:00Z',
    finalityVerified: false,
    signingAllowed: false,
    submissionAllowed: false,
  });
  expect(page).toEqual(before);
  page.intents[0].state = 'finalized';
  expect(savedAutoSellOutcome(page, ref).finalityVerified).toBe(false);
  expect(JSON.stringify(savedAutoSellOutcome(page, ref))).not.toContain(
    'SYNTHETIC-UNSIGNED',
  );
});
it.each(['awaiting_signature', 'cancelled'] as const)(
  'keeps unsigned saved state %s informational despite a locally generated signature',
  (state) => {
    const page = autoSellOutcomePage();
    page.intents[0].state = state;
    page.intents[0].signature = null;
    expect(savedAutoSellOutcome(page, ref)).toMatchObject({
      state,
      signature: null,
      submissionAllowed: false,
    });
  },
);
it.each([
  'project',
  'intent',
  'preparation',
  'project-revision',
  'wallet-revision',
  'wallet',
  'side',
  'mint',
  'output',
  'input',
  'hash',
  'signature',
  'pagination',
  'empty',
  'duplicate',
  'date',
] as const)('refuses changed original lookup context: %s', (kind) => {
  const page = autoSellOutcomePage(),
    row = page.intents[0];
  if (kind === 'project')
    page.projectId = '44444444-4444-4444-8444-444444444444';
  if (kind === 'intent') {
    row.id = '44444444-4444-4444-8444-444444444444';
    row.document.id = row.id;
  }
  if (kind === 'preparation') {
    row.preparationId = '44444444-4444-4444-8444-444444444444';
    row.document.preparationId = row.preparationId;
  }
  if (kind === 'project-revision') row.projectRevision++;
  if (kind === 'wallet-revision') row.walletRevision++;
  if (kind === 'wallet') {
    row.wallet = ref.mint;
    row.document.wallet = row.wallet;
  }
  if (kind === 'side') row.side = 'Buy';
  if (kind === 'mint') row.document.inputMint = ref.wallet;
  if (kind === 'output') row.document.outputMint = ref.wallet;
  if (kind === 'input') row.document.inputRaw = '5000001';
  if (kind === 'hash') row.document.sha256 = 'b'.repeat(64);
  if (kind === 'signature') row.signature = '1'.repeat(88);
  if (kind === 'pagination') page.nextCursor = ref.intentId;
  if (kind === 'empty') page.intents = [];
  if (kind === 'duplicate') page.intents.push(structuredClone(row));
  if (kind === 'date') row.updatedAt = 'invalid-date';
  expect(() => savedAutoSellOutcome(page, ref)).toThrow();
});
it('owns only lookup coordinates, without packet bytes or caller mutability', () => {
  const source = { ...ref, transaction: 'PRIVATE-UNSIGNED-PACKET' };
  const value = validatedAutoSellOutcomeReference(source);
  source.wallet = ref.mint;
  expect(value.wallet).toBe(ref.wallet);
  expect(Object.isFrozen(value)).toBe(true);
  expect(JSON.stringify(value)).not.toContain('PRIVATE-UNSIGNED');
});
it.each([
  'uuid',
  'revision',
  'wallet',
  'mint',
  'zero',
  'overflow',
  'hash',
  'signature',
] as const)('refuses invalid original reference: %s', (kind) => {
  const value = { ...ref };
  if (kind === 'uuid') value.intentId = '../other';
  if (kind === 'revision') value.walletRevision = 0;
  if (kind === 'wallet') value.wallet = 'not-an-address';
  if (kind === 'mint') value.mint = '';
  if (kind === 'zero') value.inputRaw = '0';
  if (kind === 'overflow') value.inputRaw = (1n << 64n).toString();
  if (kind === 'hash') value.preparationSha256 = 'hash';
  if (kind === 'signature') value.signature = '1'.repeat(88);
  expect(() => validatedAutoSellOutcomeReference(value)).toThrow();
});
