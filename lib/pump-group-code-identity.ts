import bs58 from 'bs58';
import { address } from '@solana/kit-v1';
import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import {
  pumpDeploymentHash,
  pumpGroupProgramDataLink,
  requirePumpGroupDeploymentHeader,
} from './pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const SYSTEM = '11111111111111111111111111111111';
const hash = async (bytes: Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
  ).toString('hex');
export type PumpProgramIdentity = {
  address: string;
  loader: string;
  programData: string | null;
  deploymentSlot: string | null;
  upgradeAuthority: string | null;
  codeSha256: string;
  codeBytes: number;
  identityKind: 'native-system' | 'elf-code';
};
/** Full executable identity, never a semantic audit. Sliced reads bound memory and coherent headers detect upgrades during collection. */
export async function collectPumpProgramIdentities(
  programs: string[],
  minimumSlot: number,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  if (
    !programs.length ||
    programs.length > 16 ||
    new Set(programs).size !== programs.length ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0
  )
    throw new Error('Program identity scope differs.');
  programs.forEach(address);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let reads = 0,
    totalBytes = 0;
  const slots = [minimumSlot];
  async function call(method: string, params: unknown[]) {
    deadline.throwIfAborted();
    if (
      !['getGenesisHash', 'getMultipleAccounts'].includes(method) ||
      ++reads > 300
    )
      throw new Error('Program identity read budget exceeded.');
    return new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(
          new Error('Program identity collection cancelled or timed out.'),
        );
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
  async function accounts(keys: string[], offset: number, length: number) {
    const value = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: Math.max(...slots),
        dataSlice: { offset, length },
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    const slot = Number(pumpUnsignedInteger(value?.context?.slot));
    if (
      !Number.isSafeInteger(slot) ||
      slot < Math.max(...slots) ||
      slot - minimumSlot > 32 ||
      !Array.isArray(value.value) ||
      value.value.length !== keys.length
    )
      throw new Error(
        `Program identity bank/mapping differs: min=${minimumSlot}, latest=${Math.max(...slots)}, got=${slot}, accounts=${value.value?.length ?? -1}/${keys.length}, reads=${reads}.`,
      );
    slots.push(slot);
    return value.value.map(pumpRpcAccount);
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Program identity requires mainnet.');
  const executable = await accounts(programs, 0, 45);
  const links = executable.map((account, i) => {
    if (!account) throw new Error('Program identity is missing.');
    return pumpGroupProgramDataLink(programs[i], account);
  });
  const headers = new Map<string, NonNullable<PumpRpcAccount>>();
  const linked = links.filter((key): key is string => key !== null);
  if (new Set(linked).size !== linked.length)
    throw new Error('Program data links overlap.');
  if (linked.length) {
    const values = await accounts(linked, 0, 45);
    for (const [i, key] of linked.entries()) {
      const value = values[i];
      requirePumpGroupDeploymentHeader(value, minimumSlot);
      if (!value) throw new Error('Missing program data.');
      headers.set(key, value);
    }
  }
  const code = new Map<string, Uint8Array[]>();
  const profiles = programs.flatMap((key, i) => {
    const program = executable[i]!;
    if (program.owner === 'NativeLoader1111111111111111111111111111111')
      return [];
    const link = links[i],
      header = link ? headers.get(link)! : program;
    const declared = (header as typeof header & { space?: unknown }).space;
    const space =
      declared === undefined ? null : Number(pumpUnsignedInteger(declared));
    const start = link ? 45 : 0;
    if (
      space !== null &&
      (!Number.isSafeInteger(space) ||
        space - start < 4 ||
        space - start > 10 * 1024 * 1024)
    )
      throw new Error('Program code size exceeds bounds.');
    code.set(key, []);
    return [
      {
        key,
        dataKey: link ?? key,
        header,
        space,
        declared,
        start,
        size: 0,
        done: false,
      },
    ];
  });
  for (const start of [0, 45]) {
    const selected = profiles.filter((item) => item.start === start);
    if (!selected.length) continue;
    for (let offset = 0; selected.some((item) => !item.done);) {
      const active = selected.filter((item) => !item.done);
      const chunkSize = Math.min(
        720 * 1024,
        Math.floor(1048576 / active.length / 4096) * 4096,
      );
      const parts = await accounts(
        active.map((item) => item.dataKey),
        start + offset,
        chunkSize,
      );
      for (const [i, item] of active.entries()) {
        const part = parts[i];
        if (
          !part ||
          part.owner !== item.header.owner ||
          part.executable !== item.header.executable ||
          part.lamports !== item.header.lamports ||
          String((part as typeof part & { space?: unknown }).space) !==
            String(item.declared)
        )
          throw new Error('Program identity changed during code read.');
        const chunk = pumpAccountBytes(part);
        if (
          chunk.length > chunkSize ||
          (item.space !== null &&
            chunk.length !== Math.min(chunkSize, item.space - start - offset))
        )
          throw new Error('Truncated program code.');
        item.size += chunk.length;
        totalBytes += chunk.length;
        if (item.size > 10 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024)
          throw new Error('Program code size exceeds bounds.');
        code.get(item.key)!.push(chunk);
        item.done =
          chunk.length < chunkSize ||
          (item.space !== null && item.size === item.space - start);
      }
      offset += chunkSize;
    }
  }
  const identities: PumpProgramIdentity[] = [];
  for (const [i, key] of programs.entries()) {
    const program = executable[i]!;
    if (program.owner === 'NativeLoader1111111111111111111111111111111') {
      if (key !== SYSTEM) throw new Error('Unsupported native program.');
      identities.push({
        address: key,
        loader: program.owner,
        programData: null,
        deploymentSlot: null,
        upgradeAuthority: null,
        codeSha256: await hash(pumpAccountBytes(program)),
        codeBytes: pumpAccountBytes(program).length,
        identityKind: 'native-system',
      });
      continue;
    }
    const link = links[i],
      header = link ? headers.get(link)! : program;
    const chunks = code.get(key)!;
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let written = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, written);
      written += chunk.length;
    }
    if (
      bytes[0] !== 127 ||
      bytes[1] !== 69 ||
      bytes[2] !== 76 ||
      bytes[3] !== 70
    )
      throw new Error('Program code is not an ELF image.');
    const metadata = pumpAccountBytes(header);
    identities.push({
      address: key,
      loader: program.owner,
      programData: link,
      deploymentSlot: link
        ? new DataView(
            metadata.buffer,
            metadata.byteOffset,
            metadata.byteLength,
          )
            .getBigUint64(4, true)
            .toString()
        : null,
      upgradeAuthority:
        link && metadata[12] === 1 ? bs58.encode(metadata.slice(13, 45)) : null,
      codeSha256: await hash(bytes),
      codeBytes: size,
      identityKind: 'elf-code',
    });
  }
  const repeated = await accounts(programs, 0, 45);
  for (const [i, account] of repeated.entries())
    if (
      (await pumpDeploymentHash(account)) !==
      (await pumpDeploymentHash(executable[i]))
    )
      throw new Error('Program link or owner changed after code collection.');
  if (linked.length) {
    const repeatedHeaders = await accounts(linked, 0, 45);
    for (const [i, key] of linked.entries())
      if (
        (await pumpDeploymentHash(repeatedHeaders[i])) !==
        (await pumpDeploymentHash(headers.get(key)))
      )
        throw new Error(
          'Program deployment or authority changed after code collection.',
        );
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Program identity provider network changed.');
  deadline.throwIfAborted();
  return {
    format: 'pump-program-code-identities-v1' as const,
    network: 'mainnet' as const,
    minimumSlot,
    maximumSlot: Math.max(...slots),
    programs: identities,
    reads,
    totalCodeBytes: totalBytes,
    observedAt: new Date().toISOString(),
    codeIdentityVerified: true as const,
    semanticAuditEstablished: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
/** Compare against a separately reviewed server policy. Capturing the current chain does not create a trusted policy. */
export function matchesPumpProgramPolicy(
  measured: Awaited<ReturnType<typeof collectPumpProgramIdentities>>,
  approved: {
    programs: PumpProgramIdentity[];
    reviewReference: string;
    policySha256: string;
  } | null,
) {
  if (
    !approved ||
    !approved.reviewReference ||
    !/^[a-f0-9]{64}$/.test(approved.policySha256) ||
    approved.programs.length !== measured.programs.length
  )
    return false;
  return measured.programs.every((program) => {
    const expected = approved.programs.find(
      (item) => item.address === program.address,
    );
    return !!expected && JSON.stringify(expected) === JSON.stringify(program);
  });
}
