// One-off: run the repeatability summariser over a campaign and print the
// refusal message instead of the generic wrapper text.
import { readFileSync } from 'node:fs';
import { summarizeStockRepeatability } from './summarize-stock-repeatability.mjs';

const campaign = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const receipts = campaign.results.map((r) => JSON.parse(readFileSync(r.receipt, 'utf8')));
try {
  summarizeStockRepeatability(receipts);
  console.log('OK');
} catch (error) {
  console.log('THROW:', error.message);
}
