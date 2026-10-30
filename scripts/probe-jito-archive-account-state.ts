import { mkdir, writeFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from '../lib/pair-rent-evidence';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const REFERENCE = '2BrxKZyzZ64TgS38ghWHdZU4wSf2C9USuoB6nDkk9Kgo';
const DESTINATION = 'CTdmuBWoZWzBbSRJkrpn4S1bM7uD11KMQ8e9EDCLV2h5';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fail = (): never => {
  throw Error('Archive account diagnostic refused.');
};
function integer(v: unknown) {
  if (typeof v !== 'bigint' || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    return fail();
  return Number(v);
}
function account(v: unknown) {
  const a = v as Record<string, unknown> | null;
  if (
    !a ||
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    typeof a.lamports !== 'bigint' ||
    a.lamports < 0n ||
    a.lamports > (1n << 64n) - 1n ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string'
  )
    return fail();
  const b = Buffer.from(a.data[0], 'base64');
  if (b.toString('base64') !== a.data[0]) return fail();
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
  const observations: Record<string, unknown> = {};
  let calls = 0,
    bytes = 0,
    status = 'refused',
    stage = 'genesis',
    rateLimited = false;
  let rpcErrorCode: string | null = null;
  let confirmedSlot: number | null = null,
    bracketConfirmedSlot: number | null = null,
    finalizedSlot: number | null = null,
    finalConfirmedSlot: number | null = null;
  async function rpc(method: string, params: unknown[]) {
    if (
      !['getGenesisHash', 'getSlot', 'getAccountInfo'].includes(method) ||
      ++calls > 8
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const id = 'archive-account:' + calls,
      request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request,
      signal,
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) {
      rateLimited = response.status === 429;
      void response.body?.cancel();
      return fail();
    }
    const body = await readJitoSimulationPayload(response.body, signal, 131072);
    bytes += body.byteLength;
    if (bytes > 524288) return fail();
    captures.push({
      method,
      request,
      response: Buffer.from(body.rawBody).toString('utf8'),
    });
    const p = body.value as Record<string, unknown>;
    if (p.jsonrpc !== '2.0' || p.id !== id || Object.keys(p).length !== 3)
      return fail();
    if (Object.hasOwn(p, 'error')) {
      const code = (p.error as { code?: unknown })?.code;
      rpcErrorCode = typeof code === 'bigint' ? code.toString() : null;
      rateLimited = code === 429n;
      return fail();
    }
    if (!Object.hasOwn(p, 'result')) return fail();
    return p.result;
  }
  async function archived(key: string) {
    // Archive's exact-slot parameter must not be silently replaced by a floor.
    const r = (await rpc('getAccountInfo', [
      key,
      { encoding: 'base64', commitment: 'finalized', slot: finalizedSlot },
    ])) as { context: { slot: unknown }; value: unknown };
    const returnedSlot = integer(r.context.slot);
    const reads = (observations.archiveReads ??= []) as unknown[];
    reads.push({
      address: key,
      requestedSlot: finalizedSlot,
      returnedSlot,
      present: r.value !== null,
    });
    if (returnedSlot !== finalizedSlot) return fail();
    return r.value === null ? null : account(r.value);
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'commitment-distance';
    confirmedSlot = integer(
      await rpc('getSlot', [{ commitment: 'confirmed' }]),
    );
    finalizedSlot = integer(
      await rpc('getSlot', [{ commitment: 'finalized' }]),
    );
    observations.initialFinalityDistance = confirmedSlot - finalizedSlot;
    // Sequential reads can cross a slot boundary. Compare the finalized read
    // with a later confirmed read, retaining the earlier value as a bracket.
    bracketConfirmedSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: confirmedSlot },
      ]),
    );
    observations.bracketFinalityDistance = bracketConfirmedSlot - finalizedSlot;
    if (
      finalizedSlot < 1 ||
      finalizedSlot > bracketConfirmedSlot ||
      bracketConfirmedSlot < confirmedSlot
    )
      return fail();
    stage = 'exact-archive-rent';
    const rentRaw = await archived(PAIR_RENT),
      rent = inspectPairRentAccount(rentRaw);
    observations.rent = rent;
    stage = 'exact-archive-clock';
    const clock = await archived(PAIR_CLOCK);
    // Diagnostic values are retained before the unchanged Clock rule runs.
    if (
      clock?.owner === 'Sysvar1111111111111111111111111111111111111' &&
      !clock.executable
    ) {
      const b = Buffer.from(clock.data[0], 'base64');
      if (b.length === 40)
        observations.reportedClock = {
          slot: b.readBigUInt64LE(0).toString(),
          unixTimestamp: b.readBigInt64LE(32).toString(),
          serverTimeMilliseconds: Date.now(),
        };
    }
    observations.clockTimestamp = pairClockUnixTimestamp(clock, finalizedSlot);
    stage = 'reference-destination-policy';
    const destination = await archived(DESTINATION);
    observations.destinationPresent = destination !== null;
    if (destination) {
      const b = Buffer.from(destination.data[0], 'base64');
      const minimum = pairRentMinimumRaw(rent, 165);
      observations.destination = {
        address: DESTINATION,
        expectedWallet: REFERENCE,
        owner: destination.owner,
        executable: destination.executable,
        bytes: b.length,
        lamports: destination.lamports,
        requiredRentLamports: minimum,
        ...(b.length === 165
          ? {
              mint: bs58.encode(b.subarray(0, 32)),
              authority: bs58.encode(b.subarray(32, 64)),
              amountRaw: b.readBigUInt64LE(64).toString(),
              state: b[108],
              delegateOption: b.readUInt32LE(72),
              delegatedAmount: b.readBigUInt64LE(121).toString(),
              closeAuthorityOption: b.readUInt32LE(129),
              nativeOption: b.readUInt32LE(109),
              existingPolicyMatches:
                destination.owner === TOKEN &&
                !destination.executable &&
                bs58.encode(b.subarray(0, 32)) === USDC &&
                bs58.encode(b.subarray(32, 64)) === REFERENCE &&
                b[108] === 1 &&
                b.readUInt32LE(72) === 0 &&
                b.readBigUInt64LE(121) === 0n &&
                b.readUInt32LE(129) === 0 &&
                b.readUInt32LE(109) === 0 &&
                BigInt(destination.lamports) >= BigInt(minimum),
            }
          : {}),
      };
    }
    stage = 'final-32-slot-window';
    finalConfirmedSlot = integer(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: bracketConfirmedSlot },
      ]),
    );
    observations.finalitySpan = finalConfirmedSlot - finalizedSlot;
    observations.within32Slots =
      finalConfirmedSlot >= bracketConfirmedSlot &&
      finalConfirmedSlot - finalizedSlot <= 32;
    if (!observations.within32Slots) return fail();
    status = 'exact-archive-accounts-observed';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-exact-archive-account-diagnostic-v1',
    observedAt: new Date().toISOString(),
    status,
    stage,
    confirmedSlot,
    bracketConfirmedSlot,
    finalizedSlot,
    finalConfirmedSlot,
    calls,
    responseBytes: bytes,
    rateLimited,
    rpcErrorCode,
    observations,
    ownershipClaimed: false,
    bankVerified: false,
    independentFeeBankVerified: false,
    fullSwapQualified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
    transactionsBroadcast: 0,
  };
  await mkdir('work', { recursive: true });
  const path = `work/jito-exact-archive-accounts-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ receipt, captures }, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, savedCapture: path }));
}
main().catch(() => {
  console.error(
    'Archive account diagnostic setup refused; provider details suppressed.',
  );
  process.exitCode = 1;
});
