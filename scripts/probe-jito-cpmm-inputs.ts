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
import { PAIR_CLOCK, pairClockUnixTimestamp } from '../lib/pair-stock-clock';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from '../lib/pair-rent-evidence';
import { inspectSwapMintAccount } from '../lib/swap-token-program-evidence';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Public on-curve owner observed in getTokenLargestAccounts(WSOL) on 30 Oct.
// Not a Bundle wallet; no ownership, control, quietness or signing claim.
const REFERENCE = 'ECHhYtSogLASVDZ8NTg1w7oCo2aeJGnNu4pDNvorwB9a';
const flags = {
  inputDiscoveryOnly: true,
  ownershipClaimed: false,
  poolVerified: false,
  providerQualified: false,
  bankVerified: false,
  fullSwapQualified: false,
  signingAllowed: false,
  executionAllowed: false,
};
const fail = (): never => {
  throw Error('Input discovery refused.');
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
function key(v: unknown) {
  if (typeof v !== 'string' || v.length > 44) return fail();
  const b = bs58.decode(v);
  if (b.length !== 32 || bs58.encode(b) !== v) return fail();
  return v;
}
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
    a.data[0].length > 5500
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
type Pool = {
  pool: string;
  config: string;
  vault0: string;
  vault1: string;
  oracle: string;
  status: number;
};
async function main() {
  if (
    ![3, 4].includes(process.argv.length) ||
    process.argv[2] !== '--live-readonly' ||
    (process.argv[3] !== undefined &&
      process.argv[3] !== '--retained-stock-reference')
  )
    return fail();
  const referenceAddress = process.argv[3]
    ? '2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y'
    : REFERENCE;
  const signal = AbortSignal.timeout(45000),
    endpoint = getSolanaHolderRpcEndpoint();
  let calls = 0,
    stage = 'genesis',
    floor = 0,
    latest = 0,
    bytes = 0,
    status = 'refused',
    rateLimited = false;
  let pools: Pool[] = [],
    reference: Record<string, unknown> | null = null;
  const diagnostics: Record<string, unknown> = {};
  async function rpc(method: string, params: unknown[]) {
    if (
      ![
        'getSlot',
        'getGenesisHash',
        'getProgramAccounts',
        'getMultipleAccounts',
        'getSignaturesForAddress',
      ].includes(method) ||
      ++calls > 5
    )
      return fail();
    await paceWalletRpc(endpoint, signal);
    const id = 'cpmm-input:' + calls,
      r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    if (!r.ok) {
      rateLimited = r.status === 429;
      void r.body?.cancel();
      return fail();
    }
    const body = await readJitoSimulationPayload(r.body, signal, 1048576, {
      allowDecimalTokens: true,
    });
    bytes += body.byteLength;
    if (bytes > 2097152) return fail();
    const p = body.value as {
      jsonrpc?: unknown;
      id?: unknown;
      error?: { code?: unknown };
      result?: unknown;
    };
    if (p.jsonrpc !== '2.0' || p.id !== id || p.error) {
      rateLimited = p.error?.code === 429n;
      return fail();
    }
    return p.result;
  }
  function context(result: unknown) {
    const r = result as { context?: { slot?: unknown }; value?: unknown[] };
    const n = Number(uint(r.context?.slot));
    if (
      !Number.isSafeInteger(n) ||
      n < latest ||
      n - floor > 32 ||
      !Array.isArray(r.value)
    )
      return fail();
    latest = n;
    return r.value;
  }
  try {
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return fail();
    stage = 'floor';
    floor = Number(uint(await rpc('getSlot', [{ commitment: 'confirmed' }])));
    if (!Number.isSafeInteger(floor) || floor < 1) return fail();
    latest = floor;
    stage = 'pool-discovery';
    // Primary specification: https://solana.com/docs/rpc/http/getprogramaccounts
    const rows = context(
      await rpc('getProgramAccounts', [
        CPMM,
        {
          commitment: 'confirmed',
          encoding: 'base64',
          withContext: true,
          minContextSlot: latest,
          filters: [
            { dataSize: 637 },
            { memcmp: { offset: 168, bytes: WSOL } },
            { memcmp: { offset: 200, bytes: USDC } },
          ],
        },
      ]),
    );
    if (rows.length < 1 || rows.length > 32) return fail();
    pools = rows.map((v) => {
      const row = v as { pubkey: unknown; account: unknown },
        a = account(row.account),
        b = a.b;
      if (
        a.owner !== CPMM ||
        a.executable ||
        b.length !== 637 ||
        b.subarray(0, 8).toString('hex') !== 'f7ede3f5d7c3de46' ||
        bs58.encode(b.subarray(168, 200)) !== WSOL ||
        bs58.encode(b.subarray(200, 232)) !== USDC
      )
        return fail();
      return {
        pool: key(row.pubkey),
        config: bs58.encode(b.subarray(8, 40)),
        vault0: bs58.encode(b.subarray(72, 104)),
        vault1: bs58.encode(b.subarray(104, 136)),
        oracle: bs58.encode(b.subarray(296, 328)),
        status: b[329],
      };
    });
    stage = 'reference-accounts';
    if (isOffCurveAddress(address(referenceAddress))) return fail();
    const derive = (mint: string) =>
      getProgramDerivedAddress({
        programAddress: address(ATA),
        seeds: [
          bs58.decode(referenceAddress),
          bs58.decode(TOKEN),
          bs58.decode(mint),
        ],
      });
    const [[source], [destination]] = await Promise.all([
      derive(WSOL),
      derive(USDC),
    ]);
    const keys = [
      referenceAddress,
      source,
      destination,
      WSOL,
      USDC,
      PAIR_RENT,
      PAIR_CLOCK,
      ...new Set(pools.flatMap((p) => [p.vault0, p.vault1])),
    ];
    if (keys.length > 100) return fail();
    const raw = context(
      await rpc('getMultipleAccounts', [
        keys,
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: latest },
      ]),
    );
    if (raw.length !== keys.length) return fail();
    const a = raw.map((v) => (v === null ? null : account(v)));
    reference = {
      wallet: referenceAddress,
      source: String(source),
      destination: String(destination),
      walletPresent: !!a[0],
      sourcePresent: !!a[1],
      destinationPresent: !!a[2],
      nativeLamports: a[0]?.lamports ?? null,
      sourceRaw:
        a[1]?.b.length === 165 ? a[1].b.readBigUInt64LE(64).toString() : null,
    };
    stage = 'current-bank-clock';
    diagnostics.contextSlot = latest;
    diagnostics.clockSlot =
      a[6]?.b.length === 40 ? a[6].b.readBigUInt64LE(0).toString() : null;
    pairClockUnixTimestamp(a[6], latest);
    const rent = inspectPairRentAccount(a[5]);
    const minimum = BigInt(pairRentMinimumRaw(rent, 165));
    stage = 'reference-wallet-policy';
    diagnostics.referenceWallet = {
      owner: a[0]?.owner ?? null,
      executable: a[0]?.executable ?? null,
      dataBytes: a[0]?.b.length ?? null,
      minimumNativeLamports: (
        BigInt(pairRentMinimumRaw(rent, 0)) + 11000n
      ).toString(),
    };
    if (
      !a[0] ||
      a[0].owner !== '11111111111111111111111111111111' ||
      a[0].executable ||
      a[0].b.length !== 0 ||
      BigInt(a[0].lamports) < BigInt(pairRentMinimumRaw(rent, 0)) + 11000n
    )
      return fail();
    for (const [i, mint, native] of [
      [1, WSOL, 1],
      [2, USDC, 0],
    ] as const) {
      const v = a[i];
      stage = i === 1 ? 'reference-wsol-policy' : 'reference-usdc-policy';
      diagnostics[i === 1 ? 'sourcePolicy' : 'destinationPolicy'] =
        v && v.b.length === 165
          ? {
              program: v.owner,
              executable: v.executable,
              mint: bs58.encode(v.b.subarray(0, 32)),
              authority: bs58.encode(v.b.subarray(32, 64)),
              state: v.b[108],
              delegateFlag: v.b.readUInt32LE(72),
              closeAuthorityFlag: v.b.readUInt32LE(129),
              nativeFlag: v.b.readUInt32LE(109),
              nativeReserve: v.b.readBigUInt64LE(113).toString(),
              lamportGap: (
                BigInt(v.lamports) -
                v.b.readBigUInt64LE(64) -
                v.b.readBigUInt64LE(113)
              ).toString(),
              amount: v.b.readBigUInt64LE(64).toString(),
              lamports: v.lamports,
              expectedRent: minimum.toString(),
            }
          : null;
      if (
        !v ||
        v.owner !== TOKEN ||
        v.executable ||
        v.b.length !== 165 ||
        bs58.encode(v.b.subarray(0, 32)) !== mint ||
        bs58.encode(v.b.subarray(32, 64)) !== referenceAddress ||
        v.b[108] !== 1 ||
        v.b.readUInt32LE(72) !== 0 ||
        v.b.readUInt32LE(129) !== 0 ||
        v.b.readUInt32LE(109) !== native ||
        BigInt(v.lamports) < minimum
      )
        return fail();
      if (
        native &&
        (v.b.readBigUInt64LE(113) !== minimum ||
          BigInt(v.lamports) !== minimum + v.b.readBigUInt64LE(64))
      )
        return fail();
    }
    stage = 'reference-input-funding';
    if (a[1]!.b.readBigUInt64LE(64) < 1000000n) return fail();
    stage = 'reference-mint-policy';
    for (const [i, mint] of [
      [3, WSOL],
      [4, USDC],
    ] as const) {
      if (!a[i] || BigInt(a[i].lamports) < BigInt(pairRentMinimumRaw(rent, 82)))
        return fail();
      await inspectSwapMintAccount(a[i], mint);
    }
    diagnostics.poolVaultBalances = pools.map((p) => ({
      pool: p.pool,
      wrappedSolRaw:
        a[keys.indexOf(p.vault0)]?.b.readBigUInt64LE(64).toString() ?? null,
      usdcRaw:
        a[keys.indexOf(p.vault1)]?.b.readBigUInt64LE(64).toString() ?? null,
    }));
    stage = 'reference-activity';
    const signatures = (await rpc('getSignaturesForAddress', [
      referenceAddress,
      { commitment: 'confirmed', limit: 1, minContextSlot: latest },
    ])) as { blockTime?: unknown; slot?: unknown }[];
    if (!Array.isArray(signatures) || signatures.length !== 1) return fail();
    const age =
      Math.floor(Date.now() / 1000) - Number(uint(signatures[0].blockTime));
    reference.lastAddressActivitySeconds = age;
    reference.activityCoverage = 'latest address signature only';
    if (!Number.isSafeInteger(age) || age < 300) return fail();
    status = 'reference-and-pool-candidates-found';
  } catch {
    process.exitCode = 1;
  }
  const receipt = {
    format: 'jito-cpmm-input-discovery-v1',
    observedAt: new Date().toISOString(),
    status,
    stage,
    minimumSlot: floor,
    maximumObservedSlot: latest,
    calls,
    responseBytes: bytes,
    rateLimited,
    pools,
    reference,
    diagnostics,
    ...flags,
  };
  await mkdir('work', { recursive: true });
  const savedReceipt = `work/cpmm-input-discovery-${Date.now()}.json`;
  await writeFile(savedReceipt, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify(
      { ...receipt, pools: undefined, poolCount: pools.length, savedReceipt },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    'Read-only CPMM discovery setup refused. No qualification or authority granted.',
  );
  process.exitCode = 1;
});
