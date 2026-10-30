import { expect, it, vi } from 'vitest';
import { jitoSequentialEconomicsFixture } from '../test/jito-sequential-economics-fixture';
import { verifyJitoBundleEconomicObservation as verify } from './jito-bundle-economics';
const cases = [];
for (const side of ['Buy', 'Sell'] as const)
  for (const lookup of [false, true])
    for (const token2022 of [false, true])
      for (const keepWrapped of [false, true])
        for (const wallets of [1, 2, 3, 4])
          cases.push({ side, lookup, token2022, keepWrapped, wallets });
it.each(cases)(
  'derives complete sequential native/SPL economics for %j',
  async (options) => {
    const f = await jitoSequentialEconomicsFixture(options);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('network forbidden'));
    try {
      const result = await verify(f);
      expect(result.outcomes).toHaveLength(options.wallets);
      for (const outcome of result.outcomes) {
        expect(outcome.observedOutputRaw).toBe(
          options.side === 'Buy' ? '1000' : '1000000',
        );
        expect(outcome.inputRaw).toBe(
          options.side === 'Buy' ? '1000000' : '1000',
        );
        expect(outcome.networkFeeLamports).toBe('5000');
      }
      expect(result.networkFeeLamports).toBe(
        String((options.wallets + 1) * 5000),
      );
      expect(result.walletStates).toHaveLength(options.wallets);
      for (const [i, state] of result.walletStates.entries()) {
        const tokenRent = options.token2022 ? 2074080n : 2039280n;
        const tip = i === 0 ? 6000n : 0n;
        const expected =
          options.side === 'Buy'
            ? 100000000n -
              1000000n -
              5000n -
              tokenRent -
              (options.keepWrapped ? 2039280n : 0n) -
              tip
            : 100000000n -
              5000n +
              (options.keepWrapped ? -2039280n : 1000000n) -
              tip;
        expect(state.initialSolRaw).toBe('100000000');
        expect(state.finalSolRaw).toBe(expected.toString());
        expect(state.initialTokenAccounts).toHaveLength(
          options.side === 'Buy' ? 0 : 1,
        );
        expect(state.finalTokenAccounts).toHaveLength(
          options.keepWrapped ? 2 : 1,
        );
        const native = state.finalTokenAccounts.find(
          (t) => t.mint === 'So11111111111111111111111111111111111111112',
        );
        expect(native?.uiTokenAmount.amount).toBe(
          options.keepWrapped
            ? options.side === 'Buy'
              ? '0'
              : '1000000'
            : undefined,
        );
        const asset = state.finalTokenAccounts.find(
          (t) => t.mint !== 'So11111111111111111111111111111111111111112',
        )!;
        expect(asset.uiTokenAmount.amount).toBe(
          options.side === 'Buy' ? '1000' : '0',
        );
        for (const token of [
          ...state.initialTokenAccounts,
          ...state.finalTokenAccounts,
        ])
          expect(state.accountKeys[Number(token.accountIndex)]).toBe(
            token.address,
          );
      }
      expect(result.tip.amountRaw).toBe('1000');
      expect(result).toMatchObject({
        frameEconomicChecksPassed: true,
        signingAllowed: false,
        executionAllowed: false,
        automaticExecutionAllowed: false,
        providerQualified: false,
        networkVerified: false,
        sourceCurrent: false,
        signatureVerified: false,
        receiptVerified: false,
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
);
function tokenUnits(account: { data: string[] }, units: bigint) {
  const bytes = Buffer.from(account.data[0], 'base64');
  bytes.writeBigUInt64LE(units, 64);
  account.data[0] = bytes.toString('base64');
}
it('refuses a worse later swap output even when every individual simulation still passes', async () => {
  const f = await jitoSequentialEconomicsFixture({
    wallets: 2,
    lookup: true,
    token2022: true,
  });
  const frame = f.result.value.transactionResults[1];
  const destination =
    f.observations[1].simulation.routeAssessment.decoded!.destinationAccount;
  tokenUnits(
    frame.postExecutionAccounts[f.keys[1].indexOf(destination)]!,
    994n,
  );
  await expect(verify(f)).rejects.toThrow(/token units differ/);
});
it('allows improved output and reports the actual raw value rather than old individual output', async () => {
  const f = await jitoSequentialEconomicsFixture();
  const dest =
    f.observations[0].simulation.routeAssessment.decoded!.destinationAccount;
  tokenUnits(
    f.result.value.transactionResults[0].postExecutionAccounts[
      f.keys[0].indexOf(dest)
    ]!,
    1200n,
  );
  tokenUnits(
    f.result.value.transactionResults[0].postExecutionAccounts[
      f.keys[0].indexOf(f.poolToken)
    ]!,
    998800n,
  );
  expect((await verify(f)).outcomes[0].observedOutputRaw).toBe('1200');
});
it('refuses worse native Sell output while preserving complete frame conservation', async () => {
  const f = await jitoSequentialEconomicsFixture({ side: 'Sell' }),
    [swap, tip] = f.result.value.transactionResults;
  swap.postExecutionAccounts[0]!.lamports = String(
    BigInt(swap.postExecutionAccounts[0]!.lamports) - 6000n,
  );
  const pool = f.keys[0].indexOf(f.pool);
  swap.postExecutionAccounts[pool]!.lamports = String(
    BigInt(swap.postExecutionAccounts[pool]!.lamports) + 6000n,
  );
  tip.preExecutionAccounts[0]!.lamports =
    swap.postExecutionAccounts[0]!.lamports;
  tip.postExecutionAccounts[0]!.lamports = String(
    BigInt(tip.preExecutionAccounts[0]!.lamports) - 6000n,
  );
  await expect(verify(f)).rejects.toThrow(/minimum native output/);
});
it('refuses extra retained token rent rather than hiding it in the native net', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    [swap, tip] = f.result.value.transactionResults;
  const dest =
    f.observations[0].simulation.routeAssessment.decoded!.destinationAccount;
  const account = swap.postExecutionAccounts[f.keys[0].indexOf(dest)]!;
  account.lamports = String(BigInt(account.lamports) + 1n);
  swap.postExecutionAccounts[0]!.lamports = String(
    BigInt(swap.postExecutionAccounts[0]!.lamports) - 1n,
  );
  tip.preExecutionAccounts[0]!.lamports =
    swap.postExecutionAccounts[0]!.lamports;
  tip.postExecutionAccounts[0]!.lamports = String(
    BigInt(tip.preExecutionAccounts[0]!.lamports) - 6000n,
  );
  await expect(verify(f)).rejects.toThrow(/unchanged account rent/);
});
it('refuses a tip that credits one extra lamport despite preserving the fee', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    tip = f.result.value.transactionResults.at(-1)!;
  tip.postExecutionAccounts[0]!.lamports = String(
    BigInt(tip.postExecutionAccounts[0]!.lamports) - 1n,
  );
  tip.postExecutionAccounts[1]!.lamports = String(
    BigInt(tip.postExecutionAccounts[1]!.lamports) + 1n,
  );
  await expect(verify(f)).rejects.toThrow(
    /exact tip debit credit fee or reserve/,
  );
});
it('refuses changed independent mint policy', async () => {
  const f = await jitoSequentialEconomicsFixture({ token2022: true });
  const a = f.observations[0].mintAccounts.after[1] as { data: string[] };
  const data = Buffer.from(a.data[0], 'base64');
  data[44] = 7;
  a.data[0] = data.toString('base64');
  await expect(verify(f)).rejects.toThrow(
    /mint programs or extension bytes changed/,
  );
});
it('refuses stale or unbracketed mint evidence without renewing the review', async () => {
  const f = await jitoSequentialEconomicsFixture();
  f.observations[0].mintAccounts.recheckSlot = 100;
  await expect(verify(f)).rejects.toThrow(/does not bracket/);
});
it('refuses changed native minimum, packet or wallet in the original observation', async () => {
  for (const field of ['minimum', 'packet', 'wallet']) {
    const f = await jitoSequentialEconomicsFixture();
    if (field === 'minimum') f.observations[0].order.minimumOutAmount = '1';
    if (field === 'packet')
      f.observations[0].order.preparation.transaction =
        f.manifest.tip.transaction;
    if (field === 'wallet')
      f.observations[0].order.preparation.wallet = f.tipRecipient;
    await expect(verify(f)).rejects.toThrow();
  }
});
it('refuses inconsistent full-frame or fee metadata', async () => {
  for (const field of ['fee', 'bank', 'partial']) {
    const f = await jitoSequentialEconomicsFixture();
    if (field === 'fee') f.result.value.transactionResults[0].fee = '5001';
    if (field === 'bank') f.result.context.slot++;
    if (field === 'partial') f.result.value.transactionResults.pop();
    await expect(verify(f)).rejects.toThrow();
  }
});
it('refuses another selected wallet receiving an unreviewed token account in an earlier swap', async () => {
  const f = await jitoSequentialEconomicsFixture({ wallets: 2 });
  const first = f.result.value.transactionResults[0],
    second = f.result.value.transactionResults[1];
  const pool = f.keys[0].indexOf(f.pool),
    nextPool = f.keys[1].indexOf(f.pool);
  const destination =
    f.observations[1].simulation.routeAssessment.decoded!.destinationAccount;
  const alien = structuredClone(
    second.postExecutionAccounts[f.keys[1].indexOf(destination)]!,
  );
  alien.lamports = first.postExecutionAccounts[pool]!.lamports;
  first.postExecutionAccounts[pool] = alien;
  second.preExecutionAccounts[nextPool] = structuredClone(alien);
  await expect(verify(f)).rejects.toThrow(/another selected wallet changed/);
});

it('requires tip funds upfront even if a Sell would later generate enough SOL', async () => {
  const f = await jitoSequentialEconomicsFixture({ side: 'Sell' }),
    [swap, tip] = f.result.value.transactionResults;
  const policy = f.manifest.swaps[0].settlement!;
  const required =
    BigInt(policy.maximumNativeDebitLamports) +
    BigInt(f.manifest.tip.maximumDebitRaw) +
    BigInt(f.manifest.tip.reserveLamports);
  const start = required - 1n,
    shift = BigInt(swap.preExecutionAccounts[0]!.lamports) - start;
  swap.preExecutionAccounts[0]!.lamports = String(start);
  swap.postExecutionAccounts[0]!.lamports = String(
    BigInt(swap.postExecutionAccounts[0]!.lamports) - shift,
  );
  tip.preExecutionAccounts[0]!.lamports =
    swap.postExecutionAccounts[0]!.lamports;
  tip.postExecutionAccounts[0]!.lamports = String(
    BigInt(tip.preExecutionAccounts[0]!.lamports) - 6000n,
  );
  expect(BigInt(tip.preExecutionAccounts[0]!.lamports)).toBeGreaterThan(
    BigInt(f.manifest.tip.maximumDebitRaw) +
      BigInt(f.manifest.tip.reserveLamports),
  );
  await expect(verify(f)).rejects.toThrow(
    'upfront funding relies on earlier proceeds',
  );
});
it('rejects standard mint precision that contradicts the original independently simulated precision', async () => {
  const f = await jitoSequentialEconomicsFixture();
  for (const list of [
    f.observations[0].mintAccounts.before,
    f.observations[0].mintAccounts.after,
  ]) {
    const raw = list[1] as { data: string[] };
    const data = Buffer.from(raw.data[0], 'base64');
    data[44] = 7;
    raw.data[0] = data.toString('base64');
  }
  await expect(verify(f)).rejects.toThrow(
    'independent mint differs from original precision or program',
  );
});
it('captures inputs before awaiting and refuses own getters without invoking them', async () => {
  const f = await jitoSequentialEconomicsFixture();
  const getter = vi.fn(() => f.observations);
  const value = { ...f };
  Object.defineProperty(value, 'observations', {
    get: getter,
    enumerable: true,
  });
  await expect(verify(value)).rejects.toThrow('input accessor refused');
  expect(getter).not.toHaveBeenCalled();
  const promise = verify(f);
  f.result.value.transactionResults[0].fee = '5001';
  expect((await promise).frameEconomicChecksPassed).toBe(true);
});
it('replays old unsigned evidence without claiming present source or blockhash validity', async () => {
  const f = await jitoSequentialEconomicsFixture();
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.manifest.expiresAt) + 86400000);
  try {
    expect(await verify(f)).toMatchObject({
      sourceCurrent: false,
      signingAllowed: false,
      executionAllowed: false,
      receiptVerified: false,
    });
  } finally {
    now.mockRestore();
  }
});

