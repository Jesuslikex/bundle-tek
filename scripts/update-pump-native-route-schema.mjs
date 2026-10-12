import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const source =
  'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json';
const response = await fetch(source, {
  signal: AbortSignal.timeout(15000),
  redirect: 'error',
});
if (!response.ok) throw new Error('Native Pump.fun IDL unavailable.');
const text = await response.text(),
  idl = JSON.parse(text);
const option = idl.types.find((t) => t.name === 'OptionBool');
if (
  option?.type.kind !== 'struct' ||
  JSON.stringify(option.type.fields) !== '["bool"]'
)
  throw new Error('Native Pump.fun option encoding changed.');
const instructions = ['buy', 'buy_exact_sol_in', 'sell'].map((name) => {
  const i = idl.instructions.find((v) => v.name === name);
  const names =
    name === 'sell'
      ? ['amount', 'min_sol_output']
      : name === 'buy'
        ? ['amount', 'max_sol_cost', 'track_volume', 'partial_fill']
        : [
            'spendable_sol_in',
            'min_tokens_out',
            'track_volume',
            'partial_fill',
          ];
  if (
    !i ||
    JSON.stringify(i.args.map((a) => a.name)) !== JSON.stringify(names) ||
    i.args.slice(0, 2).some((a) => a.type !== 'u64') ||
    i.args.slice(2).some((a) => a.type?.defined?.name !== 'OptionBool') ||
    i.accounts.find((a) => a.name === 'user')?.signer !== true
  )
    throw new Error('Native Pump.fun argument layout changed.');
  for (const [role, address] of Object.entries({
    system_program: '11111111111111111111111111111111',
    program: idl.address,
    fee_program: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  }))
    if (i.accounts.find((a) => a.name === role)?.address !== address)
      throw new Error('Native Pump.fun program roles changed.');
  for (const role of [
    'mint',
    'bonding_curve',
    'associated_bonding_curve',
    'associated_user',
    'user',
    'fee_recipient',
    'creator_vault',
    'token_program',
  ])
    if (!i.accounts.some((a) => a.name === role))
      throw new Error('Native Pump.fun account role missing.');
  const expected = createHash('sha256')
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
  if (!Buffer.from(i.discriminator).equals(expected))
    throw new Error('Native Pump.fun discriminator changed.');
  return {
    name,
    discriminator: expected.toString('hex'),
    accounts: i.accounts.map((a) => a.name),
    args: i.args,
  };
});
if (idl.address !== '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
  throw new Error('Native Pump.fun mainnet program changed.');
await writeFile(
  new URL('../lib/pump-native-route-schema.json', import.meta.url),
  JSON.stringify(
    {
      format: 'pump-native-route-schema-v1',
      program: idl.address,
      source,
      sha256: createHash('sha256').update(text).digest('hex'),
      capturedAt: new Date().toISOString(),
      instructions,
    },
    null,
    2,
  ) + '\n',
);
console.log('Pinned three current native Pump.fun instruction layouts.');
