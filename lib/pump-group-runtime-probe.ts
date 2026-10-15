import {
  AccountRole,
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageConfig,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  pumpRpcAccount,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';

/** Read-only unsigned zero-transfer probe. This qualifies only the non-empty v1 replay profile, never Pump program code or signing. */
export async function probePumpGroupReplay(
  payer: string,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  const source = address(payer);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const allowed = new Set([
    'getGenesisHash',
    'getLatestBlockhash',
    'getAccountInfo',
    'simulateBundle',
  ]);
  let reads = 0;
  async function call(method: string, params: unknown[]) {
    deadline.throwIfAborted();
    if (!allowed.has(method) || ++reads > 5)
      throw new Error('Replay probe read budget exceeded.');
    return new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(new Error('Replay probe cancelled or timed out.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) {
        abort();
        deadline.removeEventListener('abort', abort);
        return;
      }
      Promise.resolve()
        .then(() => rpc(method, params, deadline))
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Replay probe requires mainnet.');
  const latest = (await call('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])) as {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: string | number };
  };
  const slot = Number(pumpUnsignedInteger(latest?.context?.slot));
  if (!Number.isSafeInteger(slot) || slot < 0)
    throw new Error('Replay bank is unavailable.');
  const observed = (await call('getAccountInfo', [
    source,
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: slot },
  ])) as { context: { slot: number }; value: unknown };
  const before = pumpRpcAccount(observed?.value);
  if (
    !before ||
    before.owner !== '11111111111111111111111111111111' ||
    before.executable ||
    before.data[0] !== '' ||
    pumpUnsignedInteger(before.lamports) < 20000n ||
    !Number.isSafeInteger(Number(observed?.context?.slot)) ||
    Number(observed.context.slot) < slot ||
    Number(observed.context.slot) - slot > 32
  )
    throw new Error(
      'Public probe source is not a funded plain system account.',
    );
  const bank = Number(pumpUnsignedInteger(observed.context.slot));
  const encodedTransactions = [120000, 121000].map((computeUnitLimit) => {
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    const message = appendTransactionMessageInstructions(
      [
        {
          programAddress: address('11111111111111111111111111111111'),
          accounts: [
            { address: source, role: AccountRole.WRITABLE_SIGNER },
            { address: source, role: AccountRole.WRITABLE },
          ],
          data,
        },
      ],
      setTransactionMessageConfig(
        {
          computeUnitLimit,
          loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
          priorityFeeLamports: 0n,
        },
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.value.blockhash),
            lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
          },
          setTransactionMessageFeePayer(
            source,
            createTransactionMessage({ version: 1 }),
          ),
        ),
      ),
    );
    return getBase64Decoder().decode(
      getTransactionEncoder().encode(compileTransaction(message)),
    );
  });
  const result = (await call('simulateBundle', [
    { encodedTransactions },
    {
      transactionEncoding: 'base64',
      simulationBank: { slot: bank },
      skipSigVerify: true,
      replaceRecentBlockhash: false,
      preExecutionAccountsConfigs: encodedTransactions.map(() => ({
        encoding: 'base64',
        addresses: [source],
      })),
      postExecutionAccountsConfigs: encodedTransactions.map(() => ({
        encoding: 'base64',
        addresses: [source],
      })),
    },
  ])) as {
    context: { slot: number };
    value: {
      summary: unknown;
      transactionResults: {
        err: unknown;
        replacementBlockhash?: unknown;
        preExecutionAccounts: unknown[];
        postExecutionAccounts: unknown[];
      }[];
    };
  };
  if (
    Number(pumpUnsignedInteger(result?.context?.slot)) !== bank ||
    result?.value?.summary !== 'succeeded' ||
    result.value.transactionResults?.length !== 2
  )
    throw new Error(
      'Non-empty v1 replay did not succeed at its requested bank.',
    );
  let prior: ReturnType<typeof pumpRpcAccount> = null;
  const fees: string[] = [];
  for (const [index, item] of result.value.transactionResults.entries()) {
    if (
      item.err !== null ||
      item.replacementBlockhash != null ||
      item.preExecutionAccounts?.length !== 1 ||
      item.postExecutionAccounts?.length !== 1
    )
      throw new Error(
        'Replay probe lacks exact successful packet account coverage.',
      );
    const pre = pumpRpcAccount(item.preExecutionAccounts[0]),
      post = pumpRpcAccount(item.postExecutionAccounts[0]);
    if (
      !pre ||
      !post ||
      pre.owner !== before.owner ||
      post.owner !== before.owner ||
      pre.executable ||
      post.executable ||
      pre.data[0] !== '' ||
      (index === 0 && pre.lamports !== before.lamports) ||
      post.data[0] !== '' ||
      (index > 0 && JSON.stringify(pre) !== JSON.stringify(prior))
    )
      throw new Error('Replay probe account continuity differs.');
    const fee =
      pumpUnsignedInteger(pre.lamports) - pumpUnsignedInteger(post.lamports);
    if (fee <= 0n || fee > 10000n || (index > 0 && fee.toString() !== fees[0]))
      throw new Error('Replay probe fee effects differ.');
    prior = post;
    fees.push(fee.toString());
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Replay provider network changed.');
  deadline.throwIfAborted();
  return {
    format: 'pump-v1-replay-profile-probe-v1' as const,
    classification: 'nonempty-v1-sequential-profile-verified' as const,
    checkedAt: new Date().toISOString(),
    bankSlot: bank,
    packetCount: 2,
    networkFeesRaw: fees,
    reads,
    originalBlockhashRetained: true,
    signingAllowed: false,
    executionAllowed: false,
    programAttestationRequired: true,
    userWallets: 0,
    broadcasts: 0,
  };
}
