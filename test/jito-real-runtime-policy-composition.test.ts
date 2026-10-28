/** Synthetic controller plus real runtime scan. This grants no qualification. */
import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from './jito-raw-response-fixture';
import { captureJitoSwapSimulation } from '../lib/jito-swap-simulation-capture';
import {
  collectJitoReadOnlyQualification,
  collectJitoReadOnlyPrefeeExperiment,
} from '../lib/jito-readonly-qualification';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';

const SYSTEM = '11111111111111111111111111111111';
const NATIVE = 'NativeLoader1111111111111111111111111111111';

it.each([
  ['legacy', collectJitoReadOnlyQualification],
  ['prefee experiment', collectJitoReadOnlyPrefeeExperiment],
] as const)(
  'preserves a real runtime policy refusal through %s and aborts the sibling asset read',
  async (_profile, qualify) => {
    const f = await jitoRawResponseFixture();
    const e = f.fixture;
    const observation = e.observations[0];
    const simulation = observation.simulation;
    const settlement = simulation.settlementEvidence!;
    const frame = e.result.value.transactionResults[0];
    const readBody = (init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw Error('Expected fixture body');
      return JSON.parse(init.body);
    };
    const response = (id: unknown, result: unknown) =>
      new Response(f.wire({ jsonrpc: '2.0', id, result }));
    const baseline: typeof fetch = async (_url, init) => {
      const r = readBody(init);
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
              observation.order.inputMint,
              observation.order.outputMint,
            ].indexOf(key);
            if (mint >= 0) return observation.mintAccounts.before[mint];
            const table = e.lookupAccounts.find((a) => a.address === key);
            if (table) return table.account;
            const at = settlement.keys.indexOf(key);
            if (at < 0) throw Error('Unexpected baseline key');
            return frame.preExecutionAccounts[at];
          }),
        };
      else if (r.method === 'simulateTransaction')
        result = {
          context: { slot: 101n },
          value: {
            err: null,
            unitsConsumed: simulation.unitsConsumed,
            preBalances: settlement.before,
            postBalances: settlement.after,
            preTokenBalances: settlement.preTokens,
            postTokenBalances: settlement.postTokens,
            accounts: settlement.postAccounts,
            loadedAddresses: frame.loadedAddresses,
            replacementBlockhash: null,
          },
        };
      else throw Error('Unexpected baseline method');
      return response(r.id, result);
    };
    const capsule = await captureJitoSwapSimulation(
      observation.order,
      new AbortController().signal,
      baseline,
    );
    const calls: { id: string; method: string }[] = [];
    let startAsset!: () => void;
    const assetStarted = new Promise<void>((resolve) => {
      startAsset = resolve;
    });
    let assetSignal: AbortSignal | undefined;
    const changedBytes = Buffer.from('synthetic native identity mismatch');
    const fetcher: typeof fetch = async (_url, init) => {
      const r = readBody(init);
      if (Array.isArray(r)) throw Error('Unexpected batch');
      calls.push({ id: r.id, method: r.method });
      if (r.id === 'jito-assets:before') {
        assetSignal = init?.signal ?? undefined;
        startAsset();
        return new Promise<Response>((_resolve, reject) => {
          const stop = () => reject(Error('Synthetic asset read aborted'));
          if (assetSignal?.aborted) stop();
          else assetSignal?.addEventListener('abort', stop, { once: true });
        });
      }
      if (r.method === 'getGenesisHash')
        return response(r.id, SOLANA_MAINNET_GENESIS);
      if (
        r.id.startsWith('jito-runtime:') &&
        r.method === 'getMultipleAccounts'
      ) {
        await assetStarted;
        return response(r.id, {
          context: { slot: BigInt(r.params[1].minContextSlot) },
          value: (r.params[0] as string[]).map((key) =>
            key === SYSTEM
              ? {
                  owner: NATIVE,
                  executable: true,
                  lamports: 1n,
                  rentEpoch: 0n,
                  space: BigInt(changedBytes.length),
                  data: [changedBytes.toString('base64'), 'base64'],
                }
              : null,
          ),
        });
      }
      throw Error('Unexpected qualification request');
    };
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('Network forbidden'));
    try {
      const result = await qualify(
        e.manifest,
        [capsule],
        new AbortController().signal,
        { fetcher, pace: async () => {} },
      );
      expect(result).toMatchObject({
        status: 'refused',
        stage: 'runtime-before',
        diagnosis: {
          reason: 'program-policy-refused',
          signingAllowed: false,
          executionAllowed: false,
        },
        fullProviderQualification: false,
        readOnlyLocalChecksPassed: false,
        providerQualified: false,
        sourceCurrent: false,
        signatureVerified: false,
        runtimePrivilegesVerified: false,
        runtimeAttested: false,
        signingAllowed: false,
        executionAllowed: false,
        automaticExecutionAllowed: false,
        receiptVerified: false,
      });
      if (result.status !== 'refused') throw Error('Expected policy refusal');
      expect(result.diagnosis?.differences).toHaveLength(1);
      expect(result.diagnosis?.differences[0].address).toBe(SYSTEM);
      expect(result.evidence.runtimeAfter).toBeNull();
      expect(result.evidence.attempt).toBeNull();
      expect(assetSignal?.aborted).toBe(true);
      // The serial scanner brackets its one initial scan with two genesis reads.
      expect(
        calls.filter(
          (call) =>
            call.id.startsWith('jito-runtime:') &&
            call.method === 'getGenesisHash',
        ),
      ).toHaveLength(2);
      expect(
        result.evidence.timing.events.some(
          (event) => event.phase === 'runtime-after',
        ),
      ).toBe(false);
      expect(
        calls.some(
          (call) =>
            call.method === 'simulateBundle' ||
            call.method === 'simulateTransaction' ||
            call.method === 'sendBundle' ||
            call.method === 'sendTransaction',
        ),
      ).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
);
