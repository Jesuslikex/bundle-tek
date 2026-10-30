import { mkdir, writeFile } from 'node:fs/promises';
import {
  collectJitoCpmmResearchRuntimeEvidence,
  type JitoRuntimeCapture,
} from '../lib/jito-runtime-evidence';
import { CPMM_MATCHED_SOURCE_IDENTITY } from '../lib/jito-cpmm-source-identity';
import { createJitoQualificationTransport } from '../lib/jito-qualification-transport';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import { readJitoSimulationJson } from '../lib/jito-simulation-json';
const flags = {
  fullSwapQualified: false,
  providerQualified: false,
  sourceAuthenticated: false,
  reviewedCodePolicyMatched: false,
  programApproved: false,
  bankVerified: false,
  signingAllowed: false,
  executionAllowed: false,
};
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    throw Error();
  const signal = AbortSignal.timeout(60000),
    endpoint = getSolanaHolderRpcEndpoint();
  await paceWalletRpc(endpoint, signal);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'cpmm-source-floor',
      method: 'getSlot',
      params: [{ commitment: 'confirmed' }],
    }),
    signal,
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) {
    void response.body?.cancel();
    throw Error();
  }
  const floor = (await readJitoSimulationJson(response.body, signal, 4096)) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (
    floor.jsonrpc !== '2.0' ||
    floor.id !== 'cpmm-source-floor' ||
    floor.error ||
    typeof floor.result !== 'bigint' ||
    floor.result < 1n ||
    floor.result > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw Error();
  const minimumSlot = Number(floor.result),
    transport = createJitoQualificationTransport(
      'runtime',
      minimumSlot,
      signal,
    );
  let first: JitoRuntimeCapture | null = null,
    second: JitoRuntimeCapture | null = null;
  let status = 'refused';
  try {
    const keys = [
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      CPMM_MATCHED_SOURCE_IDENTITY.address,
    ];
    first = await collectJitoCpmmResearchRuntimeEvidence(
      keys,
      minimumSlot,
      minimumSlot,
      signal,
      transport.rpc,
    );
    // No simulation between these scans: this is a lower-bound diagnostic only.
    second = await collectJitoCpmmResearchRuntimeEvidence(
      keys,
      minimumSlot,
      first.maximumSlot,
      signal,
      transport.rpc,
    );
    if (JSON.stringify(first.programs) !== JSON.stringify(second.programs))
      throw Error();
    status = 'two-source-reference-scans-matched';
  } catch {
    process.exitCode = 1;
  } finally {
    transport.close();
  }
  const receipt = {
    format: 'jito-cpmm-source-runtime-probe-v1',
    observedAt: new Date().toISOString(),
    status,
    minimumSlot,
    firstMaximumSlot: first?.maximumSlot ?? null,
    secondMaximumSlot: second?.maximumSlot ?? null,
    firstReads: first?.reads ?? null,
    secondReads: second?.reads ?? null,
    programs: first?.programs ?? [],
    identitiesMatch:
      !!first &&
      !!second &&
      JSON.stringify(first.programs) === JSON.stringify(second.programs),
    simulationPerformed: false,
    transport: transport.summary(),
    ...flags,
  };
  await mkdir('work', { recursive: true });
  await writeFile(
    `work/cpmm-source-runtime-${minimumSlot}.json`,
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(receipt, null, 2));
}
main().catch(() => {
  console.error(
    'Read-only CPMM source runtime setup refused; no qualification or authority granted.',
  );
  process.exitCode = 1;
});