for (const later of [false, true])
  it(
    'protects selected wallet SOL in a ' +
      (later ? 'later' : 'earlier') +
      ' other-payer packet',
    async () => {
      const f = await jitoSequentialEconomicsFixture({
        wallets: 2,
        exposeOtherWallets: true,
      });
      const [first, second, tip] = f.result.value.transactionResults;
      if (!later) {
        const b = f.keys[0].indexOf(f.walletRoster[1]),
          pool = f.keys[0].indexOf(f.pool),
          nextPool = f.keys[1].indexOf(f.pool);
        first.postExecutionAccounts[b]!.lamports = String(
          BigInt(first.postExecutionAccounts[b]!.lamports) - 1n,
        );
        first.postExecutionAccounts[pool]!.lamports = String(
          BigInt(first.postExecutionAccounts[pool]!.lamports) + 1n,
        );
        second.preExecutionAccounts[0]!.lamports =
          first.postExecutionAccounts[b]!.lamports;
        second.postExecutionAccounts[0]!.lamports = String(
          BigInt(second.postExecutionAccounts[0]!.lamports) - 1n,
        );
        second.preExecutionAccounts[nextPool]!.lamports =
          first.postExecutionAccounts[pool]!.lamports;
        second.postExecutionAccounts[nextPool]!.lamports = String(
          BigInt(second.postExecutionAccounts[nextPool]!.lamports) + 1n,
        );
      } else {
        const a = f.keys[1].indexOf(f.walletRoster[0]),
          pool = f.keys[1].indexOf(f.pool);
        second.postExecutionAccounts[a]!.lamports = String(
          BigInt(second.postExecutionAccounts[a]!.lamports) - 1n,
        );
        second.postExecutionAccounts[pool]!.lamports = String(
          BigInt(second.postExecutionAccounts[pool]!.lamports) + 1n,
        );
        tip.preExecutionAccounts[0]!.lamports =
          second.postExecutionAccounts[a]!.lamports;
        tip.postExecutionAccounts[0]!.lamports = String(
          BigInt(tip.postExecutionAccounts[0]!.lamports) - 1n,
        );
      }
      await expect(verify(f)).rejects.toThrow(
        'another selected wallet changed in this packet',
      );
    },
  );
