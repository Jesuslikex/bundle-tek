import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { probePumpGroupReplay } from './pump-group-runtime-probe';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const payer = bs58.encode(new Uint8Array(32).fill(2));
const account = (lamports: string) => ({
  owner: '11111111111111111111111111111111',
  executable: false,
  lamports,
  data: ['', 'base64'],
});
function fixture(kind = 'ok') {
  const calls: { method: string; params: unknown[] }[] = [];
  let genesis = 0;
  const rpc: PumpLaunchRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash')
      return ++genesis === 2 && kind === 'network'
        ? 'other'
        : SOLANA_MAINNET_GENESIS;
    if (method === 'getLatestBlockhash')
      return {
        context: { slot: '100' },
        value: {
          blockhash: bs58.encode(new Uint8Array(32).fill(3)),
          lastValidBlockHeight: '1000',
        },
      };
    if (method === 'getAccountInfo')
      return { context: { slot: '100' }, value: account('100000') };
    if (method === 'simulateBundle')
      return {
        context: { slot: kind === 'bank' ? '99' : '100' },
        value: {
          summary: 'succeeded',
          transactionResults: [
            {
              err: null,
              replacementBlockhash: kind === 'lifetime' ? 'changed' : null,
              preExecutionAccounts: [account('100000')],
              postExecutionAccounts: [account('95000')],
            },
            {
              err: null,
              preExecutionAccounts: [
                account(kind === 'continuity' ? '96000' : '95000'),
              ],
              postExecutionAccounts: [account('90000')],
            },
          ],
        },
      };
    throw new Error('Mutation rejected');
  };
  return { rpc, calls };
}
it('probes two distinct unsigned v1 packets, exact bank and coherent fee-only effects without a send', async () => {
  const f = fixture();
  const result = await probePumpGroupReplay(
    payer,
    f.rpc,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    classification: 'nonempty-v1-sequential-profile-verified',
    packetCount: 2,
    networkFeesRaw: ['5000', '5000'],
    signingAllowed: false,
    executionAllowed: false,
    broadcasts: 0,
    programAttestationRequired: true,
  });
  const params = f.calls.find(
    (call) => call.method === 'simulateBundle',
  )!.params;
  const transactions = (params[0] as { encodedTransactions: string[] })
    .encodedTransactions;
  expect(new Set(transactions).size).toBe(2);
  for (const raw of transactions) {
    const tx = getTransactionDecoder().decode(Buffer.from(raw, 'base64'));
    expect(Object.values(tx.signatures).every((value) => value === null)).toBe(
      true,
    );
    expect(
      getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version,
    ).toBe(1);
  }
  expect(params[1]).toMatchObject({
    simulationBank: { slot: 100 },
    skipSigVerify: true,
    replaceRecentBlockhash: false,
  });
  expect(f.calls.some((call) => /send|sign/.test(call.method))).toBe(false);
});
it.each(['bank', 'lifetime', 'continuity', 'network'])(
  'rejects %s replay evidence',
  async (kind) => {
    const f = fixture(kind);
    await expect(
      probePumpGroupReplay(payer, f.rpc, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it('aborts a stalled provider that ignores its signal', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = probePumpGroupReplay(
    payer,
    async () => {
      entered();
      return new Promise(() => {});
    },
    controller.signal,
  );
  await started;
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
