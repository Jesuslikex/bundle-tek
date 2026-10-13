import { tokenExtensionNames } from './token-extension-names';

export class HolderMintObservationConflict extends Error {}

export type HolderMintObservation = {
  slot: number;
  extensions: string[];
  /** Null means an unparsed extension could conceal the ordinary fee config. */
  withheldRaw: string | null;
};

export function holderExtensionNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Holder extensions unavailable.');
  return tokenExtensionNames(value.map((extension) => ({ extension })));
}

export function holderFeeUnits(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Holder withheld fee units unavailable.');
  return value;
}

export function validateHolderMintObservation(
  observation: HolderMintObservation,
) {
  if (
    !observation ||
    !Number.isSafeInteger(observation.slot) ||
    observation.slot < 0
  )
    throw new Error('Holder mint observation slot unavailable.');
  holderExtensionNames(observation.extensions);
  if (observation.withheldRaw !== null) holderFeeUnits(observation.withheldRaw);
  if (
    observation.withheldRaw === null &&
    (!observation.extensions.includes('unparseableExtension') ||
      observation.extensions.includes('transferFeeConfig'))
  )
    throw new Error('Holder mint fee observation differs.');
  if (
    !observation.extensions.includes('transferFeeConfig') &&
    observation.withheldRaw !== null &&
    observation.withheldRaw !== '0'
  )
    throw new Error('Holder mint fee config unavailable.');
}

export function sameHolderMintFees(
  before: HolderMintObservation | undefined,
  after: HolderMintObservation | undefined,
) {
  if (!before || !after) return before === after;
  return (
    before.withheldRaw === after.withheldRaw &&
    JSON.stringify([...before.extensions].sort()) ===
      JSON.stringify([...after.extensions].sort())
  );
}

/** jsonParsed mint data, read at or after the finalized reference supply slot. */
export function decodeHolderMintObservation(
  response: unknown,
  supply: unknown,
): HolderMintObservation | undefined {
  const mint = response as {
    context?: { slot?: unknown };
    value?: {
      data?: {
        parsed?: {
          type?: unknown;
          info?: {
            supply?: unknown;
            decimals?: unknown;
            isInitialized?: unknown;
            extensions?: unknown;
          };
        };
      };
    };
  };
  const token = supply as {
    context?: { slot?: unknown };
    value?: {
      amount?: unknown;
      decimals?: unknown;
    };
  };
  const parsed = mint.value?.data?.parsed;
  // A provider's base64 fallback or older saved page remains explicitly unmeasured.
  if (parsed === undefined) return undefined;
  const info = parsed?.info;
  if (
    parsed?.type !== 'mint' ||
    info?.isInitialized !== true ||
    info.supply !== token.value?.amount ||
    info.decimals !== token.value?.decimals
  )
    throw new Error('Holder mint precision or supply differs.');
  const slot = Number(mint.context?.slot);
  if (!Number.isSafeInteger(slot) || slot < Number(token.context?.slot))
    throw new Error('Holder mint observation slot differs.');
  if (info.extensions === undefined) return undefined;
  const extensions = tokenExtensionNames(info.extensions);
  const config = (
    info.extensions as Array<{
      extension: string;
      state?: { withheldAmount?: unknown };
    }>
  ).find((extension) => extension.extension === 'transferFeeConfig');
  const observation = {
    slot,
    extensions,
    withheldRaw: config
      ? holderFeeUnits(config.state?.withheldAmount)
      : extensions.includes('unparseableExtension')
        ? null
        : '0',
  };
  validateHolderMintObservation(observation);
  if (
    observation.withheldRaw !== null &&
    BigInt(observation.withheldRaw) >
      BigInt(holderFeeUnits(token.value?.amount))
  )
    throw new Error('Holder mint fees exceed supply.');
  return observation;
}