it('refuses impossible aggregate balances above a mint supply observed inside the same vector', async () => {
  const f = await jitoSequentialEconomicsFixture({ wallets: 2 });
  const mint = f.observations[0].order.outputMint;
  for (let i = 0; i < 2; i++) {
    for (const state of [
      f.result.value.transactionResults[i].preExecutionAccounts,
      f.result.value.transactionResults[i].postExecutionAccounts,
    ]) {
      const a = state[f.keys[i].indexOf(mint)]!;
      const data = Buffer.from(a.data[0], 'base64');
      data.writeBigUInt64LE(1500n, 36);
      a.data[0] = data.toString('base64');
    }
  }
  await expect(verify(f)).rejects.toThrow(
    'observed token balances exceed in-frame mint supply',
  );
});

it('refuses hidden native reallocation into extra WSOL even if the net Sell output still meets its minimum', async () => {
  const f = await jitoSequentialEconomicsFixture({
    side: 'Sell',
    keepWrapped: true,
  });
  const [swap, tip] = f.result.value.transactionResults;
  const wrapped =
    f.observations[0].simulation.routeAssessment.decoded!.destinationAccount;
  const account = swap.postExecutionAccounts[f.keys[0].indexOf(wrapped)]!;
  tokenUnits(account, 1600000n);
  account.lamports = String(BigInt(account.lamports) + 600000n);
  swap.postExecutionAccounts[0]!.lamports = String(
    BigInt(swap.postExecutionAccounts[0]!.lamports) - 600000n,
  );
  tip.preExecutionAccounts[0]!.lamports =
    swap.postExecutionAccounts[0]!.lamports;
  tip.postExecutionAccounts[0]!.lamports = String(
    BigInt(tip.postExecutionAccounts[0]!.lamports) - 600000n,
  );
  await expect(verify(f)).rejects.toThrow(
    'observed native debit exceeds approved policy',
  );
});
it('requires the independent System reserve even if a caller rehashes a zero-reserve review', async () => {
  const f = await jitoSequentialEconomicsFixture();
  f.manifest.tip.reserveLamports = '0';
  const { bundleFingerprint } = await import('./jito-bundle');
  const { sha256, ...terms } = f.manifest;
  expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  f.manifest.sha256 = await bundleFingerprint(terms);
  await expect(verify(f)).rejects.toThrow(
    'tip reserve below independently observed System minimum',
  );
});
for (const remaining of [0n, 890880n, 890879n])
  it(
    'checks independently observed post-payer rent boundary ' + remaining,
    async () => {
      const f = await jitoSequentialEconomicsFixture({
        side: 'Sell',
        keepWrapped: true,
        wallets: 2,
      });
      const second = f.result.value.transactionResults[1];
      const delta =
        BigInt(second.postExecutionAccounts[0]!.lamports) - remaining;
      second.preExecutionAccounts[0]!.lamports = String(
        BigInt(second.preExecutionAccounts[0]!.lamports) - delta,
      );
      second.postExecutionAccounts[0]!.lamports = String(remaining);
      if (remaining === 890879n)
        await expect(verify(f)).rejects.toThrow(
          'payer ends below independently observed System minimum',
        );
      else
        expect((await verify(f)).minimumSystemReserveLamports).toBe('890880');
    },
  );
