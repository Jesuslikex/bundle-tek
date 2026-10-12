import { describe, it, expect } from 'vitest';
import { observeWalletHoldings, TOKEN_PROGRAMS } from './wallet-holdings';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const owner = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const account1 = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const account2 = 'So11111111111111111111111111111111111111112';
const row = (
  program: string,
  pubkey = account1,
  raw = '9007199254740993',
  decimals = 6,
) => ({
  pubkey,
  account: {
    owner: program,
    executable: false,
    data: {
      parsed: {
        type: 'account',
        info: {
          owner,
          mint,
          state: 'initialized',
          tokenAmount: { amount: raw, decimals, uiAmount: 0.00001 },
        },
      },
    },
  },
});
function provider(results: unknown[][], patch: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    calls.push(call);
    const result =
      call.method === 'getGenesisHash'
        ? (patch.genesis ?? SOLANA_MAINNET_GENESIS)
        : call.method === 'getSlot'
          ? 100
          : {
              context: {
                slot:
                  patch.slot ??
                  (call.params[1].programId === TOKEN_PROGRAMS[0] ? 100 : 101),
              },
              value: results[TOKEN_PROGRAMS.indexOf(call.params[1].programId)],
            };
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { fetcher, calls };
}
describe('complete Solana token-account observations', () => {
  it('enumerates both programs, preserves u64 units and aggregates same-mint accounts without uiAmount rounding', async () => {
    const { fetcher, calls } = provider([
      [row(TOKEN_PROGRAMS[0]), row(TOKEN_PROGRAMS[0], account2, '7')],
      [],
    ]);
    const snapshot = await observeWalletHoldings(owner, undefined, fetcher);
    expect(snapshot.holdings[0]).toMatchObject({
      raw: '9007199254741000',
      amount: '9007199254.741',
      decimals: 6,
    });
    expect(snapshot.accountCount).toBe(2);
    expect(snapshot.minSlot).toBe(100);
    expect(snapshot.maxSlot).toBe(101);
    expect(
      calls
        .filter((c) => c.method === 'getTokenAccountsByOwner')
        .map((c) => c.params),
    ).toEqual(
      TOKEN_PROGRAMS.map((programId) => [
        owner,
        { programId },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          minContextSlot: 100,
        },
      ]),
    );
  });
  it('shows frozen Token-2022 accounts and formats zero-decimal tokens exactly', async () => {
    const account = row(TOKEN_PROGRAMS[1], account1, '12', 0);
    account.account.data.parsed.info.state = 'frozen';
    const snapshot = await observeWalletHoldings(
      owner,
      undefined,
      provider([[], [account]]).fetcher,
    );
    expect(snapshot.holdings[0].amount).toBe('12');
    expect(snapshot.holdings[0].accounts[0]).toMatchObject({
      frozen: true,
      extensions: true,
    });
  });
  it('retains Token-2022 account extension names without clearing the conservative legacy extension flag', async () => {
    const account = row(TOKEN_PROGRAMS[1]);
    Object.assign(account.account.data.parsed.info, {
      extensions: [{ extension: 'immutableOwner', state: {} }],
    });
    const result = await observeWalletHoldings(
      owner,
      undefined,
      provider([[], [account]]).fetcher,
    );
    expect(result.holdings[0].accounts[0]).toMatchObject({
      extensions: true,
      extensionTypes: ['immutableOwner'],
    });
    delete (account.account.data.parsed.info as { extensions?: unknown })
      .extensions;
    Object.assign(account.account.data, { space: 165 });
    const bare = await observeWalletHoldings(
      owner,
      undefined,
      provider([[], [account]]).fetcher,
    );
    expect(bare.holdings[0].accounts[0].extensionTypes).toEqual([]);
    Object.assign(account.account.data, { space: 170 });
    const missing = await observeWalletHoldings(
      owner,
      undefined,
      provider([[], [account]]).fetcher,
    );
    expect(missing.holdings[0].accounts[0].extensionTypes).toBeNull();
  });
  it('rejects malformed and duplicate account-extension enumeration rather than treating it as empty', async () => {
    for (const extensions of [
      null,
      [{ extension: 'bad-name' }],
      [{ extension: 'immutableOwner' }, { extension: 'immutableOwner' }],
    ]) {
      const account = row(TOKEN_PROGRAMS[1]);
      Object.assign(account.account.data.parsed.info, { extensions });
      await expect(
        observeWalletHoldings(
          owner,
          undefined,
          provider([[], [account]]).fetcher,
        ),
      ).rejects.toThrow(/extension/);
    }
  });
  it('distinguishes a completed empty enumeration from missing results', async () => {
    expect(
      (
        await observeWalletHoldings(
          owner,
          undefined,
          provider([[], []]).fetcher,
        )
      ).accountCount,
    ).toBe(0);
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([[], null as unknown as unknown[]]).fetcher,
      ),
    ).rejects.toThrow(/enumeration/);
  });
  it('rejects wrong networks and inconsistent observation slots', async () => {
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([[], []], { genesis: 'devnet' }).fetcher,
      ),
    ).rejects.toThrow(/network/);
    for (const slot of [99, 251])
      await expect(
        observeWalletHoldings(
          owner,
          undefined,
          provider([[], []], { slot }).fetcher,
        ),
      ).rejects.toThrow(/slots/);
  });
  it('rejects unrelated ownership, wrong token program and executable accounts', async () => {
    for (const change of ['owner', 'program', 'executable'] as const) {
      const account = row(TOKEN_PROGRAMS[0]);
      if (change === 'owner') account.account.data.parsed.info.owner = account2;
      if (change === 'program') account.account.owner = TOKEN_PROGRAMS[1];
      if (change === 'executable') account.account.executable = true;
      await expect(
        observeWalletHoldings(
          owner,
          undefined,
          provider([[account], []]).fetcher,
        ),
      ).rejects.toThrow(/owner and program/);
    }
  });
  it('rejects duplicate accounts, conflicting mint decimals and overflow', async () => {
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([[row(TOKEN_PROGRAMS[0]), row(TOKEN_PROGRAMS[0])], []])
          .fetcher,
      ),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([
          [row(TOKEN_PROGRAMS[0]), row(TOKEN_PROGRAMS[0], account2, '1', 9)],
          [],
        ]).fetcher,
      ),
    ).rejects.toThrow(/decimals/);
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([
          [row(TOKEN_PROGRAMS[0], account1, '18446744073709551616')],
          [],
        ]).fetcher,
      ),
    ).rejects.toThrow(/integer/);
  });
  it('rejects excessive inventories rather than presenting a truncated list as complete', async () => {
    await expect(
      observeWalletHoldings(
        owner,
        undefined,
        provider([
          Array.from({ length: 501 }, () => row(TOKEN_PROGRAMS[0])),
          [],
        ]).fetcher,
      ),
    ).rejects.toThrow(/limit/);
  });
  it('does not accept a one-program success when the other program fails', async () => {
    const base = provider([[row(TOKEN_PROGRAMS[0])], []]);
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}').params?.[1]
        ?.programId === TOKEN_PROGRAMS[1]
        ? Response.json({
            jsonrpc: '2.0',
            id: 1,
            error: { message: 'unavailable' },
          })
        : base.fetcher(url, init)) as typeof fetch;
    await expect(
      observeWalletHoldings(owner, undefined, fetcher),
    ).rejects.toThrow(/provider request failed/);
  });
});
