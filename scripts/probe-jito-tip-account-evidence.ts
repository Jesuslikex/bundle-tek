import { mkdir, writeFile } from 'node:fs/promises';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import { inspectJitoTipReceiver } from '../lib/jito-tip-account-evidence';
import { PUMP_GROUP_JITO_TIP_ACCOUNTS } from '../lib/pump-group-broadcast';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const fail = (): never => {
  throw Error('Tip receiver diagnostic refused.');
};
const integer = (v: unknown) => {
  if (typeof v !== 'bigint' || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    return fail();
  return Number(v);
};
function account(v: unknown) {
  if (!v || typeof v !== 'object') return fail();
  const a = v as Record<string, unknown>;
  if (
    typeof a.lamports !== 'bigint' ||
    a.lamports < 0n ||
    a.lamports > (1n << 64n) - 1n
  )
    return fail();
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports.toString(),
    data: a.data,
    ...(a.space === undefined ? {} : { space: integer(a.space).toString() }),
  };
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'solana-mainnet.g.alchemy.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  const signal = AbortSignal.timeout(45000);
  const captures: { method: string; request: string; response: string }[] = [];
  let calls = 0,
    bytes = 0,
    rateLimited = false,
    status = 'refused',
    stage = 'genesis';
  let floor: number | null = null,
    lastSlot: number | null = null;
  const evidence: Awaited<ReturnType<typeof inspectJitoTipReceiver>>[] = [];
  async function rpc(method: string, params: unknown[]) {
    if (
      !['getGenesisHash', 'getMultipleAccounts', 'getSlot'].includes(method) ||
      ++calls > 3
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const id = 'tip-receiver:' + calls,
      request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    if (!r.ok) {
      rateLimited = r.status === 429;
      void r.body?.cancel();
      return fail();
    }
    const raw = await readJitoSimulationPayload(r.body, signal, 131072);
    bytes += raw.byteLength;
    if (bytes > 393216) return fail();
    captures.push({
      method,
      request,
      response: Buffer.from(raw.rawBody).toString('utf8'),
    });
    const p = raw.value as Record<string, unknown>;
    if (p.jsonrpc !== '2.0' || p.id !== id || Object.keys(p).length !== 3)
      return fail();
    if (Object.hasOwn(p, 'error')) {
      rateLimited = (p.error as { code?: unknown })?.code === 429n;
      return fail();
    }
    if (!Object.hasOwn(p, 'result')) return fail();
    return p.result;
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'one-context-tip-rent-clock';
    const keys = [...PUMP_GROUP_JITO_TIP_ACCOUNTS, PAIR_RENT, PAIR_CLOCK];
    const result = (await rpc('getMultipleAccounts', [
      keys,
      { commitment: 'confirmed', encoding: 'base64' },
    ])) as { context: { slot: unknown }; value: unknown[] };
    floor = integer(result.context.slot);
    if (
      floor < 1 ||
      !Array.isArray(result.value) ||
      result.value.length !== keys.length
    )
      return fail();
    const rentAccount = account(result.value[8]);
    pairClockUnixTimestamp(account(result.value[9]), floor);
    for (const [i, address] of PUMP_GROUP_JITO_TIP_ACCOUNTS.entries()) {
      evidence.push(
        await inspectJitoTipReceiver({
          address,
          account: account(result.value[i]),
          rentAccount,
        }),
      );
      signal.throwIfAborted();
    }
    stage = 'final-window';
    lastSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: floor },
      ]),
    );
    if (lastSlot < floor || lastSlot - floor > 32) return fail();
    status = 'all-eight-tip-receivers-observed';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-tip-receiver-diagnostic-v1',
    observedAt: new Date().toISOString(),
    status,
    stage,
    floor,
    lastSlot,
    calls,
    responseBytes: bytes,
    rateLimited,
    evidence,
    bankVerified: false,
    providerQualified: false,
    fullSwapQualified: false,
    programApproved: false,
    signingAllowed: false,
    executionAllowed: false,
    transactionsBroadcast: 0,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-tip-receiver-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ receipt, captures }, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, retainedCapture: path }));
}
main().catch(() => {
  console.error(
    'Tip receiver diagnostic setup refused; no provider details printed.',
  );
  process.exitCode = 1;
});
