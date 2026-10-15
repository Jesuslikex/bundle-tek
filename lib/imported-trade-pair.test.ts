import { it, expect } from 'vitest';
import { importedPairQuoteFixture } from '../test/imported-pair-quote-fixture';
import { quoteOwnedImportedPair } from './imported-pair-quote-service';
import {
  parseImportedPairQuote,
  importedPairSha256,
} from './imported-trade-pair';
it('keeps stock quote units separate from SOL and rejects caller or response authority broadening', async () => {
  const f = importedPairQuoteFixture();
  try {
    const value = await quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      new AbortController().signal,
      f.dependencies,
    );
    expect(await parseImportedPairQuote(value, f.selection)).toEqual(value);
    for (const edit of [
      (v: typeof value) => {
        v.signingAllowed = true as false;
      },
      (v: typeof value) => {
        v.balancesChecked = true as false;
      },
      (v: typeof value) => {
        v.pair.issuerVerified = true as false;
      },
      (v: typeof value) => {
        v.quote.inAmount = '10';
      },
      (v: typeof value) => {
        v.quote.minimumOutAmount = '1';
      },
      (v: typeof value) => {
        v.inputAmount = '0.000000001';
      },
      (v: typeof value) => {
        Object.assign(v.quote, { transaction: 'do-not-accept' });
      },
      (v: typeof value) => {
        Object.assign(v.quote, { preparation: {} });
      },
      (v: typeof value) => {
        v.quote.outputMint = v.quote.inputMint;
      },
      (v: typeof value) => {
        Object.assign(v.quote, {
          platformFee: { bps: 10001, mint: v.quote.inputMint },
        });
      },
      (v: typeof value) => {
        v.pair.projectRevision++;
      },
    ]) {
      const changed = structuredClone(value);
      edit(changed);
      await expect(
        parseImportedPairQuote(changed, f.selection),
      ).rejects.toThrow();
    }
    for (const expected of [
      { ...f.selection, quoteMint: f.baseMint },
      { ...f.selection, side: 'Sell' as const },
      { ...f.selection, amount: '1' },
      { ...f.selection, projectRevision: 2 },
    ])
      await expect(parseImportedPairQuote(value, expected)).rejects.toThrow();
    await expect(
      parseImportedPairQuote(
        value,
        f.selection,
        Date.parse(value.pair.expiresAt),
      ),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
it('rejects rehashed symbol and decimal substitutions against the actual selected assets', async () => {
  const f = importedPairQuoteFixture();
  try {
    const value = await quoteOwnedImportedPair(
      f.db,
      'alice',
      f.request,
      new AbortController().signal,
      f.dependencies,
    );
    for (const field of ['base', 'quote'] as const)
      for (const change of [{ decimals: 9 }, { symbol: 'SOL' }]) {
        const mutated = structuredClone(value);
        Object.assign(mutated.pair[field], change);
        mutated.pair.sha256 = await importedPairSha256(mutated.pair);
        await expect(
          parseImportedPairQuote(mutated, f.selection),
        ).rejects.toThrow();
      }
  } finally {
    f.close();
  }
});
