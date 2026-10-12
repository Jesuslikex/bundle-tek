import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../lib/pump-quote-route-schema.json', import.meta.url);
const pinned = JSON.parse(await readFile(path, 'utf8'));
const response = await fetch(pinned.source, {
  signal: AbortSignal.timeout(15000),
  redirect: 'error',
});
if (!response.ok) throw new Error('Pump.fun IDL unavailable.');
const text = await response.text(),
  idl = JSON.parse(text);
if (idl.address !== pinned.program) throw new Error('Program changed.');
const option = idl.types.find((t) => t.name === 'OptionBool');
if (
  option?.type.kind !== 'struct' ||
  JSON.stringify(option.type.fields) !== '["bool"]'
)
  throw new Error('OptionBool encoding changed.');
for (const layout of [pinned, pinned.buy]) {
  const current = idl.instructions.find((i) => i.name === layout.name);
  if (
    !current ||
    JSON.stringify(current.accounts.map((a) => a.name)) !==
      JSON.stringify(layout.accounts) ||
    Buffer.from(current.discriminator).toString('hex') !==
      layout.discriminator ||
    JSON.stringify(current.args) !== JSON.stringify(layout.args) ||
    JSON.stringify(
      Object.fromEntries(
        current.accounts
          .filter((a) => a.address)
          .map((a) => [a.name, a.address]),
      ),
    ) !== JSON.stringify(layout.fixedAccounts)
  )
    throw new Error('Existing layout changed; review required.');
}
const exact = idl.instructions.find((i) => i.name === 'buy_exact_quote_in_v2');
const args = [
  { name: 'spendable_quote_in', type: 'u64' },
  { name: 'min_tokens_out', type: 'u64' },
  { name: 'partial_fill', type: { defined: { name: 'OptionBool' } } },
];
if (
  !exact ||
  JSON.stringify(exact.args) !== JSON.stringify(args) ||
  JSON.stringify(exact.accounts.map((a) => a.name)) !==
    JSON.stringify(pinned.buy.accounts)
)
  throw new Error('Exact quote layout differs.');
const fixed = Object.fromEntries(
  exact.accounts.filter((a) => a.address).map((a) => [a.name, a.address]),
);
if (JSON.stringify(fixed) !== JSON.stringify(pinned.buy.fixedAccounts))
  throw new Error('Exact quote fixed roles differ.');
const hash = createHash('sha256').update(text).digest('hex');
pinned.exactQuote = {
  name: exact.name,
  discriminator: Buffer.from(exact.discriminator).toString('hex'),
  accounts: exact.accounts.map((a) => a.name),
  fixedAccounts: fixed,
  args,
  source: pinned.source,
  sha256: hash,
};
pinned.sha256 = hash;
pinned.buy.sha256 = hash;
pinned.capturedAt = new Date().toISOString();
await writeFile(path, JSON.stringify(pinned, null, 2) + '\n');
console.log(
  'Pinned exact-quote buy layout after verifying existing buy/sell roles and arguments.',
);
