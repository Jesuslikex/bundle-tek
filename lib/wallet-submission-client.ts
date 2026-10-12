import {
  createClient,
  type MicroLamports,
  type TransactionSigner,
} from '@solana/kit';
import { planAndSendTransactions } from '@solana/kit-plugin-instruction-plan';
import {
  rpcGetMinimumBalance,
  rpcTransactionPlanner,
  rpcTransactionPlanExecutor,
} from '@solana/kit-plugin-rpc';
import { memoProgram } from '@solana-program/memo';
import { systemProgram } from '@solana-program/system';
import { associatedTokenProgram, tokenProgram } from '@solana-program/token';
import type { AppClient } from './solana-client';
import { recoverableWalletSigner } from './recoverable-wallet-signer';

export function createWalletSubmissionClient(
  client: Pick<AppClient, 'rpc' | 'rpcSubscriptions'>,
  signer: TransactionSigner,
  recordSignature: (signature: string) => Promise<void>,
  assertCurrent: () => void,
) {
  const payer = recoverableWalletSigner(signer, recordSignature, assertCurrent);
  return createClient({
    payer,
    rpc: client.rpc,
    rpcSubscriptions: client.rpcSubscriptions,
  })
    .use(rpcGetMinimumBalance())
    .use(
      rpcTransactionPlanner({
        microLamportsPerComputeUnit: 1_000n as MicroLamports,
      }),
    )
    .use(rpcTransactionPlanExecutor())
    .use(planAndSendTransactions())
    .use(memoProgram())
    .use(systemProgram())
    .use(tokenProgram())
    .use(associatedTokenProgram());
}
