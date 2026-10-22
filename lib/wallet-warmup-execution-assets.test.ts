import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from '@/lib/server-env';
import { warmupExecutionSourceFixture } from '../test/warmup-execution-source-fixture';
import { pairRentAccount } from '../test/pair-rent-fixture';
import {
  inspectWarmupExecutionAssets,
  WarmupExecutionAssetsError,
} from './wallet-warmup-execution-assets';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
  inspectSwapMintAccount,
} from './swap-token-program-evidence';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { PAIR_CLOCK } from './pair-stock-clock';
import { PAIR_RENT } from './pair-rent-evidence';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { paceWalletRpc } from './wallet-rpc-pacing';
import bs58 from 'bs58';
import { buildWarmupPlan } from './wallet-warmup';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { address } from '@solana/kit';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import { pairClockUnixTimestamp } from './pair-stock-clock';
import { inspectPairRentAccount } from './pair-rent-evidence';

vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const endpoint =
  'https://rpc.example.invalid/private-key?api-key=fixture-secret';
type Fixture = Awaited<ReturnType<typeof warmupExecutionSourceFixture>>;
const fixtures: Fixture[] = [];
async function fixture(history: 'none' | 'buy' = 'none') {
  const f = await warmupExecutionSourceFixture(history);
  fixtures.push(f);
  return f;
}
beforeEach(() => {
  env.SOLANA_INDEXER_RPC_URL = endpoint;
  vi.mocked(paceWalletRpc).mockClear();
});
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.sqlite.close());
  delete env.SOLANA_INDEXER_RPC_URL;
});
const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function mint(program = SWAP_TOKEN, decimals = 6) {
  const bytes = new Uint8Array(82);
  bytes[44] = decimals;
  bytes[45] = 1;
  return { owner: program, executable: false, data: [wire(bytes), 'base64'] };
}
function clock(slot: number, now: number) {
  const bytes = new Uint8Array(40),
    view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(slot), true);
  view.setBigInt64(32, BigInt(Math.floor(now / 1000)), true);
  return {
    owner: 'Sysvar1111111111111111111111111111111111111',
    executable: false,
    data: [wire(bytes), 'base64'],
  };
}
function extendedMint(extensions: ExtensionArgs[]) {
  const encoded = extensions.map((e) => getExtensionEncoder().encode(e));
  const bytes = new Uint8Array(
    166 + encoded.reduce((sum, e) => sum + e.length, 0),
  );
  bytes[44] = 6;
  bytes[45] = 1;
  bytes[165] = 1;
  let offset = 166;
  for (const item of encoded) {
    bytes.set(item, offset);
    offset += item.length;
  }
  return {
    owner: SWAP_TOKEN_2022,
    executable: false,
    data: [wire(bytes), 'base64'],
  };
}
function metadataMint(mintAddress: string, name = 'Synthetic') {
  return extendedMint([
    {
      __kind: 'MetadataPointer',
      authority: address('11111111111111111111111111111111'),
      metadataAddress: address(mintAddress),
    },
    {
      __kind: 'TokenMetadata',
      updateAuthority: null,
      mint: address(mintAddress),
      name,
      symbol: 'TEST',
      uri: 'https://metadata.example.invalid/',
      additionalMetadata: new Map(),
    },
  ]);
}
type Result = { context: { slot: number }; value: ReturnType<typeof mint>[] };
function provider(
  f: Fixture,
  options: {
    program?: string;
    mutate?: (read: number, result: Result) => void;
    after?: (method: string, count: number) => void;
    statusAt?: number;
    genesis?: string;
  } = {},
) {
  let count = 0,
    reads = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(endpoint);
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
    const request = JSON.parse(init!.body as string);
    count++;
    if (options.statusAt === count)
      return new Response('private provider failure', { status: 429 });
    let result: unknown;
    if (request.method === 'getGenesisHash')
      result = options.genesis ?? SOLANA_MAINNET_GENESIS;
    else if (request.method === 'getSlot') result = 100;
    else if (request.method === 'getMultipleAccounts') {
      reads++;
      expect(request.params[0]).toEqual([
        SWAP_WRAPPED_SOL,
        f.packets.mint,
        PAIR_CLOCK,
        PAIR_RENT,
      ]);
      expect(request.params[1]).toEqual({
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: reads === 1 ? 100 : 101,
      });
      const observed = {
        context: { slot: 100 + reads },
        value: [
          mint(SWAP_TOKEN, 9),
          mint(options.program),
          clock(100 + reads, f.clock()),
          pairRentAccount(3480n, 2),
        ],
      };
      options.mutate?.(reads, observed);
      result = observed;
    } else throw Error('Unexpected fixture RPC');
    options.after?.(request.method, count);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
}
const signal = () => new AbortController().signal;
const read = (f: Fixture, fetcher: typeof fetch, parent = signal()) =>
  inspectWarmupExecutionAssets(f.db, f.owner, f.input, parent, {
    fetcher,
    now: f.clock,
  });
