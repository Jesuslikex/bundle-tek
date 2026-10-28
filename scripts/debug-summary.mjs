// One-off: run the repeatability summariser over a campaign and print the
// refusal message instead of the generic wrapper text.
import { readFileSync } from 'node:fs';
import { summarizeStockRepeatability } from './summarize-stock-repeatability.mjs';

const campaign = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const receipts = campaign.results.map((r) => JSON.parse(readFileSync(r.receipt, 'utf8')));
try {
  const summary = summarizeStockRepeatability(receipts);
  console.log(JSON.stringify({ repeatable: summary.repeatableInThisSample, assets: summary.assets, attempts: summary.attempts?.map((a) => ({ asset: a.asset, passed: a.passed, slots: a.elapsedSlots })) }, null, 2));
} catch (error) {
  console.log('THROW:', error.message);
}
