import {
  collectJitoRuntimeEvidence,
  jitoRuntimePolicyRefusal,
} from '../lib/jito-runtime-evidence';
import { createJitoQualificationTransport } from '../lib/jito-qualification-transport';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';

// Diagnostic only. This address is not added to the production program policy.
const PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const SYSTEM = '11111111111111111111111111111111';
const flags = {
  providerQualified: false,
  programApproved: false,
  sourceAuthenticated: false,
  signingAllowed: false,
  executionAllowed: false,
  fullSwapQualified: false,
} as const;
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    throw Error('Use --live-readonly.');
  const endpoint = getSolanaHolderRpcEndpoint(),
    signal = AbortSignal.timeout(60000);
  await paceWalletRpc(endpoint, signal);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'cpmm-floor',
      method: 'getSlot',
      params: [{ commitment: 'confirmed' }],
    }),
    signal,
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw Error('Floor request refused.');
  const floor = (await response.json()) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (
    floor.jsonrpc !== '2.0' ||
    floor.id !== 'cpmm-floor' ||
    floor.error ||
    !Number.isSafeInteger(floor.result) ||
    (floor.result as number) < 0
  )
    throw Error('Floor refused.');
  const minimumSlot = floor.result as number;
  const transport = createJitoQualificationTransport(
    'runtime',
    minimumSlot,
    signal,
  );
  try {
    await collectJitoRuntimeEvidence(
      [SYSTEM, PROGRAM],
      minimumSlot,
      minimumSlot,
      signal,
      transport.rpc,
    );
    // A changed policy requires a fresh review; never turn a surprise pass into qualification.
    console.log(
      JSON.stringify(
        {
          format: 'jito-raydium-cpmm-probe-v1',
          status: 'unexpected-policy-acceptance',
          minimumSlot,
          transport: transport.summary(),
          ...flags,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          format: 'jito-raydium-cpmm-probe-v1',
          status: 'refused',
          minimumSlot,
          policy: jitoRuntimePolicyRefusal(error),
          transport: transport.summary(),
          ...flags,
        },
        null,
        2,
      ),
    );
  } finally {
    transport.close();
  }
  // Refusal or surprise acceptance is never a successful qualification.
  process.exitCode = 1;
}
main().catch(() => {
  console.error('Read-only CPMM runtime probe setup refused.');
  process.exitCode = 1;
});