it('requires an existing Tip Payment recipient, even if full-frame conservation agrees', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    tip = f.result.value.transactionResults.at(-1)!;
  tip.preExecutionAccounts[1] = null;
  tip.postExecutionAccounts[1]!.lamports = '1000';
  await expect(verify(f)).rejects.toThrow(
    'exact tip debit credit fee or reserve differs',
  );
});
it('rejects missing, mismatched or unbracketed independent Rent evidence', async () => {
  for (const change of ['missing', 'data', 'bank']) {
    const f = await jitoSequentialEconomicsFixture();
    if (change === 'missing') Reflect.deleteProperty(f, 'rentAccounts');
    if (change === 'data') {
      const raw = f.rentAccounts.after as { data: string[] };
      const bytes = Buffer.from(raw.data[0], 'base64');
      bytes.writeBigUInt64LE(3481n, 0);
      raw.data[0] = bytes.toString('base64');
    }
    if (change === 'bank') f.rentAccounts.recheckSlot = 100;
    await expect(verify(f)).rejects.toThrow(/Rent/);
  }
});

it('refuses new output units without a matching pool debit or mint supply change', async () => {
  const f = await jitoSequentialEconomicsFixture();
  const dest =
    f.observations[0].simulation.routeAssessment.decoded!.destinationAccount;
  tokenUnits(
    f.result.value.transactionResults[0].postExecutionAccounts[
      f.keys[0].indexOf(dest)
    ]!,
    1200n,
  );
  await expect(verify(f)).rejects.toThrow(
    'non-native vault units do not conserve against mint supply',
  );
});
it('refuses foreign WSOL vault amounts not backed by matching lamports and reserves', async () => {
  const f = await jitoSequentialEconomicsFixture({
    side: 'Buy',
    keepWrapped: true,
  });
  const raw =
    f.result.value.transactionResults[0].postExecutionAccounts[
      f.keys[0].indexOf(f.pool)
    ]!;
  const bytes = Buffer.from(raw.data[0], 'base64');
  bytes.writeBigUInt64LE(1n, 113);
  raw.data[0] = bytes.toString('base64');
  await expect(verify(f)).rejects.toThrow(
    'observed native-pair vault backing differs',
  );
});

