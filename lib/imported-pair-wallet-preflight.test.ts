import { afterEach, expect, it } from 'vitest';
import { pairWalletFixture } from '../test/pair-wallet-fixture';
import {
  preflightOwnedImportedPairWallet,
  importedPairWalletRequest,
} from './imported-pair-wallet-preflight';
import { pairQuoteMint } from '../test/imported-pair-quote-fixture';
import { SWAP_TOKEN, SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
let f: Awaited<ReturnType<typeof pairWalletFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const run = (
  fixture: NonNullable<typeof f>,
  owner = 'alice',
  signal = new AbortController().signal,
) =>
  preflightOwnedImportedPairWallet(
    fixture.db,
    owner,
    fixture.walletRequest,
    signal,
    fixture.dependencies,
  );
it('funds a native SOL quote from the system balance while retaining input, user allowance and wallet rent', async () => {
  f = await pairWalletFixture();
  f.walletRequest.quoteMint = SWAP_WRAPPED_SOL;
  f.walletRequest.amount = '0.5';
  f.mints[1] = pairQuoteMint(9, SWAP_TOKEN);
  const result = await run(f);
  expect(result.funding).toMatchObject({
    inputMint: SWAP_WRAPPED_SOL,
    inputAccount: null,
    inputRaw: '500000000',
    availableInputRaw: '1000000000',
    requiredNativeBalanceRaw: '510001000',
    canRequestUnsignedOrder: true,
  });
  expect(result.evidence.accounts[1].kind).toBe('native-sol');
});
it.each(['Buy', 'Sell'] as const)(
  'binds %s to the owned saved wallet, exact pair, two account snapshots and user allowance',
  async (side) => {
    f = await pairWalletFixture(side);
    const result = await run(f);
    expect(result).toMatchObject({
      format: 'imported-pair-wallet-preflight-v1',
      wallet: f.wallet,
      walletRevision: 1,
      funding: {
        inputMint: side === 'Buy' ? f.asset.address : f.baseMint,
        canRequestUnsignedOrder: true,
        feesEstimated: false,
        routeAccountRentVerified: false,
        walletOwnershipVerified: false,
        applicationReservationsChecked: false,
      },
      transactionPrepared: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(result.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.state.walletReads).toBe(2);
    const snapshots = f.rpc.mock.calls.filter(
      ([method]) => method === 'getMultipleAccounts',
    );
    expect(snapshots).toHaveLength(4);
    for (const [, params] of snapshots.filter(
      ([, params]) => (params[0] as string[])[0] === f!.wallet,
    )) {
      expect(params[0]).toEqual(
        expect.arrayContaining([f.baseMint, f.asset.address]),
      );
    }
    for (const [input] of f.fetcher.mock.calls) {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      expect(url.searchParams.has('taker')).toBe(false);
      expect(url.searchParams.has('wallet')).toBe(false);
    }
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
it.each(['foreign', 'revision', 'archived'] as const)(
  'rejects %s wallet context before provider reads',
  async (mode) => {
    f = await pairWalletFixture();
    if (mode === 'revision') f.walletRequest.walletRevision = 2;
    if (mode === 'archived')
      f.sqlite.prepare('UPDATE workspace_wallets SET archived=1').run();
    await expect(
      run(f, mode === 'foreign' ? 'bob' : 'alice'),
    ).rejects.toMatchObject({ status: mode === 'foreign' ? 404 : 409 });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
  },
);
it.each([
  'owner',
  'signingAllowed',
  'quote',
  'walletBalance',
  'rpcUrl',
] as const)('refuses caller-controlled %s', async (field) => {
  const fixture = (f = await pairWalletFixture());
  expect(() =>
    importedPairWalletRequest({
      ...fixture.walletRequest,
      [field]: 'untrusted',
    }),
  ).toThrow();
});
it.each([
  'balance',
  'wallet-revision',
  'project-document',
  'mint-policy',
] as const)('rejects %s changes while reviewing the wallet', async (mode) => {
  f = await pairWalletFixture();
  const fixture = f;
  fixture.state.onWalletRead = (read) => {
    if (read !== 2) return;
    if (mode === 'balance') fixture.state.walletAccount!.lamports = '999999999';
    if (mode === 'wallet-revision')
      fixture.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
    if (mode === 'project-document')
      fixture.sqlite
        .prepare(
          "UPDATE imported_token_projects SET document=json_set(document,'$.token.symbol','CHANGED')",
        )
        .run();
    if (mode === 'mint-policy') {
      const bytes = Uint8Array.from(atob(fixture.mints[0].data[0]), (c) =>
        c.charCodeAt(0),
      );
      bytes[44] = 7;
      fixture.mints[0].data[0] = btoa(String.fromCharCode(...bytes));
    }
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it('reports destination creation rent and insufficient source funds without pretending an order exists', async () => {
  f = await pairWalletFixture();
  f.accounts[0] = null;
  const result = await run(f);
  expect(result.funding).toMatchObject({
    createDestinationAccount: true,
    destinationAccountRentRaw: '2700',
    canRequestUnsignedOrder: true,
  });
  expect(result.transactionPrepared).toBe(false);
});
it('withholds preparation eligibility when the source ATA is absent', async () => {
  f = await pairWalletFixture();
  f.accounts[1] = null;
  const result = await run(f);
  expect(result.funding).toMatchObject({
    inputBalanceSufficient: false,
    availableInputRaw: '0',
    canRequestUnsignedOrder: false,
  });
});
it('does not let a user allowance smaller than creation rent count as sufficient', async () => {
  f = await pairWalletFixture();
  f.accounts[0] = null;
  f.walletRequest.feeAndRentLimitRaw = '1';
  const result = await run(f);
  expect(result.funding).toMatchObject({
    creationRentWithinAllowance: false,
    canRequestUnsignedOrder: false,
  });
});
it('rechecks expiry after the wallet and network observations', async () => {
  f = await pairWalletFixture();
  const fixture = f,
    original = f.rpc.getMockImplementation()!;
  let genesis = 0;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === 'getGenesisHash' && ++genesis === 3)
      fixture.clock.now += 31000;
    return original(method, params);
  });
  await expect(run(f)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('expired'),
  });
});
it('rejects a changed network after the wallet observations', async () => {
  f = await pairWalletFixture();
  const original = f.rpc.getMockImplementation()!;
  let genesis = 0;
  f.rpc.mockImplementation(async (method, params) =>
    method === 'getGenesisHash' && ++genesis === 3
      ? 'wrong-network'
      : original(method, params),
  );
  await expect(run(f)).rejects.toMatchObject({ status: 502 });
});
it('cancels a stalled provider without preparing or retaining approval state', async () => {
  f = await pairWalletFixture();
  f.rpc.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController(),
    pending = run(f, 'alice', controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
  expect(f.quote).not.toHaveBeenCalled();
});
