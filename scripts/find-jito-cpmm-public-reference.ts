import { mkdir, writeFile } from 'node:fs/promises';
import bs58 from 'bs58';
import {
  address,
  getProgramDerivedAddress,
  isOffCurveAddress,
} from '@solana/kit';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationPayload } from '../lib/jito-simulation-json';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
  PAIR_RENT,
} from '../lib/pair-rent-evidence';
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  WSOL = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const fail = (): never => {
  throw Error('Bounded public-reference discovery refused.');
};
const uint = (v: unknown) => {
  if (typeof v === 'bigint' && v >= 0n && v <= (1n << 64n) - 1n) return v;
  if (
    typeof v === 'string' &&
    /^(0|[1-9]\d{0,19})$/.test(v) &&
    BigInt(v) <= (1n << 64n) - 1n
  )
    return BigInt(v);
  return fail();
};
const key = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 44) return fail();
  const b = bs58.decode(v);
  if (b.length !== 32 || bs58.encode(b) !== v) return fail();
  return v;
};
function account(v: unknown) {
  const a = v as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
  };
  if (
    !a ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 1024
  )
    return fail();
  const b = Buffer.from(a.data[0], 'base64');
  if (b.toString('base64') !== a.data[0]) return fail();
  return {
    owner: key(a.owner),
    executable: a.executable,
    lamports: uint(a.lamports).toString(),
    data: [a.data[0], 'base64'],
    b,
  };
}
type Account = ReturnType<typeof account>;
const fingerprint = (a: Account) =>
  JSON.stringify([a.owner, a.executable, a.lamports, a.data]);