for (const mutation of ['system', 'mint', 'mint-shaped', 'reserve'])
  it(
    'refuses foreign vault reclassification or reserve edits: ' + mutation,
    async () => {
      const f = await jitoSequentialEconomicsFixture();
      const frame = f.result.value.transactionResults[0];
      const index = f.keys[0].indexOf(
        mutation === 'reserve' ? f.pool : f.poolToken,
      );
      const raw = frame.postExecutionAccounts[index]!;
      const bytes = Buffer.from(raw.data[0], 'base64');
      // With 1000 units initially, disappearing this vault offsets exactly the
      // wallet's 1000-unit output. Aggregate conservation alone would accept it.
      if (mutation !== 'reserve')
        tokenUnits(frame.preExecutionAccounts[index]!, 1000n);
      if (mutation === 'system') {
        raw.owner = '11111111111111111111111111111111';
        raw.data[0] = '';
      } else if (mutation === 'mint') {
        bytes.fill(0, 0, 32);
        raw.data[0] = bytes.toString('base64');
      } else if (mutation === 'mint-shaped') {
        const mint = Buffer.alloc(82);
        mint[44] = 6;
        mint[45] = 1;
        raw.data[0] = mint.toString('base64');
      } else {
        bytes.writeBigUInt64LE(bytes.readBigUInt64LE(113) - 1n, 113);
        bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64) + 1n, 64);
        raw.data[0] = bytes.toString('base64');
      }
      await expect(verify(f)).rejects.toThrow(/native-pair vault/);
    },
  );

