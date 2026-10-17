// Read-only code scan for the stock-pair trusted-program allowlist. It reads
// account data only: no quote, order, signing or send. The output is a
// proposed list for human review, never an automatic pin.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';

const NATIVE = 'NativeLoader1111111111111111111111111111111',
  UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111',
  BPF2 = 'BPFLoader2111111111111111111111111111111111',
  MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dJZ3EM';
const BASE = [
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
];
const args = process.argv.slice(2);
if (args[0] !== '--live-readonly')
  throw Error(
    'Use --live-readonly [--program <id>]... [--amm <ammKey>]... No signing or send mode.',
  );
const extraPrograms = [],
  amms = [];
for (let i = 1; i < args.length; i += 2) {
  if (args[i] === '--program') extraPrograms.push(args[i + 1]);
  else if (args[i] === '--amm') amms.push(args[i + 1]);
  else throw Error('Unknown argument ' + args[i]);
}
const endpoint = process.env.SOLANA_STOCK_RUNTIME_RPC_URL;
if (!endpoint) throw Error('Set SOLANA_STOCK_RUNTIME_RPC_URL.');
let id = 0;
async function call(method, params) {
  await new Promise((r) => setTimeout(r, 150));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (!response.ok) throw Error(`${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw Error(`${method} ${body.error.message}`);
  return body.result;
}
const account = async (key) => {
  const r = await call('getAccountInfo', [
    key,
    { encoding: 'base64', commitment: 'finalized' },
  ]);
  if (!r.value) throw Error('Missing account ' + key);
  return {
    slot: r.context.slot,
    owner: r.value.owner,
    executable: r.value.executable,
    data: Buffer.from(r.value.data[0], 'base64'),
  };
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Same identity rules as the runtime scan (lib/pump-group-code-identity.ts).
async function identity(address) {
  const program = await account(address);
  if (!program.executable) throw Error(address + ' is not executable');
  if (program.owner === NATIVE)
    return {
      address,
      loader: NATIVE,
      identityKind: address === BASE[0] ? 'native-system' : 'native-marker',
      upgradeAuthority: null,
      codeSha256: sha(program.data),
      codeBytes: program.data.length,
      slot: program.slot,
    };
  if (program.owner === BPF2) {
    if (program.data.subarray(0, 4).toString('latin1') !== '\x7fELF')
      throw Error(address + ' is not ELF');
    return {
      address,
      loader: BPF2,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: sha(program.data),
      codeBytes: program.data.length,
      slot: program.slot,
    };
  }
  if (program.owner !== UPGRADEABLE)
    throw Error(address + ' has unsupported loader ' + program.owner);
  const programData = bs58.encode(program.data.subarray(4, 36));
  const data = await account(programData);
  const code = data.data.subarray(45);
  if (code.subarray(0, 4).toString('latin1') !== '\x7fELF')
    throw Error(address + ' is not ELF');
  return {
    address,
    loader: UPGRADEABLE,
    identityKind: 'elf-code',
    programData,
    deploymentSlot: data.data.readBigUInt64LE(4).toString(),
    upgradeAuthority:
      data.data[12] === 1 ? bs58.encode(data.data.subarray(13, 45)) : null,
    // Trailing zero padding is part of the scanned bytes, as in the runtime.
    codeSha256: sha(code),
    codeBytes: code.length,
    slot: data.slot,
  };
}

if ((await call('getGenesisHash', [])) !== MAINNET)
  throw Error('Endpoint is not Solana mainnet.');
const ammOwners = {};
for (const key of amms) ammOwners[key] = (await account(key)).owner;
const programs = [
  ...new Set([...BASE, ...extraPrograms, ...Object.values(ammOwners)]),
].sort();
const first = [],
  second = [];
for (const p of programs) first.push(await identity(p));
for (const p of programs) second.push(await identity(p));
const stable = (a, b) =>
  a.codeSha256 === b.codeSha256 &&
  a.upgradeAuthority === b.upgradeAuthority &&
  a.deploymentSlot === b.deploymentSlot;
const result = {
  kind: 'stock-trusted-program-scan',
  readOnly: true,
  approved: false,
  note: 'Proposed allowlist for human review. Pin nothing until the owner approves.',
  createdAt: new Date().toISOString(),
  ammOwners,
  programs: first.map((p, i) => ({
    ...p,
    stableAcrossTwoScans: stable(p, second[i]),
  })),
};
const folder = resolve('work');
mkdirSync(folder, { recursive: true });
const file = resolve(
  folder,
  'stock-trusted-programs-' +
    result.createdAt.replaceAll(/[:.]/g, '-') +
    '.json',
);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
for (const p of result.programs)
  console.log(
    `${p.address} ${p.loader === UPGRADEABLE ? 'upgradeable' : p.loader === BPF2 ? 'bpf2' : 'native'} auth=${p.upgradeAuthority ?? 'none'} sha256=${p.codeSha256} bytes=${p.codeBytes} stable=${p.stableAcrossTwoScans}`,
  );
console.log('Wrote', file);
