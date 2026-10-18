import {
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  type Instruction,
} from '@solana/kit';
import {
  requireVolumeBundlePlan,
  type VolumeBundlePlan,
} from './volume-bundle-plan';

export const VOLUME_SYSTEM = '11111111111111111111111111111111';
export const VOLUME_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const volumeReject = (
  message = 'Same-block construction or settlement differs.',
): never => {
  throw new Error(message);
};
export function volumeKeys(value: object, keys: string) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')
  )
    volumeReject('Unknown or missing same-block fields.');
}
export function volumeUint(value: unknown, positive = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n ||
    (positive && value === '0')
  )
    return volumeReject('Canonical u64 amount required.');
  return BigInt(value);
}
export async function volumeDigest(value: unknown) {
  return volumeBytesDigest(new TextEncoder().encode(JSON.stringify(value)));
}
export async function volumeBytesDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export type VolumeRouteInstruction = {
  programAddress: string;
  accounts: { address: string; role: 0 | 1 | 2 | 3 }[];
  dataBase64: string;
};
export type VolumeBundleConstructionInput = {
  plan: VolumeBundlePlan;
  projectId: string;
  projectRevision: number;
  sessionId: string;
  sessionRevision: number;
  round: number;
  mint: string;
  tokenAccount: string;
  tokenAmountRaw: string;
  minimumSellLamports: string;
  networkFeeCapLamports: string;
  maximumLossLamports: string;
  tipRecipient: string;
  tipLamports: string;
  blockhash: string;
  lastValidBlockHeight: string;
  buy: VolumeRouteInstruction[];
  sell: VolumeRouteInstruction[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Offline candidate assembly only. Route bytes are bound, not semantically admitted. */
export async function constructVolumeBundle(
  supplied: VolumeBundleConstructionInput,
) {
  volumeKeys(
    supplied,
    'blockhash,buy,lastValidBlockHeight,maximumLossLamports,mint,minimumSellLamports,networkFeeCapLamports,plan,projectId,projectRevision,round,sell,sessionId,sessionRevision,tipLamports,tipRecipient,tokenAccount,tokenAmountRaw',
  );
  const input = structuredClone(supplied);
  const plan = requireVolumeBundlePlan(input.plan);
  const round = plan.rounds[input.round];
  if (
    !Number.isSafeInteger(input.round) ||
    !round ||
    !uuid.test(input.projectId) ||
    !uuid.test(input.sessionId) ||
    !Number.isSafeInteger(input.projectRevision) ||
    input.projectRevision < 1 ||
    !Number.isSafeInteger(input.sessionRevision) ||
    input.sessionRevision < 1
  )
    volumeReject();
  const wallet = round.wallet;
  for (const key of [
    wallet,
    input.mint,
    input.tokenAccount,
    input.tipRecipient,
  ])
    address(key);
  blockhash(input.blockhash);
  if (
    new Set([
      wallet,
      input.mint,
      input.tokenAccount,
      input.tipRecipient,
      VOLUME_SYSTEM,
      VOLUME_TOKEN,
    ]).size !== 6 ||
    input.mint === 'So11111111111111111111111111111111111111112'
  )
    volumeReject('Use distinct native payer, standard token and tip accounts.');
  const tip = volumeUint(input.tipLamports, true),
    fee = volumeUint(input.networkFeeCapLamports, true);
  volumeUint(input.tokenAmountRaw, true);
  volumeUint(input.minimumSellLamports, true);
  volumeUint(input.lastValidBlockHeight, true);
  const loss = volumeUint(input.maximumLossLamports, true);
  if (
    tip < 1000n ||
    tip > BigInt(round.tipCapLamports) ||
    loss > BigInt(round.buyLamports) + fee + tip
  )
    volumeReject('Tip or loss limit exceeds the reviewed round.');
  const convert = (items: VolumeRouteInstruction[]): Instruction[] => {
    if (!Array.isArray(items) || items.length < 1 || items.length > 6)
      return volumeReject('Choose one to six instructions per leg.');
    return items.map((item) => {
      volumeKeys(item, 'accounts,dataBase64,programAddress');
      address(item.programAddress);
      // No top-level transfers, approvals, account setup or compute-budget overrides disguised as a swap.
      if (
        [
          VOLUME_SYSTEM,
          VOLUME_TOKEN,
          'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
          'ComputeBudget111111111111111111111111111111',
          wallet,
          input.tipRecipient,
          input.tokenAccount,
          input.mint,
        ].includes(item.programAddress)
      )
        volumeReject('Unsupported route program.');
      if (
        !Array.isArray(item.accounts) ||
        item.accounts.length < 2 ||
        item.accounts.length > 32 ||
        typeof item.dataBase64 !== 'string' ||
        !item.dataBase64 ||
        item.dataBase64.length > 1024
      )
        volumeReject();
      const bytes = Uint8Array.from(atob(item.dataBase64), (c) =>
        c.charCodeAt(0),
      );
      if (btoa(String.fromCharCode(...bytes)) !== item.dataBase64)
        volumeReject('Noncanonical route bytes.');
      const accounts = item.accounts.map((a) => {
        volumeKeys(a, 'address,role');
        address(a.address);
        if (
          ![0, 1, 2, 3].includes(a.role) ||
          a.address === input.tipRecipient ||
          (a.role >= 2 && a.address !== wallet)
        )
          volumeReject(
            'Only the round wallet may sign; tip recipient must be isolated.',
          );
        return { address: address(a.address), role: a.role };
      });
      if (
        !accounts.some((a) => a.address === wallet && a.role === 3) ||
        !accounts.some((a) => a.address === input.tokenAccount && a.role === 1)
      )
        volumeReject(
          'Each leg must name the wallet and writable token account.',
        );
      return {
        programAddress: address(item.programAddress),
        accounts,
        data: bytes,
      };
    });
  };
  const buy = convert(input.buy),
    sell = convert(input.sell);
  const tipData = new Uint8Array(12);
  const view = new DataView(tipData.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, tip, true);
  const instructions: Instruction[] = [
    ...buy,
    ...sell,
    {
      programAddress: address(VOLUME_SYSTEM),
      accounts: [
        { address: address(wallet), role: 3 },
        { address: address(input.tipRecipient), role: 1 },
      ],
      data: tipData,
    },
  ];
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        address(wallet),
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const tx = compileTransaction(message);
  const bytes = Uint8Array.from(getTransactionEncoder().encode(tx));
  const compiled = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (
    bytes.length > 1232 ||
    compiled.staticAccounts.length > 64 ||
    compiled.header.numSignerAccounts !== 1 ||
    compiled.staticAccounts[0] !== wallet ||
    Object.values(tx.signatures).some((s) => s !== null)
  )
    volumeReject(
      'One canonical unsigned packet within 1,232 bytes is required. No split fallback.',
    );
  const terms = {
    format: 'volume-bundle-construction-v1' as const,
    input,
    wallet,
    transaction: getBase64Decoder().decode(bytes),
    packetSha256: await volumeBytesDigest(bytes),
    buyInstructionCount: buy.length,
    sellInstructionCount: sell.length,
    requiredBuyMode: 'ExactOut' as const,
    requiredSellMode: 'ExactIn' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    instructionsVerified: false as const,
    simulationRequired: true as const,
  };
  return { ...terms, sha256: await volumeDigest(terms) };
}
export type VolumeBundleConstruction = Awaited<
  ReturnType<typeof constructVolumeBundle>
>;
export async function requireVolumeBundleConstruction(
  value: VolumeBundleConstruction,
) {
  const rebuilt = await constructVolumeBundle(value?.input);
  if (JSON.stringify(rebuilt) !== JSON.stringify(value))
    volumeReject('Constructed round changed.');
  return rebuilt;
}
