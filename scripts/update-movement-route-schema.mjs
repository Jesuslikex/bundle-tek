import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sources = [
  'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json',
  'https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/liquidity/instruction.ts',
  'https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/common/programId.ts',
  'https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/processor.rs',
  'https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/cpmm/instruction.ts',
  'https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/instructions/swap_base_input.rs',
  'https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs',
];
const texts = await Promise.all(
  sources.map(async (url) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`Schema source unavailable: ${response.status}`);
    return response.text();
  }),
);
const pump = JSON.parse(texts[0]);
const programs = [];
const variants = ['buy', 'buy_exact_quote_in', 'sell'].map((name) => {
  const instruction = pump.instructions.find((i) => i.name === name);
  if (
    !instruction ||
    instruction.args[0].type !== 'u64' ||
    instruction.args[1].type !== 'u64'
  )
    throw new Error('PumpSwap layout changed.');
  const index = (role) => {
    const n = instruction.accounts.findIndex((a) => a.name === role);
    if (n < 0) throw new Error('PumpSwap account role changed.');
    return n;
  };
  if (name !== 'sell') {
    const optional = pump.types.find((t) => t.name === 'OptionBool');
    if (
      instruction.args.length !== 3 ||
      instruction.args[2].type.defined.name !== 'OptionBool' ||
      optional?.type.kind !== 'struct' ||
      optional.type.fields.length !== 1 ||
      optional.type.fields[0] !== 'bool'
    )
      throw new Error('PumpSwap volume option changed.');
  } else if (instruction.args.length !== 2)
    throw new Error('PumpSwap sell layout changed.');
  return {
    name,
    discriminator: Buffer.from(instruction.discriminator).toString('hex'),
    bytes: name === 'sell' ? 24 : 25,
    accountCount: instruction.accounts.length,
    authority: index('user'),
    source: index(
      name === 'sell' ? 'user_base_token_account' : 'user_quote_token_account',
    ),
    destination: index(
      name === 'sell' ? 'user_quote_token_account' : 'user_base_token_account',
    ),
    inputMint: index(name === 'sell' ? 'base_mint' : 'quote_mint'),
    outputMint: index(name === 'sell' ? 'quote_mint' : 'base_mint'),
    outgoing:
      name === 'sell'
        ? [index('pool_base_token_account')]
        : [
            index('pool_quote_token_account'),
            index('protocol_fee_recipient_token_account'),
            index('coin_creator_vault_ata'),
          ],
    incoming: [
      index(
        name === 'sell'
          ? 'pool_quote_token_account'
          : 'pool_base_token_account',
      ),
    ],
    first:
      name === 'buy'
        ? 'output-exact'
        : name === 'sell'
          ? 'input-exact'
          : 'input-maximum',
    second: name === 'buy' ? 'input-maximum' : 'output-minimum',
    tokenPrograms: [index('base_token_program'), index('quote_token_program')],
  };
});
programs.push({ name: 'PumpSwap', program: pump.address, variants });
const raydium = texts[2].match(
  /export const AMM_V4 = new PublicKey\("([^"]+)"\)/,
)?.[1];
if (
  !raydium ||
  !texts[1].includes('instruction: 9,') ||
  !texts[1].includes('instruction: 11,') ||
  !texts[1].includes('instructionId: 16,') ||
  !texts[1].includes('instructionId: 17,')
)
  throw new Error('Raydium layout changed.');