const methods = (p: ReturnType<typeof provider>) =>
  p.mock.calls.map(([, init]) => JSON.parse(init!.body as string).method);

it.each([SWAP_TOKEN, SWAP_TOKEN_2022])(
  'binds current source to raw supported asset evidence: %s',
  async (program) => {
    const f = await fixture();
    const p = provider(f, { program });
    const r = await read(f, p);
    expect(methods(p)).toEqual([
      'getGenesisHash',
      'getSlot',
      'getMultipleAccounts',
      'getMultipleAccounts',
    ]);
    expect(vi.mocked(paceWalletRpc)).toHaveBeenCalledTimes(4);
    expect(r.evidence).toMatchObject({
      ownerId: f.owner,
      reviewId: f.kept.id,
      network: 'mainnet',
      provider: 'rpc.example.invalid',
      scope: 'mint-policy-and-token-account-rent-only',
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(r.evidence.tokenAccountRents).toEqual([
      expect.objectContaining({
        address: SWAP_WRAPPED_SOL,
        program: SWAP_TOKEN,
        decimals: 9,
        accountSize: 165,
        minimumRentLamports: '2039280',
      }),
      expect.objectContaining({
        address: f.packets.mint,
        program,
        decimals: 6,
        accountSize: program === SWAP_TOKEN ? 165 : 170,
        minimumRentLamports: program === SWAP_TOKEN ? '2039280' : '2074080',
      }),
    ]);
    expect(r.evidenceSha256).toBe(await digest(canonical(r.evidence)));
    for (const observation of [r.evidence.before, r.evidence.after]) {
      expect(observation.accounts).toHaveLength(4);
      expect(
        await inspectSwapMintAccount(
          observation.accounts[1].account,
          f.packets.mint,
        ),
      ).toEqual(observation.mints[1]);
      expect(
        pairClockUnixTimestamp(
          observation.accounts.at(-2)!.account,
          observation.slot,
          Date.parse(observation.evaluatedServerAt),
        ),
      ).toBe(observation.unixTimestamp);
      expect(
        inspectPairRentAccount(observation.accounts.at(-1)!.account),
      ).toEqual(observation.rent);
    }
    expect(JSON.stringify(r)).not.toMatch(/private-key|fixture-secret|api-key/);
  },
);

it('matches a retained buy lot to the actual current program and precision', async () => {
  const f = await fixture('buy');
  const r = await read(f, provider(f));
  expect(r.evidence.tokenAccountRents[1].program).toBe(
    f.packets.buyDocument.tokenProgram,
  );
});
it('refuses incomplete changed saved lots before any provider read', async () => {
  const f = await fixture('buy');
  f.sqlite
    .prepare(
      "UPDATE warmup_buy_receipts SET document=json_remove(document,'$.tokenProgram') WHERE owner_id=?",
    )
    .run(f.owner);
  const p = provider(f);
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).not.toHaveBeenCalled();
});
it.each(['program', 'decimals'] as const)(
  'refuses retained lot %s mismatch',
  async (kind) => {
    const f = await fixture('buy');
    const p = provider(f, {
      program: kind === 'program' ? SWAP_TOKEN_2022 : undefined,
      mutate: (_, r) => {
        if (kind === 'decimals') r.value[1] = mint(SWAP_TOKEN, 7);
      },
    });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  },
);
it.each(['program', 'decimals', 'authority', 'rent'] as const)(
  'refuses %s changes across the asset recheck',
  async (kind) => {
    const f = await fixture();
    const p = provider(f, {
      mutate: (n, r) => {
        if (n !== 2) return;
        if (kind === 'program') r.value[1] = mint(SWAP_TOKEN_2022);
        if (kind === 'decimals') r.value[1] = mint(SWAP_TOKEN, 7);
        if (kind === 'rent') r.value[3] = pairRentAccount(3479n, 2);
        if (kind === 'authority') {
          const b = Uint8Array.from(atob(r.value[1].data[0]), (c) =>
            c.charCodeAt(0),
          );
          b[0] = 1;
          r.value[1].data[0] = wire(b);
        }
      },
    });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  },
);
it('allows ordinary supply changes without changing the verified transfer policy', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (n, r) => {
      if (n === 2) {
        const b = Uint8Array.from(atob(r.value[1].data[0]), (c) =>
          c.charCodeAt(0),
        );
        b[36] = 1;
        r.value[1].data[0] = wire(b);
      }
    },
  });
  const r = await read(f, p);
  expect(r.evidence.before.mints).toEqual(r.evidence.after.mints);
  expect(r.evidence.before.accounts[1]).not.toEqual(
    r.evidence.after.accounts[1],
  );
});
it.each([-1, 1, 2])(
  'keeps warmup Clock equality strict for offset %s',
  async (offset) => {
    const f = await fixture();
    const p = provider(f, {
      mutate: (_, r) => {
        r.value[2] = clock(r.context.slot + offset, f.clock());
      },
    });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
    expect(p).toHaveBeenCalledTimes(3);
  },
);
it('accepts exactly 32 slots but refuses 33 against the original floor', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (n, r) => {
      if (n === 2) {
        r.context.slot = 132;
        r.value[2] = clock(132, f.clock());
      }
    },
  });
  expect((await read(f, p)).evidence.after.slot).toBe(132);
  const q = provider(f, {
    mutate: (n, r) => {
      if (n === 2) {
        r.context.slot = 133;
        r.value[2] = clock(133, f.clock());
      }
    },
  });
  await expect(read(f, q)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
});
it.each([
  'floor',
  'length',
  'clock-age',
  'rent-owner',
  'mint-owner',
  'encoding',
  'initialized',
] as const)('refuses invalid %s evidence without a fallback', async (kind) => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (_, r) => {
      if (kind === 'floor') {
        r.context.slot = 99;
        r.value[2] = clock(99, f.clock());
      }
      if (kind === 'length') r.value.pop();
      if (kind === 'clock-age')
        r.value[2] = clock(r.context.slot, f.clock() + 32000);
      if (kind === 'rent-owner') r.value[3].owner = SWAP_TOKEN;
      if (kind === 'mint-owner')
        r.value[1].owner = '11111111111111111111111111111111';
      if (kind === 'encoding') r.value[1].data[1] = 'base58';
      if (kind === 'initialized') {
        const b = Uint8Array.from(atob(r.value[1].data[0]), (c) =>
          c.charCodeAt(0),
        );
        b[45] = 0;
        r.value[1].data[0] = wire(b);
      }
    },
  });
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).toHaveBeenCalledTimes(3);
});
it.each([1, 2, 3, 4])(
  'stops on the first 429 at call %s without retries',
  async (statusAt) => {
    const f = await fixture();
    const p = provider(f, { statusAt });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
    expect(p).toHaveBeenCalledTimes(statusAt);
  },
);
it('refuses a wrong network before slots or account reads', async () => {
  const f = await fixture();
  const p = provider(f, { genesis: 'WRONG' });
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).toHaveBeenCalledOnce();
});
it.each(['wallet', 'receipt', 'expired'] as const)(
  'rechecks %s source and deadline after provider reads',
  async (kind) => {
    const f = await fixture();
    const p = provider(f, {
      after: (_, n) => {
        if (n !== 4) return;
        if (kind === 'wallet')
          f.sqlite
            .prepare('UPDATE workspace_wallets SET revision=2 WHERE owner_id=?')
            .run(f.owner);
        if (kind === 'receipt') f.buy();
        if (kind === 'expired') f.advance(25000);
      },
    });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  },
);
it('refuses a foreign owner before provider calls', async () => {
  const f = await fixture();
  const p = provider(f);
  await expect(
    inspectWarmupExecutionAssets(f.db, 'foreign', f.input, signal(), {
      fetcher: p,
      now: f.clock,
    }),
  ).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).not.toHaveBeenCalled();
});
it('captures the original selection before any provider await', async () => {
  const f = await fixture();
  const original = f.input.reviewId;
  const p = provider(f, {
    after: (_, n) => {
      if (n === 1) f.input.reviewId = crypto.randomUUID();
    },
  });
  expect((await read(f, p)).evidence.reviewId).toBe(original);
});
it('honors cancellation after a non-cooperative provider returns', async () => {
  const f = await fixture();
  const c = new AbortController();
  const reason = Error('User cancelled');
  const p = provider(f, { after: () => c.abort(reason) });
  await expect(read(f, p, c.signal)).rejects.toBe(reason);
  expect(p).toHaveBeenCalledOnce();
});

