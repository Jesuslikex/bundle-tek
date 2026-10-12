import {
  address,
  compileTransaction,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionMessageBytesBase64,
  type TransactionPartialSigner,
} from '@solana/kit';
import { createWalletSubmissionClient } from './wallet-submission-client';
import { requireDevnet } from './devnet-intent';
import { toBaseUnits } from './distribution-plan';
import type { AppClient } from './solana-client';

export async function simulateDevnetFunding(
  client: Pick<AppClient, 'rpc' | 'rpcSubscriptions'>,
  input: {
    wallet: string;
    recipient: string;
    amount: string;
    mint?: string;
    decimals?: number;
    minimumSlot: bigint;
  },
  assertCurrent: () => void,
) {
  if (
    typeof input.minimumSlot !== 'bigint' ||
    input.minimumSlot < 0n ||
    input.minimumSlot >= 1n << 64n
  )
    throw new Error('Invalid funding simulation snapshot slot.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const options = { abortSignal: controller.signal };
  try {
    await requireDevnet(client.rpc);
    assertCurrent();
    const signer: TransactionPartialSigner = {
      address: address(input.wallet),
      signTransactions: async () => {
        throw new Error('Unsigned funding simulation cannot sign.');
      },
    };
    const preview = createWalletSubmissionClient(
      client,
      signer,
      async () => {
        throw new Error('Simulation cannot register a signature.');
      },
      assertCurrent,
    );
    const builder = input.mint
      ? preview.token.instructions.transferToATA({
          payer: preview.payer,
          authority: preview.payer,
          mint: address(input.mint),
          recipient: address(input.recipient),
          amount: toBaseUnits(input.amount, input.decimals!),
          decimals: input.decimals!,
        })
      : preview.system.instructions.transferSol({
          source: preview.payer,
          destination: address(input.recipient),
          amount: toBaseUnits(input.amount, 9),
        });
    const latest = await client.rpc
      .getLatestBlockhash({
        commitment: 'confirmed',
        minContextSlot: input.minimumSlot,
      })
      .send(options);
    assertCurrent();
    const message = setTransactionMessageLifetimeUsingBlockhash(
      latest.value,
      setTransactionMessageComputeUnitLimit(
        1400000,
        await builder.planTransaction(),
      ),
    );
    const transaction = compileTransaction(message);
    assertCurrent();
    const minimumSlot =
      latest.context.slot > input.minimumSlot
        ? latest.context.slot
        : input.minimumSlot;
    const [fee, simulation] = await Promise.all([
      client.rpc
        .getFeeForMessage(
          getBase64Decoder().decode(
            transaction.messageBytes,
          ) as TransactionMessageBytesBase64,
          { commitment: 'confirmed', minContextSlot: minimumSlot },
        )
        .send(options),
      client.rpc
        .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: minimumSlot,
          sigVerify: false,
          replaceRecentBlockhash: false,
        })
        .send(options),
    ]);
    assertCurrent();
    const slots = [
      input.minimumSlot,
      latest.context.slot,
      fee.context.slot,
      simulation.context.slot,
    ];
    if (
      slots.some((slot) => typeof slot !== 'bigint' || slot < 0n) ||
      latest.context.slot < input.minimumSlot ||
      fee.context.slot < minimumSlot ||
      simulation.context.slot < minimumSlot ||
      slots.reduce((a, b) => (a > b ? a : b)) -
        slots.reduce((a, b) => (a < b ? a : b)) >
        150n ||
      fee.value === null ||
      typeof fee.value !== 'bigint' ||
      fee.value < 0n ||
      fee.value > 6400n
    )
      throw new Error(
        'Devnet simulation fee or snapshot is unavailable or exceeds the reviewed allowance. Prepare again.',
      );
    if (simulation.value.err !== null)
      throw new Error(
        'Devnet simulation rejected the saved transfer. Check balances and account state.',
      );
    const units = simulation.value.unitsConsumed;
    if (
      typeof units !== 'bigint' ||
      units <= 0n ||
      units > 1400000n ||
      (simulation.value.fee !== undefined &&
        simulation.value.fee !== null &&
        simulation.value.fee !== fee.value)
    )
      throw new Error(
        'Devnet simulation returned inconsistent resource or fee evidence.',
      );
    const [valid, height] = await Promise.all([
      client.rpc
        .isBlockhashValid(latest.value.blockhash, {
          commitment: 'confirmed',
          minContextSlot: simulation.context.slot,
        })
        .send(options),
      client.rpc
        .getBlockHeight({
          commitment: 'confirmed',
          minContextSlot: simulation.context.slot,
        })
        .send(options),
    ]);
    assertCurrent();
    if (
      valid.value !== true ||
      typeof height !== 'bigint' ||
      height < 0n ||
      typeof latest.value.lastValidBlockHeight !== 'bigint' ||
      height > latest.value.lastValidBlockHeight ||
      typeof valid.context.slot !== 'bigint' ||
      valid.context.slot < simulation.context.slot ||
      valid.context.slot - minimumSlot > 150n
    )
      throw new Error(
        'Devnet simulation blockhash expired or its observation changed. Prepare again.',
      );
    if (controller.signal.aborted)
      throw new Error('Devnet simulation timed out. Prepare again.');
    return {
      feeLamports: fee.value.toString(),
      slot: simulation.context.slot.toString(),
      unitsConsumed: units.toString(),
    };
  } catch (err) {
    if (controller.signal.aborted)
      throw new Error('Devnet simulation timed out. Prepare again.');
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
