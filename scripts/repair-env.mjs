// One-off: repair .env.local after a bad join, keeping every existing value and
// appending the two Alchemy variables.
import { readFileSync, writeFileSync } from 'node:fs';

const KEYS = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'JUPITER_API_KEY',
  'MARKETPLACE_OPERATOR_USER_IDS',
  'SOLANA_MAINNET_RPC_URL',
  'SOLANA_HOLDER_RPC_URL',
  'TURSO_AUTH_TOKEN',
  'TURSO_DATABASE_URL',
];
const raw = readFileSync('.env.local', 'utf8');
const out = [];
for (const key of KEYS) {
  const at = raw.indexOf(key + '=');
  if (at < 0) continue;
  const start = at + key.length + 1;
  let end = raw.length;
  for (const other of KEYS) {
    const next = raw.indexOf(other + '=', start);
    if (next >= 0 && next < end) end = next;
  }
  out.push(key + '=' + raw.slice(start, end).trim());
}
writeFileSync('.env.local', out.join('\n') + '\n');
console.log(out.map((line) => line.split('=')[0] + ' len=' + line.length).join('\n'));
