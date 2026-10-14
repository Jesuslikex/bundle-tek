import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { counterBuyFixture } from './counter-buy-fixture';
import { routeMessage } from './jupiter-route-fixture';
export function counterPreparationFixture(
  options: Parameters<typeof routeMessage>[0] = {},
) {
  const p = counterBuyFixture();
  const quote = {
    ...p.response,
    priceImpactPct: '0.001',
    routePlan: p.response.routePlan.map((s) => ({
      ...s,
      percent: 100,
      swapInfo: {
        ...s.swapInfo,
        feeAmount: '0',
        feeMint: p.response.inputMint,
      },
    })),
  };
  const message = routeMessage({
    accountIndices: [5, 6, 0, 1, 1, 2, 2, 3, 4, 6, 6, 6, 6],
    ...options,
  });
  message.staticAccounts[4] = address(p.response.outputMint);
  const bytes = Uint8Array.from(message.instructions[0].data!);
  bytes.set([176, 209, 105, 168, 154, 125, 69, 62]);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(bytes.length - 19, BigInt(p.response.outAmount!), true);
  view.setBigUint64(bytes.length - 11, 1000n, true);
  message.instructions[0].data = bytes;
  const packet = getBase64Decoder().decode(
    Uint8Array.from([
      1,
      ...new Uint8Array(64),
      ...getCompiledTransactionMessageEncoder().encode(message),
    ]),
  );
  const swap = {
    swapTransaction: packet,
    lastValidBlockHeight: 123456,
    prioritizationFeeLamports: 0,
    simulationError: null,
    requestId: 'PRIVATE-REQUEST',
    extra: 'PRIVATE-DETAIL',
  };
  return { ...p, quote, swap, message };
}
