import { getCompiledTransactionMessageDecoder } from '@solana/kit-v1';
import { pumpLaunchGroupSettlementFixture } from './pump-launch-group-settlement-fixture';
import { collectPumpLaunchGroupFunding } from '../lib/pump-holder-funding';
import { collectPumpLaunchGroupSimulation } from '../lib/pump-launch-group-simulation';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';

export async function pumpLaunchGroupSimulationFixture(
  stock = false,
  token22 = false,
  upgradeable = false,
  quoteInput = true,
) {
  const f = await pumpLaunchGroupSettlementFixture(
    stock,
    token22,
    true,
    quoteInput,
    upgradeable,
  );
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    rent: '1000000',
    afterRent: false,
    changeSource: false,
    expired: false,
    networkChanged: false,
    changeDeployment: false,
  };
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash')
      return state.afterRent && state.networkChanged
        ? 'other'
        : SOLANA_MAINNET_GENESIS;
    if (method === 'getFeeForMessage')
      return {
        context: { slot: '100' },
        value: (
          BigInt(
            getCompiledTransactionMessageDecoder().decode(
              Buffer.from(params[0] as string, 'base64'),
            ).header.numSignerAccounts,
          ) * 5000n
        ).toString(),
      };
    if (method === 'simulateBundle') return structuredClone(f.response);
    if (
      method === 'getMultipleAccounts' &&
      (params[1] as { dataSlice?: unknown })?.dataSlice
    ) {
      const result = (await f.f.rpc(method, params, signal)) as {
        context: { slot: string };
        value: { data: [string, 'base64'] }[];
      };
      if (state.changeDeployment && state.afterRent) {
        const bytes = Buffer.from(result.value[0].data[0], 'base64');
        bytes[13] ^= 1;
        result.value[0].data[0] = bytes.toString('base64');
      }
      return result;
    }
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: '100' },
        value: (params[0] as string[]).map((address) => {
          const account = structuredClone(f.before.get(address) ?? null);
          if (
            state.afterRent &&
            state.changeSource &&
            address === f.input.create.payer &&
            account
          )
            account.lamports = (BigInt(account.lamports) - 1n).toString();
          return account;
        }),
      };
    if (method === 'getMinimumBalanceForRentExemption') {
      state.afterRent = true;
      return state.rent;
    }
    if (method === 'isBlockhashValid')
      return { context: { slot: '100' }, value: true };
    if (method === 'getBlockHeight')
      return state.afterRent && state.expired ? '995' : '900';
    throw new Error('Unexpected provider method');
  };
  const funding = await collectPumpLaunchGroupFunding(
    f.input,
    f.limits,
    {
      minimumSlot: 100,
      maximumSlot: 100,
      accountHashes: f.evidence.creationAccountHashes,
    },
    new AbortController().signal,
    rpc,
  );
  calls.length = 0;
  const creation = {
    accountHashes: f.evidence.creationAccountHashes,
    programDeploymentHashes: structuredClone(
      f.creation.simulation.programDeploymentHashes,
    ),
    expiresAt: new Date(Date.now() + 59000).toISOString(),
  };
  const run = (provider = rpc, signal = new AbortController().signal) =>
    collectPumpLaunchGroupSimulation(
      f.input,
      f.limits,
      funding,
      creation,
      signal,
      provider,
    );
  return {
    ...f,
    creationPreflight: f.creation,
    funding,
    creation,
    rpc,
    calls,
    state,
    run,
  };
}
