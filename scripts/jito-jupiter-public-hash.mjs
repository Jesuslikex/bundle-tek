import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const PROGRAM_DATA = '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const fail = () => {
  throw Error('Public program observation refused.');
};
const obj = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : fail();
function bytes(data, max) {
  if (
    !Array.isArray(data) ||
    data.length !== 2 ||
    data[1] !== 'base64' ||
    typeof data[0] !== 'string' ||
    data[0].length > 4 * Math.ceil(max / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data[0],
    )
  )
    return fail();
  const value = Buffer.from(data[0], 'base64');
  if (value.length > max || value.toString('base64') !== data[0]) return fail();
  return value;
}
/** Provider-observed bytes only: no source, bank, policy or execution authority. */
export function inspectJupiterAccounts(result) {
  const r = obj(result),
    context = obj(r.context);
  if (
    !Number.isSafeInteger(context.slot) ||
    context.slot < 0 ||
    !Array.isArray(r.value) ||
    r.value.length !== 2
  )
    return fail();
  const p = obj(r.value[0]),
    d = obj(r.value[1]);
  if (
    p.owner !== LOADER ||
    d.owner !== LOADER ||
    p.executable !== true ||
    d.executable !== false
  )
    return fail();
  const program = bytes(p.data, 36),
    data = bytes(d.data, 4 * 1024 * 1024);
  if (
    program.length !== 36 ||
    program.readUInt32LE(0) !== 2 ||
    bs58.encode(program.subarray(4)) !== PROGRAM_DATA ||
    data.length <= 45 ||
    data.readUInt32LE(0) !== 3 ||
    ![0, 1].includes(data[12])
  )
    return fail();
  return {
    contextSlot: context.slot,
    deploymentSlot: data.readBigUInt64LE(4).toString(),
    programDataBytes: data.length,
    codeBytes: data.length - 45,
    codeSha256: createHash('sha256').update(data.subarray(45)).digest('hex'),
    authority: data[12] === 1 ? bs58.encode(data.subarray(13, 45)) : null,
  };
}
const providers = [
  {
    name: 'solana-public-mainnet',
    endpoint: 'https://api.mainnet-beta.solana.com',
  },
  { name: 'publicnode-solana', endpoint: 'https://solana-rpc.publicnode.com' },
];
async function rpc(endpoint, method, params, id) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok || !response.body) return fail();
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 4_250_000) return fail();
      chunks.push(part.value);
    }
  } finally {
    if (length > 4_250_000) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const message = obj(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
  if (
    message.jsonrpc !== '2.0' ||
    message.id !== id ||
    !Object.hasOwn(message, 'result') ||
    Object.hasOwn(message, 'error')
  )
    return fail();
  return message.result;
}
export async function runPublicObservation() {
  return Promise.all(
    providers.map(async ({ name, endpoint }) => {
      try {
        const genesis = await rpc(
          endpoint,
          'getGenesisHash',
          [],
          `${name}-genesis`,
        );
        if (genesis !== MAINNET_GENESIS) return fail();
        const result = await rpc(
          endpoint,
          'getMultipleAccounts',
          [
            [PROGRAM, PROGRAM_DATA],
            { encoding: 'base64', commitment: 'confirmed' },
          ],
          `${name}-accounts`,
        );
        return {
          name,
          status: 'observed-not-verified',
          genesis,
          ...inspectJupiterAccounts(result),
        };
      } catch {
        return { name, status: 'unavailable-or-refused' };
      }
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const results = await runPublicObservation();
  console.log(
    JSON.stringify(
      {
        format: 'jupiter-public-code-observation-v1',
        observedAt: new Date().toISOString(),
        results,
        signingAllowed: false,
        executionAllowed: false,
        sourceVerified: false,
        providerQualified: false,
      },
      null,
      2,
    ),
  );
  if (results.some((r) => r.status !== 'observed-not-verified'))
    process.exitCode = 1;
}
