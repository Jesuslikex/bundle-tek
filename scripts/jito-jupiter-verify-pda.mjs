import { pathToFileURL } from 'node:url';
import bs58 from 'bs58';

// Filter layout follows the pinned solana-verifiable-build client at
// 26ba8211eddbfab49d30826d15a2408332b89543 src/solana_program.rs.
const VERIFY_PROGRAM = 'verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC';
const PROVIDER = 'https://api.mainnet-beta.solana.com';
export const TARGET = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const CONTROL = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY';
const fail = () => {
  throw Error('Verification metadata query refused.');
};
const object = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : fail();
export function inspectPdas(result, program) {
  const target = Buffer.from(bs58.decode(program));
  if (target.length !== 32 || bs58.encode(target) !== program) return fail();
  const r = object(result),
    context = object(r.context);
  if (
    !Number.isSafeInteger(context.slot) ||
    context.slot < 0 ||
    !Array.isArray(r.value) ||
    r.value.length > 1000
  )
    return fail();
  const seen = new Set();
  for (const row of r.value) {
    const entry = object(row),
      account = object(entry.account);
    if (typeof entry.pubkey !== 'string') return fail();
    const key = Buffer.from(bs58.decode(entry.pubkey));
    if (
      key.length !== 32 ||
      bs58.encode(key) !== entry.pubkey ||
      seen.has(entry.pubkey)
    )
      return fail();
    seen.add(entry.pubkey);
    if (
      account.owner !== VERIFY_PROGRAM ||
      account.executable !== false ||
      !Array.isArray(account.data) ||
      account.data.length !== 2 ||
      account.data[1] !== 'base64' ||
      typeof account.data[0] !== 'string'
    )
      return fail();
    const data = Buffer.from(account.data[0], 'base64');
    if (
      data.length !== 40 ||
      data.toString('base64') !== account.data[0] ||
      !data.subarray(8).equals(target)
    )
      return fail();
  }
  return { contextSlot: context.slot, count: r.value.length };
}
async function query(program, id) {
  const response = await fetch(PROVIDER, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'getProgramAccounts',
      params: [
        VERIFY_PROGRAM,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          withContext: true,
          filters: [{ memcmp: { offset: 8, bytes: program } }],
          dataSlice: { offset: 0, length: 40 },
        },
      ],
    }),
  });
  if (!response.ok || !response.body) return fail();
  const reader = response.body.getReader(),
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
      if (length > 1048576) return fail();
      chunks.push(part.value);
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const envelope = object(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
  if (
    envelope.jsonrpc !== '2.0' ||
    envelope.id !== id ||
    !Object.hasOwn(envelope, 'result') ||
    Object.hasOwn(envelope, 'error')
  )
    return fail();
  return inspectPdas(envelope.result, program);
}
export async function runProbe() {
  const run = async (program, id) => {
    try {
      return { status: 'observed', ...(await query(program, id)) };
    } catch {
      return { status: 'unavailable-or-refused' };
    }
  };
  const target = await run(TARGET, 'jupiter-metadata');
  const control = await run(CONTROL, 'phoenix-control');
  return {
    format: 'verification-pda-observation-v1',
    observedAt: new Date().toISOString(),
    provider: 'solana-public-mainnet',
    target,
    control,
    sourceVerified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runProbe();
  console.log(JSON.stringify(result, null, 2));
  if (
    result.target.status !== 'observed' ||
    result.control.status !== 'observed' ||
    result.control.count < 1
  )
    process.exitCode = 1;
}
