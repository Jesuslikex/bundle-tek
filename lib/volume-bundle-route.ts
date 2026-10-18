import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import schema from './pump-native-route-schema.json';
import {
  requireVolumeBundleConstruction,
  volumeKeys,
  volumeReject,
  volumeDigest,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
  type VolumeBundleConstruction,
} from './volume-bundle-construction';

export const VOLUME_PUMP = schema.program;
export const VOLUME_PUMP_FEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export type VolumePumpIdentities = { creator: string; feeRecipient: string };
/** Pin the existing captured native interface. This does not attest current deployed code. */
export async function volumePumpAccounts(
  mint: string,
  wallet: string,
  identities: VolumePumpIdentities,
) {
  volumeKeys(identities, 'creator,feeRecipient');
  const enc = getAddressEncoder(),
    utf8 = new TextEncoder();
  const pda = async (program: string, seed: string, ...keys: string[]) =>
    String(
      (
        await getProgramDerivedAddress({
          programAddress: address(program),
          seeds: [
            utf8.encode(seed),
            ...keys.map((k) => enc.encode(address(k))),
          ],
        })
      )[0],
    );
  const curve = await pda(VOLUME_PUMP, 'bonding-curve', mint);
  const ata = async (owner: string) =>
    String(
      (
        await findAssociatedTokenPda({
          owner: address(owner),
          mint: address(mint),
          tokenProgram: address(VOLUME_TOKEN),
        })
      )[0],
    );
  const values: Record<string, string> = {
    global: await pda(VOLUME_PUMP, 'global'),
    fee_recipient: String(address(identities.feeRecipient)),
    mint,
    bonding_curve: curve,
    associated_bonding_curve: await ata(curve),
    associated_user: await ata(wallet),
    user: wallet,
    system_program: VOLUME_SYSTEM,
    token_program: VOLUME_TOKEN,
    creator_vault: await pda(VOLUME_PUMP, 'creator-vault', identities.creator),
    event_authority: await pda(VOLUME_PUMP, '__event_authority'),
    program: VOLUME_PUMP,
    global_volume_accumulator: await pda(
      VOLUME_PUMP,
      'global_volume_accumulator',
    ),
    user_volume_accumulator: await pda(
      VOLUME_PUMP,
      'user_volume_accumulator',
      wallet,
    ),
    fee_config: await pda(VOLUME_PUMP_FEE, 'fee_config', VOLUME_PUMP),
    fee_program: VOLUME_PUMP_FEE,
  };
  if (new Set(Object.values(values)).size !== Object.keys(values).length)
    volumeReject('Pump route identities overlap.');
  return values;
}
export async function validateVolumePumpRoute(
  supplied: VolumeBundleConstruction,
  suppliedIdentities: VolumePumpIdentities,
) {
  const review = await requireVolumeBundleConstruction(supplied),
    identities = structuredClone(suppliedIdentities);
  const roles = await volumePumpAccounts(
    review.input.mint,
    review.wallet,
    identities,
  );
  if (
    review.input.tokenAccount !== roles.associated_user ||
    Object.values(roles).includes(review.input.tipRecipient) ||
    [
      review.wallet,
      review.input.mint,
      review.input.tokenAccount,
      review.input.tipRecipient,
    ].includes(identities.creator)
  )
    volumeReject('Pump custody, creator or tip account differs.');
  const writable = new Set([
    'fee_recipient',
    'bonding_curve',
    'associated_bonding_curve',
    'associated_user',
    'creator_vault',
    'global_volume_accumulator',
    'user_volume_accumulator',
  ]);
  for (const [kind, list] of [
    ['buy', review.input.buy],
    ['sell', review.input.sell],
  ] as const) {
    const variant = schema.instructions.find((i) => i.name === kind)!;
    if (list.length !== 1)
      volumeReject('Only one native Pump instruction per leg is supported.');
    const ix = list[0],
      bytes = Uint8Array.from(atob(ix.dataBase64), (c) => c.charCodeAt(0)),
      view = new DataView(bytes.buffer);
    const discriminator = Array.from(bytes.slice(0, 8), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    if (
      ix.programAddress !== VOLUME_PUMP ||
      bytes.length !== (kind === 'buy' ? 26 : 24) ||
      discriminator !== variant.discriminator ||
      ix.accounts.length !== variant.accounts.length
    )
      volumeReject('Unsupported Pump route layout.');
    if (
      view.getBigUint64(8, true) !== BigInt(review.input.tokenAmountRaw) ||
      view.getBigUint64(16, true) !==
        BigInt(
          kind === 'buy'
            ? review.input.plan.rounds[review.input.round].buyLamports
            : review.input.minimumSellLamports,
        ) ||
      (kind === 'buy' && (bytes[24] !== 0 || bytes[25] !== 0))
    )
      volumeReject(
        'Exact token target, native bound or no-partial-fill policy differs.',
      );
    variant.accounts.forEach((name, i) => {
      const expectedRole = name === 'user' ? 3 : writable.has(name) ? 1 : 0;
      if (
        ix.accounts[i].address !== roles[name] ||
        ix.accounts[i].role !== expectedRole
      )
        volumeReject(`Pump ${kind} account ${name} differs.`);
    });
  }
  const result = {
    format: 'volume-pump-route-review-v1' as const,
    constructionSha256: review.sha256,
    identities,
    accounts: roles,
    schemaSha256: schema.sha256,
    routeFieldsVerified: true as const,
    instructionsVerified: false as const,
    programCodeAdmissionRequired: true as const,
    stateAdmissionRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  return { ...result, sha256: await volumeDigest(result) };
}
export type VolumePumpRoute = Awaited<
  ReturnType<typeof validateVolumePumpRoute>
>;
