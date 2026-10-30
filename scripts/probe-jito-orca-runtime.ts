import {
  collectJitoRuntimeEvidence,
  jitoRuntimePolicyRefusal,
} from '../lib/jito-runtime-evidence';
import { createJitoQualificationTransport } from '../lib/jito-qualification-transport';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const flags = {
  providerQualified: false,
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
      id: 'orca-floor',
      method: 'getSlot',
      params: [{ commitment: 'confirmed' }],
    }),
    signal,
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw Error('Provider refused floor.');
  const floor = (await response.json()) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (
    floor.jsonrpc !== '2.0' ||
    floor.id !== 'orca-floor' ||
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
  let first: Awaited<ReturnType<typeof collectJitoRuntimeEvidence>> | null =
    null;
  try {
    first = await collectJitoRuntimeEvidence(
      ['11111111111111111111111111111111', PROGRAM],
      minimumSlot,
      minimumSlot,
      signal,
      transport.rpc,
    );
    // Deliberately omit simulation: this is a lower-bound diagnostic for the
    // two serial scans, never a replacement for the real before/sim/after flow.
    const second = await collectJitoRuntimeEvidence(
      ['11111111111111111111111111111111', PROGRAM],
      minimumSlot,
      first.maximumSlot,
      signal,
      transport.rpc,
    );
    const identitiesMatch =
      JSON.stringify(first.programs) === JSON.stringify(second.programs);
    if (!identitiesMatch) process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          format: 'jito-orca-runtime-probe-v1',
          status: identitiesMatch
            ? 'two-diagnostic-scans-accepted'
            : 'identities-differ',
          minimumSlot,
          firstMaximumSlot: first.maximumSlot,
          secondMaximumSlot: second.maximumSlot,
          firstReads: first.reads,
          secondReads: second.reads,
          identitiesMatch,
          programs: first.programs,
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
          format: 'jito-orca-runtime-probe-v1',
          status: 'refused',
          minimumSlot,
          failedStage: first ? 'second-scan' : 'first-scan',
          firstMaximumSlot: first?.maximumSlot ?? null,
          firstReads: first?.reads ?? null,
          firstPrograms: first?.programs ?? [],
          policy: jitoRuntimePolicyRefusal(error),
          transport: transport.summary(),
          ...flags,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    transport.close();
  }
}
main().catch(() => {
  console.error('Read-only Orca runtime probe setup refused.');
  process.exitCode = 1;
});