it('keeps the captured endpoint and fetcher when server dependency objects change mid-read', async () => {
  const f = await fixture();
  const fallback = vi.fn<typeof fetch>(async () => {
    throw Error('Unexpected replacement');
  });
  const dependencies = { fetcher: fallback, now: f.clock };
  const p = provider(f, {
    after: (_, count) => {
      if (count === 1) {
        env.SOLANA_INDEXER_RPC_URL = 'https://other.example.invalid/';
        dependencies.fetcher = fallback;
      }
    },
  });
  dependencies.fetcher = p;
  const result = await inspectWarmupExecutionAssets(
    f.db,
    f.owner,
    f.input,
    signal(),
    dependencies,
  );
  expect(result.evidence.provider).toBe('rpc.example.invalid');
  expect(p).toHaveBeenCalledTimes(4);
  expect(fallback).not.toHaveBeenCalled();
});

it('refuses unknown Token-2022 extensions instead of admitting a program ID alone', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (_, r) => {
      const bytes = new Uint8Array(170);
      bytes[44] = 6;
      bytes[45] = 1;
      bytes[165] = 1;
      bytes[166] = 255;
      bytes[167] = 255;
      r.value[1] = {
        owner: SWAP_TOKEN_2022,
        executable: false,
        data: [wire(bytes), 'base64'],
      };
    },
  });
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).toHaveBeenCalledTimes(3);
});

