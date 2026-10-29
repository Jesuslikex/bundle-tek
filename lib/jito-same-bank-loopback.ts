import {
  buildJitoBundleSimulationRequest,
  type JitoBundleSimulationPacket,
} from './jito-bundle-simulation-frames';
import { readJitoSameBankPrototype } from './jito-same-bank-prototype';

const fail = (): never => {
  throw Error('Local same-bank transport refused.');
};

/** Unmounted local research transport. A response from loopback is NOT proof
 * of process identity or bank provenance and cannot authorize execution. */
export async function collectJitoSameBankLoopback(input: {
  endpoint: string;
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  simulationBankSlot: number;
  rpcId: string;
  signal: AbortSignal;
}) {
  const { endpoint, packets, minimumSlot, simulationBankSlot, rpcId, signal } =
    input;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/.exec(endpoint);
  if (
    !match ||
    Number(match[1]) > 65535 ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(simulationBankSlot) ||
    simulationBankSlot < minimumSlot ||
    simulationBankSlot - minimumSlot > 32 ||
    typeof rpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(rpcId)
  )
    return fail();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  deadline.throwIfAborted();
  const plan = await buildJitoBundleSimulationRequest(
    packets,
    simulationBankSlot,
    {
      bankEncoding: 'slot-object',
      verifySignatures: false,
    },
  );
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: rpcId,
    method: 'simulateBundleWithSameBankFees',
    params: plan.params,
  });
  if (Buffer.byteLength(requestBody) > 32768) return fail();
  deadline.throwIfAborted();
  let response: Response | null = null;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal: deadline,
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) return fail();
    const result = await readJitoSameBankPrototype({
      packets: plan.packetBindings,
      minimumSlot,
      simulationBankSlot,
      rpcId,
      requestBody,
      body: response.body,
      signal: deadline,
    });
    deadline.throwIfAborted();
    return {
      ...result,
      transport: 'loopback-single-request-unattested' as const,
      requestSentByCollector: true as const,
    };
  } finally {
    if (response?.body && !response.body.locked)
      void response.body.cancel().catch(() => {});
  }
}
