import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createJitoQualificationTransport } from '../lib/jito-qualification-transport';
import { getSolanaHolderRpcEndpoint } from '../lib/solana-rpc';
import { paceWalletRpc } from '../lib/wallet-rpc-pacing';
import {
  pumpRpcAccount,
  pumpAccountBytes,
} from '../lib/pump-launch-simulation';
import {
  pumpGroupProgramDataLink,
  requirePumpGroupDeploymentHeader,
  PUMP_UPGRADEABLE_LOADER,
} from '../lib/pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
const PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const DATA = 'DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU';
const SIZE = 793824;
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-readonly')
    throw Error();
  const signal = AbortSignal.timeout(45000),
    endpoint = getSolanaHolderRpcEndpoint();
  await paceWalletRpc(endpoint, signal);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'cpmm-artifact-floor',
      method: 'getSlot',
      params: [{ commitment: 'confirmed' }],
    }),
    signal,
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw Error();
  const floor = (await response.json()) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (
    floor.jsonrpc !== '2.0' ||
    floor.id !== 'cpmm-artifact-floor' ||
    floor.error ||
    !Number.isSafeInteger(floor.result) ||
    (floor.result as number) < 1
  )
    throw Error();
  const minimumSlot = floor.result as number,
    transport = createJitoQualificationTransport(
      'runtime',
      minimumSlot,
      signal,
    );
  let latest = minimumSlot;
  try {
    if (
      (await transport.rpc('getGenesisHash', [], signal)) !==
      SOLANA_MAINNET_GENESIS
    )
      throw Error();
    async function read(keys: string[], offset: number, length: number) {
      const result = (await transport.rpc(
        'getMultipleAccounts',
        [
          keys,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            minContextSlot: latest,
            dataSlice: { offset, length },
          },
        ],
        signal,
      )) as { context?: { slot?: unknown }; value?: unknown[] };
      if (
        typeof result.context?.slot !== 'string' ||
        !/^[1-9]\d{0,15}$/.test(result.context.slot) ||
        !Number.isSafeInteger(Number(result.context.slot)) ||
        Number(result.context.slot) < latest ||
        Number(result.context.slot) > minimumSlot + 32 ||
        !Array.isArray(result.value) ||
        result.value.length !== keys.length
      )
        throw Error();
      latest = Number(result.context.slot);
      return result.value;
    }
    const first = await read([PROGRAM, DATA], 0, 45);
    const program = pumpRpcAccount(first[0]),
      metadata = pumpRpcAccount(first[1]);
    if (
      !program ||
      !metadata ||
      pumpGroupProgramDataLink(PROGRAM, program) !== DATA ||
      (first[1] as { space?: unknown }).space !== String(SIZE + 45)
    )
      throw Error();
    requirePumpGroupDeploymentHeader(metadata, latest);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < SIZE; offset += 720 * 1024) {
      const length = Math.min(720 * 1024, SIZE - offset),
        raw = (await read([DATA], offset + 45, length))[0],
        a = pumpRpcAccount(raw);
      if (
        !a ||
        a.owner !== PUMP_UPGRADEABLE_LOADER ||
        a.executable ||
        (raw as { space?: unknown }).space !== String(SIZE + 45)
      )
        throw Error();
      const bytes = Buffer.from(pumpAccountBytes(a));
      if (bytes.length !== length) throw Error();
      chunks.push(bytes);
    }
    const last = await read([PROGRAM, DATA], 0, 45),
      lastProgram = pumpRpcAccount(last[0]),
      lastMetadata = pumpRpcAccount(last[1]);
    if (
      !lastProgram ||
      !lastMetadata ||
      (last[1] as { space?: unknown }).space !== String(SIZE + 45) ||
      JSON.stringify(program) !== JSON.stringify(lastProgram) ||
      JSON.stringify(metadata) !== JSON.stringify(lastMetadata)
    )
      throw Error();
    requirePumpGroupDeploymentHeader(lastMetadata, latest);
    const code = Buffer.concat(chunks);
    if (
      code.length !== SIZE ||
      code.subarray(0, 4).toString('hex') !== '7f454c46'
    )
      throw Error();
    let trimmed = code.length;
    while (trimmed > 0 && code[trimmed - 1] === 0) trimmed--;
    const fullCodeSha256 = createHash('sha256').update(code).digest('hex'),
      normalizedSha256 = createHash('sha256')
        .update(code.subarray(0, trimmed))
        .digest('hex');
    const path = `work/raydium-cpmm-onchain-${minimumSlot}.so`;
    const receipt = {
      format: 'cpmm-onchain-build-reference-v1',
      program: PROGRAM,
      programData: DATA,
      minimumSlot,
      maximumSlot: latest,
      codeBytes: SIZE,
      normalizedBytes: trimmed,
      fullCodeSha256,
      normalizedSha256,
      path,
      transport: transport.summary(),
      sourceAuthenticated: false,
      programApproved: false,
      signingAllowed: false,
      executionAllowed: false,
    };
    signal.throwIfAborted();
    await mkdir('work', { recursive: true });
    await writeFile(path, code, { flag: 'wx' });
    await writeFile(path + '.json', JSON.stringify(receipt, null, 2), {
      flag: 'wx',
    });
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    transport.close();
  }
}
main().catch(() => {
  console.error(
    'Read-only CPMM artifact capture refused. No program approval granted.',
  );
  process.exitCode = 1;
});
