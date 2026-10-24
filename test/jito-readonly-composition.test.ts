/** Composition test with an explicit runtime-stage double. Raw swap, asset,
 * lookup, fee/frame and economic replay are real. This fixture has deliberately
 * fake program code and MUST NOT be described as actual runtime qualification. */
import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from './jito-raw-response-fixture';
import { captureJitoSwapSimulation } from '../lib/jito-swap-simulation-capture';
import { collectJitoReadOnlyQualification } from '../lib/jito-readonly-qualification';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { PAIR_RENT } from '../lib/pair-rent-evidence';
const doubles = vi.hoisted(() => ({ scans: vi.fn(), check: vi.fn() }));
const fixtureBody = (init?: RequestInit) => {
  if (typeof init?.body !== 'string')
    throw Error('Expected fixture request body');
  return JSON.parse(init.body);
};
vi.mock('../lib/jito-runtime-evidence', async (original) => ({
  ...(await original<typeof import('../lib/jito-runtime-evidence')>()),
  collectJitoRuntimeEvidence: doubles.scans,
  verifyJitoRuntimeBracket: doubles.check,
}));

async function fixture(
  options: {
    side?: 'Buy' | 'Sell';
    lookup?: boolean;
    token2022?: boolean;
  } = {},
  failure = 'none',
) {
  const f = await jitoRawResponseFixture(options),
    e = f.fixture,
    original = e.observations[0],
    s = original.simulation,
    se = s.settlementEvidence!,
    frame = e.result.value.transactionResults[0];
  const account = (value: unknown) => {
    if (value === null) return null;
    const a = value as {
      owner: string;
      executable: boolean;
      lamports?: string;
      data: string[];
    };
    return {
      ...a,
      lamports: BigInt(a.lamports ?? '1000000'),
      rentEpoch: (1n << 64n) - 1n,
      space: BigInt(Buffer.from(a.data[0], 'base64').length),
    };
  };
  const response = (id: unknown, result: unknown) =>
    new Response(f.wire({ jsonrpc: '2.0', id, result }));
  const baseline: typeof fetch = async (_url, init) => {
    const r = fixtureBody(init);
    let result: unknown;
    if (r.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (r.method === 'getBlockHeight') result = 100;
    else if (r.method === 'getFeeForMessage')
      result = { context: { slot: 100n }, value: 5000n };
    else if (r.method === 'getMinimumBalanceForRentExemption')
      result = r.params[0] === 170 ? 2074080n : 2039280n;
    else if (r.method === 'getMultipleAccounts')
      result = {
        context: { slot: BigInt(Math.max(100, r.params[1].minContextSlot)) },
        value: r.params[0].map((key: string) => {
          const mint = [
            original.order.inputMint,
            original.order.outputMint,
          ].indexOf(key);
          if (mint >= 0) return original.mintAccounts.before[mint];
          const table = e.lookupAccounts.find((a) => a.address === key);
          if (table) return table.account;
          const at = se.keys.indexOf(key);
          if (at < 0) throw Error('Unexpected baseline key');
          return frame.preExecutionAccounts[at];
        }),
      };
    else if (r.method === 'simulateTransaction')
      result = {
        context: { slot: 101n },
        value: {
          err: null,
          unitsConsumed: s.unitsConsumed,
          preBalances: se.before,
          postBalances: se.after,
          preTokenBalances: se.preTokens,
          postTokenBalances: se.postTokens,
          accounts: se.postAccounts,
          loadedAddresses: frame.loadedAddresses,
          replacementBlockhash: null,
        },
      };
    else throw Error('Unexpected baseline method');
    return response(r.id, result);
  };
  const capsule = await captureJitoSwapSimulation(
    original.order,
    new AbortController().signal,
    baseline,
  );
  const methods: string[] = [];
  let observed = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const r = fixtureBody(init);
    methods.push(Array.isArray(r) ? 'batch' : r.method);
    if (Array.isArray(r)) {
      observed = true;
      return new Response(
        f.wire(
          r.map((row) =>
            row.method === 'getFeeForMessage'
              ? {
                  jsonrpc: '2.0',
                  id: row.id,
                  result: { context: { slot: 101n }, value: 5000n },
                }
              : { ...f.envelope, id: row.id },
          ),
        ),
      );
    }
    if (r.method === 'getGenesisHash')
      return response(r.id, SOLANA_MAINNET_GENESIS);
    if (r.method === 'simulateBundle')
      return new Response(f.wire({ ...f.envelope, id: r.id }));
    if (r.method === 'getMultipleAccounts') {
      const keys = r.params[0] as string[];
      const values = keys.map((key) => {
        if (key === PAIR_RENT) {
          const a = account(e.rentAccounts.before)!;
          if (failure === 'rent-change' && observed) {
            const b = Buffer.from(a.data[0], 'base64');
            b[0] ^= 1;
            a.data = [b.toString('base64'), 'base64'];
          }
          return a;
        }
        const at = [
          original.order.inputMint,
          original.order.outputMint,
        ].indexOf(key);
        if (at >= 0) return account(original.mintAccounts.before[at]);
        const table = e.lookupAccounts.find((a) => a.address === key);
        if (!table) throw Error('Unexpected bundle key');
        return account(table.account);
      });
      return response(r.id, {
        context: {
          slot:
            failure === 'late-slot' && observed
              ? 133n
              : BigInt(
                  Math.max(observed ? 102 : 101, r.params[1].minContextSlot),
                ),
        },
        value: values,
      });
    }
    throw Error('Unexpected diagnostic method');
  };
  doubles.scans.mockReset();
  doubles.check.mockReset();
  doubles.scans.mockImplementation(
    async (keys: string[], minimumSlot: number, minimumReadSlot: number) => ({
      format: 'test-double-not-runtime-proof',
      keys,
      minimumSlot,
      minimumReadSlot,
      maximumSlot: minimumReadSlot,
    }),
  );
  doubles.check.mockResolvedValue({
    conservativeRuntimeChecksPassed: true,
    runtimePrivilegesVerified: false,
    runtimeAttested: false,
    fixtureOnly: true,
  });
  return { f, e, capsule, fetcher, methods };
}
for (const side of ['Buy', 'Sell'] as const)
  for (const lookup of [false, true])
    for (const token2022 of [false, true])
      it(`composes full raw ${side}/ALT=${lookup}/2022=${token2022} economics with a declared runtime double`, async () => {
        const x = await fixture({ side, lookup, token2022 });
        const result = await collectJitoReadOnlyQualification(
          x.e.manifest,
          [x.capsule],
          new AbortController().signal,
          { fetcher: x.fetcher, pace: async () => {} },
        );
        expect(result).toMatchObject({
          status: 'checks-passed',
          rawSimulationChecksPassed: true,
          readOnlyLocalChecksPassed: true,
          fullProviderQualification: false,
          signingAllowed: false,
          executionAllowed: false,
          runtimePrivilegesVerified: false,
          runtimeAttested: false,
        });
        if (result.status === 'checks-passed') {
          expect(result.economic.frameEconomicChecksPassed).toBe(true);
          expect(result.assetProof.mintPolicyChecksPassed).toBe(true);
          expect(result.economic.outcomes).toHaveLength(1);
          expect(result.runtimeProof).toHaveProperty('fixtureOnly', true);
        }
        expect(doubles.scans).toHaveBeenCalledTimes(2);
        expect(doubles.check).toHaveBeenCalledTimes(1);
        expect(x.methods.filter((m) => m === 'batch')).toHaveLength(1);
      });
for (const failure of ['rent-change', 'late-slot'])
  it(`refuses ${failure} with no signing clearance or renewed floor`, async () => {
    const x = await fixture({ lookup: true }, failure);
    const result = await collectJitoReadOnlyQualification(
      x.e.manifest,
      [x.capsule],
      new AbortController().signal,
      { fetcher: x.fetcher, pace: async () => {} },
    );
    expect(result).toMatchObject({
      status: 'refused',
      minimumSlot: 100,
      readOnlyLocalChecksPassed: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  });
