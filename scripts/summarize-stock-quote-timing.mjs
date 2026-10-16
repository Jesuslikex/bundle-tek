// Offline report. All refusals remain in each fixed sample's denominator.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { summarizeStockRepeatability } from './summarize-stock-repeatability.mjs';
import { stockQuoteGaps } from './stock-provider-timing.mjs';

const [output, ...paths] = process.argv.slice(2);
if (!output || !paths.length)
  throw Error('Use output.json campaign.json [...campaign.json]');
const samples = paths.map((path) => {
  const text = readFileSync(path, 'utf8'),
    campaign = JSON.parse(text);
  if (!campaign.complete)
    throw Error('Report requires a complete fixed six-attempt sample.');
  const verified = summarizeStockRepeatability(campaign.receipts);
  const reasons = new Map();
  const attempts = campaign.receipts.map((r, i) => {
    const timing = stockQuoteGaps(r.providerTimings);
    if (
      r.providerTimings !== undefined &&
      JSON.stringify(timing) !== JSON.stringify(r.quoteTiming)
    )
      throw Error('Stored quote timing differs from measured events.');
    if (!r.passed)
      reasons.set(
        r.reason ?? 'Unspecified refusal',
        (reasons.get(r.reason ?? 'Unspecified refusal') ?? 0) + 1,
      );
    return {
      round: Math.floor(i / 2) + 1,
      asset: r.quoteAsset,
      passed: r.passed,
      reason: r.reason ?? null,
      check: r.diagnosis?.check ?? null,
      minimumComparison:
        r.diagnostic?.check === 'minimum-output'
          ? r.diagnostic.comparisons
          : null,
      timing,
    };
  });
  return {
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
    assets: verified.assets,
    passed: attempts.filter((a) => a.passed).length,
    failed: attempts.filter((a) => !a.passed).length,
    minimumOutputRefusals: attempts.filter(
      (a) => !a.passed && a.check === 'minimum-output',
    ).length,
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    attempts,
  };
});
const result = {
  format: 'stock-quote-order-gap-report-v1',
  readOnly: true,
  samples,
  signingAllowed: false,
  executionAllowed: false,
  interpretation:
    'Full-response timings are monotonic wrapper observations. Historical header timing is not substituted. Small samples do not establish a causal relation between delay and price movement.',
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    output,
    samples: samples.map(({ path, passed, failed, minimumOutputRefusals }) => ({
      path,
      passed,
      failed,
      minimumOutputRefusals,
    })),
  }),
);
