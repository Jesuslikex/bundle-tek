// Public mainnet reads only. This produces observations, never an approved policy.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import bs58 from 'bs58';
if (!process.argv.includes('--live-readonly'))
  throw Error('Pass --live-readonly for public program reads.');
const endpoint = 'https://api.mainnet-beta.solana.com';
const programs = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '11111111111111111111111111111111',
];
const native = 'NativeLoader1111111111111111111111111111111';
const upgradeable = 'BPFLoaderUpgradeab1e11111111111111111111111';
const legacy = 'BPFLoader2111111111111111111111111111111111';
const deadline = AbortSignal.timeout(60000);
let id = 0;
const slots = [];
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function call(method, params) {
  if (!['getGenesisHash', 'getAccountInfo'].includes(method) || ++id > 22)
    throw Error('Read budget differs.');
  const r = await fetch(endpoint, {
    method: 'POST',
    signal: deadline,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!r.ok) throw Error(`Public RPC HTTP ${r.status}; no retry.`);
  const text = await r.text();
  if (text.length > 16000000) throw Error('Oversized public account reply.');
  const reply = JSON.parse(text);
  if (reply.id !== id || reply.error) throw Error('Public RPC refused read.');
  return reply.result;
}
async function account(key) {
  const r = await call('getAccountInfo', [
    key,
    {
      commitment: 'finalized',
      encoding: 'base64',
      ...(slots.length ? { minContextSlot: Math.max(...slots) } : {}),
    },
  ]);
  if (
    !Number.isSafeInteger(r?.context?.slot) ||
    r.context.slot < (slots.length ? Math.max(...slots) : 0) ||
    !r.value ||
    r.value.data?.[1] !== 'base64'
  )
    throw Error('Account evidence incomplete.');
  slots.push(r.context.slot);
  const bytes = Buffer.from(r.value.data[0], 'base64');
  if (
    bytes.toString('base64') !== r.value.data[0] ||
    (r.value.space !== undefined && r.value.space !== bytes.length)
  )
    throw Error('Complete canonical account data required.');
  return { ...r.value, bytes };
}
async function scan() {
  const result = [];
  for (const address of programs) {
    const p = await account(address);
    if (!p.executable) throw Error('Program is not executable.');
    let programData = null,
      deploymentSlot = null,
      upgradeAuthority = null,
      code = p.bytes;
    if (p.owner === upgradeable) {
      if (p.bytes.length !== 36 || p.bytes.readUInt32LE(0) !== 2)
        throw Error('Program header differs.');
      programData = bs58.encode(p.bytes.subarray(4));
      const d = await account(programData);
      if (
        d.owner !== upgradeable ||
        d.executable ||
        d.bytes.length < 49 ||
        d.bytes.readUInt32LE(0) !== 3 ||
        ![0, 1].includes(d.bytes[12])
      )
        throw Error('ProgramData header differs.');
      deploymentSlot = d.bytes.readBigUInt64LE(4).toString();
      upgradeAuthority = d.bytes[12]
        ? bs58.encode(d.bytes.subarray(13, 45))
        : null;
      code = d.bytes.subarray(45);
    } else if (
      p.owner !== legacy &&
      !(address === programs[3] && p.owner === native)
    )
      throw Error('Unsupported program loader.');
    if (
      address !== programs[3] &&
      !code.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    )
      throw Error('ELF marker missing.');
    result.push({
      address,
      loader: p.owner,
      programData,
      deploymentSlot,
      upgradeAuthority,
      codeSha256: hash(code),
      codeBytes: code.length,
      identityKind: address === programs[3] ? 'native-system' : 'elf-code',
    });
  }
  return result;
}
const evidence = {
  format: 'volume-production-program-observation-v1',
  observedAt: new Date().toISOString(),
  source: endpoint,
  readOnly: true,
  approved: false,
  executionAllowed: false,
  signingAllowed: false,
};
try {
  const genesis = await call('getGenesisHash', []);
  const mainnet = /SOLANA_MAINNET_GENESIS\s*=\s*'([^']+)'/.exec(
    readFileSync('lib/wallet-balances.ts', 'utf8'),
  )?.[1];
  if (!mainnet || genesis !== mainnet) throw Error('Mainnet genesis differs.');
  const first = await scan(),
    second = await scan();
  if ((await call('getGenesisHash', [])) !== genesis)
    throw Error('Genesis changed.');
  Object.assign(evidence, {
    first,
    second,
    slotMin: Math.min(...slots),
    slotMax: Math.max(...slots),
    stable: JSON.stringify(first) === JSON.stringify(second),
    within32Slots: Math.max(...slots) - Math.min(...slots) <= 32,
  });
  if (!evidence.stable || !evidence.within32Slots)
    throw Error('Program observation stability/window differs.');
  const captured = JSON.parse(
    readFileSync('lib/pump-native-route-schema.json', 'utf8'),
  );
  const source = await fetch(captured.source, { signal: deadline });
  if (!source.ok) throw Error('Public IDL source unavailable.');
  const sourceText = await source.text();
  if (sourceText.length > 2000000) throw Error('IDL source exceeds bound.');
  const idl = JSON.parse(sourceText);
  const selected = captured.instructions.map((i) => {
    const current = idl.instructions.find((v) => v.name === i.name);
    if (!current)
      throw Error('Captured route instruction absent from current IDL.');
    return {
      name: current.name,
      discriminator: Buffer.from(current.discriminator).toString('hex'),
      accounts: current.accounts.map((a) => a.name),
      args: current.args,
    };
  });
  evidence.sourceReview = {
    url: captured.source,
    observedSha256: hash(sourceText),
    capturedSha256: captured.sha256,
    exactSourceMatch: hash(sourceText) === captured.sha256,
    selectedRouteSchemaMatch:
      JSON.stringify(selected) === JSON.stringify(captured.instructions),
    provesDeployedBinary: false,
    upgradeAuthorityOwnershipEstablished: false,
  };
} catch (e) {
  evidence.failure = e instanceof Error ? e.message : 'Public read failed.';
  process.exitCode = 1;
}
mkdirSync('work/release-qa', { recursive: true });
writeFileSync(
  'work/release-qa/volume-production-program-review.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