for (const token2022 of [false, true])
  it(
    'accounts for a matching in-frame input burn without inventing vault credits (2022=' +
      token2022 +
      ')',
    async () => {
      const f = await jitoSequentialEconomicsFixture({
        side: 'Sell',
        wallets: 4,
        lookup: true,
        token2022,
        burnInput: true,
        includeRentSysvar: true,
      });
      const result = await verify(f);
      expect(result.tokenConservationCheckedMints).toEqual([
        f.observations[0].order.inputMint,
      ]);
      expect(result.outcomes.map((o) => o.observedOutputRaw)).toEqual([
        '1000000',
        '1000000',
        '1000000',
        '1000000',
      ]);
      expect(
        result.walletStates.every(
          (w) =>
            w.finalTokenAccounts.find(
              (t) => t.mint === f.observations[0].order.inputMint,
            )!.uiTokenAmount.amount === '0',
        ),
      ).toBe(true);
    },
  );
it('verifies in-frame Rent identity instead of trusting an unrelated independent sysvar response', async () => {
  const f = await jitoSequentialEconomicsFixture({ includeRentSysvar: true });
  const rent = f.keys[0].indexOf('SysvarRent111111111111111111111111111111111');
  for (const states of [
    f.result.value.transactionResults[0].preExecutionAccounts,
    f.result.value.transactionResults[0].postExecutionAccounts,
  ]) {
    const raw = states[rent]!;
    const data = Buffer.from(raw.data[0], 'base64');
    data.writeBigUInt64LE(3479n, 0);
    raw.data[0] = data.toString('base64');
  }
  await expect(verify(f)).rejects.toThrow('in-frame Rent differs');
});
it('requires token-account rent to match the independently observed profile, not only an old simulation', async () => {
  const f = await jitoSequentialEconomicsFixture();
  for (const raw of [f.rentAccounts.before, f.rentAccounts.after]) {
    const data = Buffer.from(raw.data[0], 'base64');
    data.writeBigUInt64LE(3479n, 0);
    raw.data[0] = data.toString('base64');
  }
  await expect(verify(f)).rejects.toThrow(
    'token rent differs from independently observed Rent profile',
  );
});
it('rejects the former synthetic System recipient and an eight-byte receiver below actual rent', async () => {
  for (const kind of ['system', 'rent']) {
    const f = await jitoSequentialEconomicsFixture();
    const last = f.result.value.transactionResults.at(-1)!;
    for (const [i, accounts] of [
      last.preExecutionAccounts,
      last.postExecutionAccounts,
    ].entries()) {
      if (kind === 'system') {
        accounts[1]!.owner = '11111111111111111111111111111111';
        accounts[1]!.data = ['', 'base64'];
      } else accounts[1]!.lamports = String(946559 + i * 1000);
    }
    await expect(verify(f)).rejects.toThrow(
      'exact tip debit credit fee or reserve differs',
    );
  }
});

for (const phase of ['before', 'after'])
  it(
    'requires reviewed Tip Payment recipient ' + phase + ' state',
    async () => {
      const f = await jitoSequentialEconomicsFixture(),
        last = f.result.value.transactionResults.at(-1)!;
      const states =
        phase === 'before'
          ? last.preExecutionAccounts
          : last.postExecutionAccounts;
      states[1]!.owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      await expect(verify(f)).rejects.toThrow(
        'exact tip debit credit fee or reserve differs',
      );
    },
  );