it('captures all ten planned mints plus native, Clock and Rent without truncating the batch', async () => {
  const f = await fixture();
  const mints = Array.from({ length: 10 }, (_, index) =>
    bs58.encode(new Uint8Array(32).fill(index + 20)),
  );
  const original = JSON.parse(
    f.sqlite
      .prepare(
        'SELECT document FROM wallet_warmup_plans WHERE owner_id=? AND id=?',
      )
      .get(f.owner, f.planId)!.document as string,
  );
  const input = { ...original, tokens: mints, cycles: 20 };
  const document = {
    ...input,
    totalBudget: buildWarmupPlan(input, f.at).totalBudget,
  };
  const updatedAt = new Date(f.clock()).toISOString();
  f.sqlite
    .prepare(
      'UPDATE wallet_warmup_plans SET revision=2,document=?,updated_at=? WHERE owner_id=? AND id=?',
    )
    .run(JSON.stringify(document), updatedAt, f.owner, f.planId);
  const progress = await loadWalletWarmupProgress(
    f.db,
    f.owner,
    f.planId,
    2,
    false,
    true,
  );
  const reviewed = reviewWalletWarmupSession(
    progress.plan,
    progress.progress,
    progress.performance,
    f.clock(),
  );
  const kept = await retainWalletWarmupSessionReview(
    f.db,
    f.owner,
    {
      id: crypto.randomUUID(),
      planId: f.planId,
      revision: 2,
      reviewedAt: new Date(f.clock()).toISOString(),
      reviewSha256: await digest(reviewed.contextKey),
    },
    true,
    signal(),
    f.clock,
  );
  const expected = [SWAP_WRAPPED_SOL, ...mints, PAIR_CLOCK, PAIR_RENT];
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const req = JSON.parse(init!.body as string);
    let result: unknown;
    if (req.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (req.method === 'getSlot') result = 100;
    else {
      reads++;
      expect(req.method).toBe('getMultipleAccounts');
      expect(req.params[0]).toEqual(expected);
      result = {
        context: { slot: 100 + reads },
        value: [
          mint(SWAP_TOKEN, 9),
          ...mints.map(() => mint()),
          clock(100 + reads, f.clock()),
          pairRentAccount(3480n, 2),
        ],
      };
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  });
  const r = await inspectWarmupExecutionAssets(
    f.db,
    f.owner,
    { reviewId: kept.id, reviewSha256: kept.reviewSha256 },
    signal(),
    { fetcher, now: f.clock },
  );
  expect(r.evidence.before.accounts.map((a) => a.address)).toEqual(expected);
  expect(r.evidence.after.accounts.map((a) => a.address)).toEqual(expected);
  expect(r.evidence.tokenAccountRents.map((a) => a.address)).toEqual(
    expected.slice(0, -2),
  );
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('accepts canonical metadata-only Token-2022 bytes without fetching metadata URIs', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (_, r) => {
      r.value[1] = metadataMint(f.packets.mint);
    },
  });
  const r = await read(f, p);
  expect(r.evidence.after.mints[1].program).toBe(SWAP_TOKEN_2022);
  expect(p).toHaveBeenCalledTimes(4);
});
it('refuses a changed metadata extension byte on the final read', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (n, r) => {
      r.value[1] = metadataMint(f.packets.mint, n === 1 ? 'Before' : 'After');
    },
  });
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
});
it('refuses fully decoded TransferFeeConfig without broadening swap policy', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (_, r) => {
      r.value[1] = extendedMint([
        {
          __kind: 'TransferFeeConfig',
          transferFeeConfigAuthority: address(
            '11111111111111111111111111111111',
          ),
          withdrawWithheldAuthority: address(
            '11111111111111111111111111111111',
          ),
          withheldAmount: 0n,
          olderTransferFee: {
            epoch: 0n,
            maximumFee: 0n,
            transferFeeBasisPoints: 0,
          },
          newerTransferFee: {
            epoch: 1n,
            maximumFee: 10n,
            transferFeeBasisPoints: 1,
          },
        },
      ]);
    },
  });
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).toHaveBeenCalledTimes(3);
});
it.each([
  'http://rpc.example.invalid/',
  'https://user:secret@rpc.example.invalid/',
  'https://rpc.example.invalid/#fragment',
])(
  'refuses non-private endpoint configuration before requests: %s',
  async (configured) => {
    const f = await fixture();
    env.SOLANA_INDEXER_RPC_URL = configured;
    const p = provider(f);
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
    expect(p).not.toHaveBeenCalled();
  },
);
it('preserves real-shaped max-uint64 rentEpoch and numeric account envelope fields', async () => {
  const f = await fixture();
  const p = provider(f);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await p(input, init);
    if (JSON.parse(init!.body as string).method !== 'getMultipleAccounts')
      return response;
    const body = (await response.json()) as {
      result: { value: Record<string, unknown>[] };
    };
    body.result.value.forEach((a: Record<string, unknown>) => {
      a.rentEpoch = '18446744073709551615';
      a.lamports = 1009200;
      a.space = atob((a.data as string[])[0]).length;
    });
    return new Response(
      JSON.stringify(body).replaceAll(
        '"rentEpoch":"18446744073709551615"',
        '"rentEpoch":18446744073709551615',
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const r = await read(f, fetcher);
  expect(r.evidence.after.accounts.at(-1)!.account).toMatchObject({
    space: '17',
    lamports: '1009200',
  });
});
it.each(['clock', 'floor', 'length', 'rent-space'] as const)(
  'refuses %s drift only on the second observation',
  async (kind) => {
    const f = await fixture();
    const p = provider(f, {
      mutate: (n, r) => {
        if (n !== 2) return;
        if (kind === 'clock') r.value[2] = clock(103, f.clock());
        if (kind === 'floor') {
          r.context.slot = 100;
          r.value[2] = clock(100, f.clock());
        }
        if (kind === 'length') r.value.pop();
        if (kind === 'rent-space')
          (r.value[3] as { space?: string }).space = '18';
      },
    });
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
    expect(p).toHaveBeenCalledTimes(4);
  },
);
it('compares Rent policy bytes while retaining harmless account lamport changes separately', async () => {
  const f = await fixture();
  const p = provider(f, {
    mutate: (n, r) => {
      if (n === 2) (r.value[3] as { lamports?: string }).lamports = '1009201';
    },
  });
  const r = await read(f, p);
  expect(r.evidence.before.rent).toEqual(r.evidence.after.rent);
  expect(r.evidence.before.accounts.at(-1)).not.toEqual(
    r.evidence.after.accounts.at(-1),
  );
});
it.each([307, 429])(
  'cancels refused HTTP%s bodies without following or retrying',
  async (status) => {
    const f = await fixture();
    const cancelled = vi.fn();
    const p = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          status,
          headers: { location: 'https://other.example.invalid/private' },
        }),
    );
    await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
    expect(p).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
  },
);
it('refuses a response over 512KiB before JSON parsing', async () => {
  const f = await fixture();
  const p = vi.fn<typeof fetch>(async () => new Response(' '.repeat(524289)));
  await expect(read(f, p)).rejects.toBeInstanceOf(WarmupExecutionAssetsError);
  expect(p).toHaveBeenCalledOnce();
});
it.each(['jsonrpc', 'id', 'unsafe-slot', 'exponent-slot'] as const)(
  'refuses invalid RPC %s wire data',
  async (kind) => {
    const f = await fixture();
    const p = provider(f);
    const fetcher: typeof fetch = async (input, init) => {
      const response = await p(input, init);
      const body = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result: unknown;
      };
      if (kind === 'jsonrpc') body.jsonrpc = '1.0';
      if (kind === 'id') body.id = 2;
      if (JSON.parse(init!.body as string).method === 'getSlot') {
        if (kind === 'unsafe-slot')
          return new Response(
            '{"jsonrpc":"2.0","id":1,"result":9007199254740992}',
          );
        if (kind === 'exponent-slot')
          return new Response('{"jsonrpc":"2.0","id":1,"result":1e2}');
      }
      return Response.json(body);
    };
    await expect(read(f, fetcher)).rejects.toBeInstanceOf(
      WarmupExecutionAssetsError,
    );
  },
);
it('keeps the original shorter review expiry instead of replacing it with 25 seconds', async () => {
  const f = await fixture();
  f.advance(55000);
  const p = provider(f);
  const r = await read(f, p);
  expect(r.evidence.expiresAt).toBe(f.kept.reviewExpiresAt);
});