programs.push({
  name: 'Raydium AMM v4',
  program: raydium,
  variants: [9, 11, 16, 17].map((opcode) => ({
    name: `swap-${opcode}`,
    discriminator: opcode.toString(16).padStart(2, '0'),
    bytes: 17,
    accountCount: opcode < 16 ? 18 : 8,
    authority: opcode < 16 ? 17 : 7,
    source: opcode < 16 ? 15 : 5,
    destination: opcode < 16 ? 16 : 6,
    outgoing: opcode < 16 ? [5, 6] : [3, 4],
    incoming: opcode < 16 ? [5, 6] : [3, 4],
    first: opcode === 9 || opcode === 16 ? 'input-exact' : 'input-maximum',
    second: opcode === 9 || opcode === 16 ? 'output-minimum' : 'output-exact',
    tokenPrograms: [0],
  })),
});
// The public program source explicitly accepts 17 accounts without target_orders
// and 18 with it. Validate the role order before pinning the shorter layout.
for (const [name, count] of [
  ['process_swap_base_in', 'ACCOUNT_LEN'],
  ['process_swap_base_out', 'SWAP_ACCOUNT_NUM'],
]) {
  const start = texts[3].indexOf(`pub fn ${name}(`);
  const tail = texts[3].slice(start);
  const header = tail.slice(0, tail.indexOf('if !user_source_owner.is_signer'));
  const expected = [
    'token_program_info',
    'amm_info',
    'amm_authority_info',
    '_amm_open_orders_info',
    '_amm_target_orders_info',
    'amm_coin_vault_info',
    'amm_pc_vault_info',
    '_market_program_info',
    '_market_info',
    '_market_bids_info',
    '_market_asks_info',
    '_market_event_queue_info',
    '_market_coin_vault_info',
    '_market_pc_vault_info',
    '_market_vault_signer',
    'user_source_info',
    'user_destination_info',
    'user_source_owner',
  ];
  const roles = [
    ...header.matchAll(
      /let(?: mut)? (\w+) = next_account_info\(account_info_iter\)\?/g,
    ),
  ].map((m) => m[1]);
  if (
    start < 0 ||
    !header.includes(`const ${count}: usize = 17;`) ||
    !header.includes(
      `input_account_len != ${count} && input_account_len != ${count} + 1`,
    ) ||
    !new RegExp(
      `if input_account_len == ${count} \\+ 1 \\{\\s*let _amm_target_orders_info = next_account_info\\(account_info_iter\\)\\?;\\s*\\}`,
    ).test(header) ||
    JSON.stringify(roles) !== JSON.stringify(expected)
  )
    throw new Error('Raydium optional target-orders layout changed.');
}
const raydiumProgram = programs.find((p) => p.name === 'Raydium AMM v4');
for (const opcode of [9, 11]) {
  const full = raydiumProgram.variants.find((v) => v.name === `swap-${opcode}`);
  raydiumProgram.variants.push({
    ...full,
    name: `swap-${opcode}-without-target-orders`,
    accountCount: 17,
    authority: 16,
    source: 14,
    destination: 15,
    incoming: [4, 5],
    outgoing: [4, 5],
  });
}
const cpmmProgram = texts[6].match(
  /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("([^"]+)"\)/,
)?.[1];
const sdkCpmmProgram = texts[2].match(
  /export const CREATE_CPMM_POOL_PROGRAM = new PublicKey\("([^"]+)"\)/,
)?.[1];
const cpmmAccountRoles = [
  ...texts[5]
    .slice(
      texts[5].indexOf("pub struct Swap<'info>"),
      texts[5].indexOf('pub fn swap_base_input'),
    )
    .matchAll(/pub (\w+):/g),
].map((m) => m[1]);
if (
  !cpmmProgram ||
  cpmmProgram !== sdkCpmmProgram ||
  JSON.stringify(cpmmAccountRoles) !==
    JSON.stringify([
      'payer',
      'authority',
      'amm_config',
      'pool_state',
      'input_token_account',
      'output_token_account',
      'input_vault',
      'output_vault',
      'input_token_program',
      'output_token_program',
      'input_token_mint',
      'output_token_mint',
      'observation_state',
    ])
)
  throw new Error('CPMM program or account roles changed.');
const cpmmVariants = ['Input', 'Output'].map((side) => {
  const method = `swap_base_${side.toLowerCase()}`;
  const sdkName = `swapBase${side}`;
  const discriminator = createHash('sha256')
    .update(`global:${method}`)
    .digest()
    .subarray(0, 8);
  const declared = texts[4]
    .match(new RegExp(`${sdkName}: \\[([^\\]]+)\\]`))?.[1]
    .split(',')
    .map((v) => Number(v.trim()));
  const start = texts[4].indexOf(
    `export function makeSwapCpmmBase${side === 'Input' ? 'In' : 'Out'}Instruction(`,
  );
  const tail = texts[4].slice(start);
  const body = tail.slice(0, tail.indexOf('\n}'));
  const roleBlock = body.slice(
    body.indexOf('const keys:'),
    body.indexOf('const data ='),
  );
  const roles = [...roleBlock.matchAll(/pubkey: (\w+),/g)].map((m) => m[1]);
  const amounts =
    side === 'Input'
      ? ['amountIn', 'amounOutMin']
      : ['amountInMax', 'amountOut'];
  if (
    start < 0 ||
    !declared ||
    !Buffer.from(declared).equals(discriminator) ||
    !body.includes(`struct([u64("${amounts[0]}"), u64("${amounts[1]}")])`) ||
    !body.includes(`...anchorDataBuf.${sdkName}`) ||
    JSON.stringify(roles) !==
      JSON.stringify([
        'payer',
        'authority',
        'configId',
        'poolId',
        'userInputAccount',
        'userOutputAccount',
        'inputVault',
        'outputVault',
        'inputTokenProgram',
        'outputTokenProgram',
        'inputMint',
        'outputMint',
        'observationId',
      ])
  )
    throw new Error('CPMM discriminator or SDK swap layout changed.');
  return {
    name: method,
    discriminator: discriminator.toString('hex'),
    bytes: 24,
    accountCount: 13,
    authority: 0,
    source: 4,
    destination: 5,
    incoming: [7],
    outgoing: [6],
    inputMint: 10,
    outputMint: 11,
    first: side === 'Input' ? 'input-exact' : 'input-maximum',
    second: side === 'Input' ? 'output-minimum' : 'output-exact',
    tokenPrograms: [8, 9],
  };
});
programs.push({
  name: 'Raydium CPMM',
  program: cpmmProgram,
  variants: cpmmVariants,
});
const schema = {
  format: 'movement-route-schema-v1',
  capturedAt: new Date().toISOString(),
  sources: sources.map((url, i) => ({
    url,
    sha256: createHash('sha256').update(texts[i]).digest('hex'),
  })),
  programs,
};
await writeFile(
  new URL('../lib/movement-route-schema.json', import.meta.url),
  JSON.stringify(schema, null, 2) + '\n',
);
console.log(
  `Pinned ${programs.length} public protocols and ${programs.flatMap((p) => p.variants).length} movement layouts.`,
);
