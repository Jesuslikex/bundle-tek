// Find an idle public wallet that holds USDC, for use as a pinned reference.
// Read-only: largest token accounts, their owners, then each owner's recent
// signatures. Writes a fixture the qualifier accepts.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC = process.env.SOLANA_MAINNET_RPC_URL;
if (!RPC) throw Error('SOLANA_MAINNET_RPC_URL is required.');

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw Error(`${method} ${response.status}`);
  const body = await response.json();
  if (body.error) throw Error(`${method}: ${body.error.message}`);
  return body.result;
}

const largest = await rpc('getTokenLargestAccounts', [USDC, { commitment: 'confirmed' }]);
const candidates = [];
for (const row of largest.value.slice(0, 20)) {
  if (BigInt(row.amount) < 1_000_000n) continue;
  const info = await rpc('getAccountInfo', [row.address, { encoding: 'jsonParsed' }]);
  const owner = info?.value?.data?.parsed?.info?.owner;
  if (owner) candidates.push(owner);
}

const idle = [];
for (const owner of [...new Set(candidates)]) {
  const signatures = await rpc('getSignaturesForAddress', [
    owner,
    { commitment: 'confirmed', limit: 1 },
  ]);
  const last = signatures[0]?.blockTime ?? null;
  idle.push({ owner, ageSeconds: last ? Math.floor(Date.now() / 1000) - last : null });
}

idle.sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0));
console.log(idle.slice(0, 5).map((i) => `${i.owner} idle ${i.ageSeconds}s`).join('\n'));

const best = idle[0];
if (!best) throw Error('No USDC holder found.');
const hash = createHash('sha256').update(best.owner).digest('hex');
const fixture = {
  format: 'stock-public-reference-fixture-v1',
  readOnly: true,
  references: { USDC: best.owner },
  referenceHashes: { USDC: hash },
};
writeFileSync('work/stock-reference-usdc.json', JSON.stringify(fixture, null, 2));
console.log('written work/stock-reference-usdc.json');