function token(
  a: Account | null,
  mint: string,
  owner: string,
  native: number,
  minimum: bigint,
) {
  if (
    !a ||
    a.owner !== TOKEN ||
    a.executable ||
    a.b.length !== 165 ||
    bs58.encode(a.b.subarray(0, 32)) !== mint ||
    bs58.encode(a.b.subarray(32, 64)) !== owner ||
    a.b[108] !== 1 ||
    a.b.readUInt32LE(72) !== 0 ||
    a.b.readBigUInt64LE(121) !== 0n ||
    a.b.readUInt32LE(129) !== 0 ||
    a.b.readUInt32LE(109) !== native ||
    BigInt(a.lamports) < minimum
  )
    return false;
  return (
    !native ||
    (a.b.readBigUInt64LE(113) === minimum &&
      BigInt(a.lamports) === minimum + a.b.readBigUInt64LE(64))
  );
}
type Case = {
  wallet: string;
  source: string;
  destination: string;
  sourceRaw: string;
  nativeLamports: string | null;
  requiredNativeLamports: string;
  destinationPresent: boolean;
  status: 'refused' | 'candidate-observed';
  reason: string | null;
  activity: { address: string; latestSlot: string; ageSeconds: number }[];
};
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    return fail();
  const endpoint = getSolanaHolderRpcEndpoint(),
    signal = AbortSignal.timeout(45000);
  let calls = 0,
    bytes = 0,
    stage = 'genesis',
    floor = 0,
    latest = 0,
    pageSize = 0,
    pagesRead = 0,
    positive = 0,
    onCurve = 0,
    stabilityCandidatesChecked = 0,
    continuationPresent = false,
    rateLimited = false,
    status = 'refused';
  const cases: Case[] = [];
  async function rpc(method: string, params: unknown[]) {
    if (
      ![
        'getGenesisHash',
        'getMultipleAccounts',
        'getProgramAccountsV2',
        'getSignaturesForAddress',
      ].includes(method) ||
      ++calls > 12
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const id = 'cpmm-public:' + calls,
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    if (!response.ok) {
      rateLimited = response.status === 429;
      void response.body?.cancel();
      return fail();
    }
    const payload = await readJitoSimulationPayload(
      response.body,
      signal,
      262144,
    );
    bytes += payload.byteLength;
    if (bytes > 1048576) return fail();
    const p = payload.value as {
      jsonrpc?: unknown;
      id?: unknown;
      error?: { code?: unknown };
      result?: unknown;
    };
    if (
      p.jsonrpc !== '2.0' ||
      p.id !== id ||
      Object.hasOwn(p, 'error') ||
      !Object.hasOwn(p, 'result') ||
      Object.keys(p).length !== 3
    ) {
      rateLimited = p.error?.code === 429n;
      return fail();
    }
    return p.result;
  }
  function observe(v: unknown) {
    const r = v as { context?: { slot?: unknown }; value?: unknown },
      n = Number(uint(r.context?.slot));
    if (
      !Number.isSafeInteger(n) ||
      n < 1 ||
      (floor && (n < latest || n - floor > 32))
    )
      return fail();
    if (!floor) floor = n;
    latest = n;
    return r.value;
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'rent-clock';
    const start = observe(
      await rpc('getMultipleAccounts', [
        [PAIR_RENT, PAIR_CLOCK],
        { commitment: 'confirmed', encoding: 'base64' },
      ]),
    );
    if (!Array.isArray(start) || start.length !== 2) return fail();
    const rent = inspectPairRentAccount(account(start[0]));
    pairClockUnixTimestamp(account(start[1]), latest);
    const minimum = BigInt(pairRentMinimumRaw(rent, 165)),
      reserve = Buffer.alloc(8);
    reserve.writeBigUInt64LE(minimum);
    stage = 'one-reference-page';
    // Exactly one page, never follow its cursor. Provider primary contract:
    // https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-program-accounts-v-2
    const page = observe(
      await rpc('getProgramAccountsV2', [
        TOKEN,
        {
          commitment: 'confirmed',
          encoding: 'base64',
          withContext: true,
          minContextSlot: latest,
          limit: 100,
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: WSOL } },
            {
              memcmp: {
                offset: 109,
                bytes: bs58.encode(Buffer.from([1, 0, 0, 0])),
              },
            },
            { memcmp: { offset: 113, bytes: bs58.encode(reserve) } },
          ],
        },
      ]),
    ) as {
      accounts?: { pubkey?: unknown; account?: unknown }[];
      paginationKey?: unknown;
    };
    if (
      !Array.isArray(page?.accounts) ||
      page.accounts.length > 100 ||
      (page.paginationKey !== null &&
        (typeof page.paginationKey !== 'string' ||
          !page.paginationKey ||
          page.paginationKey.length > 512))
    )
      return fail();
    pageSize = page.accounts.length;
    pagesRead = 1;
    continuationPresent = typeof page.paginationKey === 'string';
    const candidates: {
      wallet: string;
      source: string;
      destination: string;
      sourceState: string;
      sourceRaw: string;
    }[] = [];
    for (const row of page.accounts) {
      const a = account(row.account),
        source = key(row.pubkey);
      if (
        a.owner !== TOKEN ||
        a.b.length !== 165 ||
        bs58.encode(a.b.subarray(0, 32)) !== WSOL
      )
        return fail();
      const owner = bs58.encode(a.b.subarray(32, 64));
      if (
        !token(a, WSOL, owner, 1, minimum) ||
        a.b.readBigUInt64LE(64) < 1000000n
      )
        continue;
      positive++;
      if (isOffCurveAddress(address(owner))) continue;
      onCurve++;
      const derive = (mint: string) =>
        getProgramDerivedAddress({
          programAddress: address(ATA),
          seeds: [bs58.decode(owner), bs58.decode(TOKEN), bs58.decode(mint)],
        });
      const [[canonical], [destination]] = await Promise.all([
        derive(WSOL),
        derive(USDC),
      ]);
      if (canonical !== source || candidates.some((c) => c.wallet === owner))
        continue;
      if (candidates.length < 8)
        candidates.push({
          wallet: owner,
          source,
          destination: String(destination),
          sourceState: fingerprint(a),
          sourceRaw: a.b.readBigUInt64LE(64).toString(),
        });
    }
    if (!candidates.length) {
      status = 'no-reference-found';
      throw Error();
    }
    async function fresh(keys: string[]) {
      const raw = observe(
        await rpc('getMultipleAccounts', [
          keys.slice(),
          {
            commitment: 'confirmed',
            encoding: 'base64',
            minContextSlot: latest,
          },
        ]),
      );
      if (!Array.isArray(raw) || raw.length !== keys.length) return fail();
      const decoded = raw.map((a) => (a === null ? null : account(a)));
      pairClockUnixTimestamp(decoded.at(-1), latest);
      if (
        JSON.stringify(inspectPairRentAccount(decoded.at(-2))) !==
        JSON.stringify(rent)
      )
        return fail();
      return decoded;
    }
    stage = 'owner-and-destination';
    const keys = [
        ...candidates.flatMap((c) => [c.wallet, c.source, c.destination]),
        PAIR_RENT,
        PAIR_CLOCK,
      ],
      states = await fresh(keys);
    const ready: { row: Case; before: string[] }[] = [];
    for (const [i, c] of candidates.entries()) {
      const [wallet, source, destination] = states.slice(i * 3, i * 3 + 3);
      const row: Case = {
        wallet: c.wallet,
        source: c.source,
        destination: c.destination,
        sourceRaw: c.sourceRaw,
        nativeLamports: wallet?.lamports ?? null,
        requiredNativeLamports: (
          BigInt(pairRentMinimumRaw(rent, 0)) + 11000n
        ).toString(),
        destinationPresent: !!destination,
        status: 'refused',
        reason: 'not-ordinary-funded-wallet',
        activity: [],
      };
      cases.push(row);
      if (
        !wallet ||
        wallet.owner !== '11111111111111111111111111111111' ||
        wallet.executable ||
        wallet.b.length !== 0 ||
        BigInt(wallet.lamports) < BigInt(pairRentMinimumRaw(rent, 0)) + 11000n
      )
        continue;
      row.reason = 'source-changed-since-page';
      if (!source || fingerprint(source) !== c.sourceState) continue;
      row.reason = destination ? 'destination-policy' : 'destination-missing';
      if (!token(destination, USDC, c.wallet, 0, minimum)) continue;
      row.reason = 'activity-not-checked';
      ready.push({
        row,
        before: [wallet, source, destination!].map(fingerprint),
      });
    }
    stage = ready.length
      ? 'bounded-reference-activity'
      : 'no-funding-eligible-candidates';
    const pending = [];
    for (const entry of ready.slice(0, 2)) {
      let quiet = true;
      for (const addr of [
        entry.row.wallet,
        entry.row.source,
        entry.row.destination,
      ]) {
        const rows = (await rpc('getSignaturesForAddress', [
          addr,
          { commitment: 'confirmed', limit: 1, minContextSlot: latest },
        ])) as { slot?: unknown; blockTime?: unknown; signature?: unknown }[];
        if (
          !Array.isArray(rows) ||
          rows.length !== 1 ||
          rows[0].blockTime === null ||
          rows[0].blockTime === undefined ||
          typeof rows[0].signature !== 'string'
        ) {
          entry.row.reason = 'activity-evidence-unavailable';
          quiet = false;
          break;
        }
        const atRaw = uint(rows[0].slot),
          timeRaw = uint(rows[0].blockTime);
        if (
          atRaw > BigInt(Number.MAX_SAFE_INTEGER) ||
          timeRaw > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          entry.row.reason = 'activity-integer-scope';
          quiet = false;
          break;
        }
        const signature = bs58.decode(rows[0].signature);
        if (
          signature.length !== 64 ||
          bs58.encode(signature) !== rows[0].signature
        ) {
          entry.row.reason = 'activity-signature-shape';
          quiet = false;
          break;
        }
        const at = Number(atRaw),
          age = Math.floor(Date.now() / 1000) - Number(timeRaw);
        entry.row.activity.push({
          address: addr,
          latestSlot: String(at),
          ageSeconds: age,
        });
        if (
          !Number.isSafeInteger(at) ||
          at > latest ||
          !Number.isSafeInteger(age) ||
          age < 300
        ) {
          entry.row.reason = 'recent-or-inconsistent-activity';
          quiet = false;
          break;
        }
      }
      if (quiet) {
        entry.row.reason = 'stability-not-checked';
        pending.push(entry);
      }
    }
    if (pending.length) {
      stage = 'final-reference-stability';
      const keys = [
          ...pending.flatMap((c) => [
            c.row.wallet,
            c.row.source,
            c.row.destination,
          ]),
          PAIR_RENT,
          PAIR_CLOCK,
        ],
        last = await fresh(keys);
      stabilityCandidatesChecked = pending.length;
      for (const [i, entry] of pending.entries()) {
        const actual = last.slice(i * 3, i * 3 + 3);
        if (actual.some((a, j) => !a || fingerprint(a) !== entry.before[j])) {
          entry.row.reason = 'custody-changed';
          continue;
        }
        entry.row.status = 'candidate-observed';
        entry.row.reason = null;
      }
    }
    status = cases.some((c) => c.status === 'candidate-observed')
      ? 'references-observed'
      : 'no-reference-found';
  } catch {
    process.exitCode = 1;
  }
  if (status !== 'references-observed') process.exitCode = 1;
  const receipt = {
    format: 'cpmm-public-reference-search-v1',
    observedAt: new Date().toISOString(),
    status,
    stage,
    minimumSlot: floor,
    maximumObservedSlot: latest,
    pagesRead,
    pageSize,
    continuationPresent,
    positive,
    onCurve,
    cases,
    calls,
    responseBytes: bytes,
    rateLimited,
    activityCoverage:
      'when reached: latest signature for owner, source and destination; short observed custody interval only',
    activityAddressesChecked: cases.reduce((n, c) => n + c.activity.length, 0),
    stabilityCandidatesChecked,
    completeHolderCoverage: false,
    allHistoryInspected: false,
    ownershipClaimed: false,
    requiresFreshQualification: true,
    mintPolicyVerified: false,
    providerQualified: false,
    bankVerified: false,
    fullSwapQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  await mkdir('work', { recursive: true });
  const path = `work/cpmm-public-reference-search-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify({ ...receipt, savedReceipt: path }, null, 2));
}
main().catch(() => {
  console.error('Read-only public reference search setup refused.');
  process.exitCode = 1;
});
