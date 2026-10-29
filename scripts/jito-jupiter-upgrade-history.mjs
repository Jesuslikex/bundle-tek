import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import {
  inspectJupiterAccounts,
  MAINNET_GENESIS,
  PROGRAM,
  PROGRAM_DATA,
} from './jito-jupiter-public-hash.mjs';

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BUFFER = 'CbboLZHpRP8LTWmn3Wj2DGCya1rVvZX6ARMJs5k76n6n';
const AUTHORITY = 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ';
const UPGRADE_SLOT = 459479624;
const UPGRADE_SIG =
  '3qcuiJd614zpxRq4935DZwdgcrpR32k8N7Xh5H32EB4w2QXonLQWc4XBrL6oMEfoegnCYKXGddQD95YC86rarEh8';
const fail = () => {
  throw Error('Historical program observation refused.');
};
const obj = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : fail();

/** Provider evidence only. No transaction or binary is independently authenticated. */
export function inspectUpgrade(value) {
  const tx = obj(value),
    meta = obj(tx.meta),
    transaction = obj(tx.transaction),
    message = obj(transaction.message);
  if (
    tx.slot !== UPGRADE_SLOT ||
    meta.err !== null ||
    !Array.isArray(transaction.signatures) ||
    transaction.signatures[0] !== UPGRADE_SIG ||
    !Array.isArray(message.instructions) ||
    !Array.isArray(meta.innerInstructions)
  )
    return fail();
  const instructions = [...message.instructions];
  for (const group of meta.innerInstructions) {
    const g = obj(group);
    if (!Array.isArray(g.instructions)) return fail();
    instructions.push(...g.instructions);
  }
  const upgrades = instructions.filter((item) => {
    const i = obj(item);
    return i.programId === LOADER && i.parsed?.type === 'upgrade';
  });
  if (upgrades.length !== 1) return fail();
  const info = obj(obj(upgrades[0].parsed).info);
  if (
    info.bufferAccount !== BUFFER ||
    info.programAccount !== PROGRAM ||
    info.programDataAccount !== PROGRAM_DATA ||
    info.authority !== AUTHORITY
  )
    return fail();
  return {
    upgradeSlot: tx.slot,
    upgradeSignature: UPGRADE_SIG,
    buffer: BUFFER,
    authority: AUTHORITY,
  };
}
export function inspectHistoricalBuffer(value, expectedSlot) {
  const result = obj(value),
    context = obj(result.context),
    account = obj(result.value);
  if (
    context.slot !== expectedSlot ||
    account.owner !== LOADER ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' ||
    account.data[0].length > 5_000_000
  )
    return fail();
  const data = Buffer.from(account.data[0], 'base64');
  if (
    data.toString('base64') !== account.data[0] ||
    data.length <= 37 ||
    data.length > 4_000_000 ||
    data.readUInt32LE(0) !== 1 ||
    data[4] !== 1 ||
    bs58.encode(data.subarray(5, 37)) !== AUTHORITY
  )
    return fail();
  return { code: data.subarray(37), contextSlot: context.slot };
}
export function compareBufferToDeployment(code, deployed) {
  if (
    !(code instanceof Uint8Array) ||
    !Number.isSafeInteger(deployed.codeBytes) ||
    deployed.codeBytes < code.length ||
    deployed.codeBytes > 4_000_000 ||
    deployed.deploymentSlot !== String(UPGRADE_SLOT) ||
    deployed.authority !== AUTHORITY ||
    !/^[0-9a-f]{64}$/.test(deployed.codeSha256)
  )
    return fail();
  const padded = Buffer.alloc(deployed.codeBytes);
  padded.set(code);
  const paddedSha256 = createHash('sha256').update(padded).digest('hex');
  return {
    bufferCodeBytes: code.length,
    bufferCodeSha256: createHash('sha256').update(code).digest('hex'),
    deployedCodeBytes: deployed.codeBytes,
    deployedCodeSha256: deployed.codeSha256,
    paddedSha256,
    match: paddedSha256 === deployed.codeSha256,
  };
}
async function rpc(endpoint, id, method, params) {
  const r = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!r.ok || !r.body) return fail();
  const reader = r.body.getReader(),
    chunks = [];
  let length = 0,
    done = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        done = true;
        break;
      }
      length += part.value.length;
      if (length > 5_000_000) return fail();
      chunks.push(part.value);
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const e = obj(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
  if (
    e.jsonrpc !== '2.0' ||
    e.id !== id ||
    !Object.hasOwn(e, 'result') ||
    Object.hasOwn(e, 'error')
  )
    return fail();
  return e.result;
}
export async function observeUpgrade(archiveEndpoint) {
  const url = new URL(archiveEndpoint);
  if (
    url.protocol !== 'https:' ||
    !(
      url.hostname === 'alchemy.com' || url.hostname.endsWith('.alchemy.com')
    ) ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  if (
    (await rpc(PUBLIC_RPC, 'public-genesis', 'getGenesisHash', [])) !==
      MAINNET_GENESIS ||
    (await rpc(url, 'archive-genesis', 'getGenesisHash', [])) !==
      MAINNET_GENESIS
  )
    return fail();
  const upgrade = inspectUpgrade(
    await rpc(PUBLIC_RPC, 'upgrade', 'getTransaction', [
      UPGRADE_SIG,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]),
  );
  const before = inspectHistoricalBuffer(
    await rpc(url, 'buffer', 'getAccountInfo', [
      BUFFER,
      { encoding: 'base64', slot: UPGRADE_SLOT - 1 },
    ]),
    UPGRADE_SLOT - 1,
  );
  const current = inspectJupiterAccounts(
    await rpc(PUBLIC_RPC, 'current', 'getMultipleAccounts', [
      [PROGRAM, PROGRAM_DATA],
      { encoding: 'base64', commitment: 'confirmed' },
    ]),
  );
  const comparison = compareBufferToDeployment(before.code, current);
  return {
    format: 'jupiter-historical-buffer-observation-v1',
    observedAt: new Date().toISOString(),
    upgrade,
    archiveContextSlot: before.contextSlot,
    currentContextSlot: current.contextSlot,
    comparison,
    sourceVerified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await observeUpgrade(
      process.env.SOLANA_HOLDER_RPC_URL || '',
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.comparison.match) process.exitCode = 1;
  } catch {
    console.error('Historical observation unavailable or refused.');
    process.exitCode = 1;
  }
}
