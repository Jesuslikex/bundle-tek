import bs58 from 'bs58';
import { z } from 'zod';
import {
  getExtensionDecoder,
  getExtensionEncoder,
} from '@solana-program/token-2022';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
} from './marketplace-owned-inventory';
import { operatorListingSelection } from './marketplace-operator-review';
import { MarketplaceSaleInspectionChangedError } from './marketplace-sale-inspection';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  MARKETPLACE_ACCOUNT_EXTENSIONS,
  MARKETPLACE_TOKEN_PROGRAMS,
  MARKETPLACE_TOKEN_ACCOUNT_LIMIT,
  MARKETPLACE_TOKEN_COVERAGE,
  marketplaceTokenAccount,
  marketplaceTokenInspection,
  tokenInspectionCounts,
  tokenInspectionSourceHash,
  type MarketplaceTokenAccount,
} from './marketplace-token-inspection-view';
const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const slot = uint.refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
const rawAccount = z.object({
  owner: z.string(),
  executable: z.literal(false),
  lamports: uint,
  space: slot,
  data: z.tuple([z.string().max(21848), z.literal('base64')]),
});
/** Decodes owned token-account bytes and authorities. It never interprets transferability, mint policy or confidential balances. */
export async function decodeMarketplaceTokenAccount(
  raw: unknown,
  program: (typeof MARKETPLACE_TOKEN_PROGRAMS)[number],
  wallet: string,
  observedSlot: number,
): Promise<MarketplaceTokenAccount> {
  const entry = z
      .object({
        pubkey: marketplaceTokenAccount.shape.address,
        account: rawAccount,
      })
      .parse(raw),
    account = entry.account;
  if (account.owner !== program)
    throw Error('Owned token account program differs.');
  const text = atob(account.data[0]);
  if (
    btoa(text) !== account.data[0] ||
    text.length < 165 ||
    text.length > 16384 ||
    String(text.length) !== account.space ||
    (program === MARKETPLACE_TOKEN_PROGRAMS[0] && text.length !== 165)
  )
    throw Error('Owned token account encoding or layout differs.');
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0)),
    view = new DataView(bytes.buffer);
  const address = (offset: number) =>
    bs58.encode(bytes.slice(offset, offset + 32));
  const option = (offset: number) => {
    const tag = view.getUint32(offset, true);
    if (tag > 1) throw Error('Owned token authority option differs.');
    return tag === 1;
  };
  const delegate = option(72) ? address(76) : null,
    nativeReserveRaw = option(109)
      ? view.getBigUint64(113, true).toString()
      : null,
    closeAuthority = option(129) ? address(133) : null;
  const delegatedAmountRaw = view.getBigUint64(121, true).toString();
  if (
    address(32) !== wallet ||
    ![1, 2].includes(bytes[108]) ||
    (delegate === null && delegatedAmountRaw !== '0') ||
    (nativeReserveRaw !== null &&
      BigInt(nativeReserveRaw) > BigInt(account.lamports))
  )
    throw Error('Owned token account owner or state differs.');
  const extensions: MarketplaceTokenAccount['extensions'] = [];
  if (bytes.length > 165) {
    if (program !== MARKETPLACE_TOKEN_PROGRAMS[1] || bytes[165] !== 2)
      throw Error('Owned token extension discriminator differs.');
    for (let offset = 166; offset < bytes.length;) {
      if (bytes.slice(offset).every((b) => b === 0)) break;
      if (offset + 4 > bytes.length || extensions.length >= 64)
        throw Error('Owned token extensions truncated or excessive.');
      const end = offset + 4 + view.getUint16(offset + 2, true);
      if (end > bytes.length) throw Error('Owned token extension truncated.');
      const encoded = bytes.slice(offset, end),
        extension = getExtensionDecoder().decode(encoded);
      if (
        !MARKETPLACE_ACCOUNT_EXTENSIONS.some((e) => e === extension.__kind) ||
        extensions.some((e) => e === extension.__kind)
      )
        throw Error('Owned token extension type differs or is repeated.');
      const canonical = getExtensionEncoder().encode(extension);
      if (
        canonical.length !== encoded.length ||
        canonical.some((b, i) => b !== encoded[i])
      )
        throw Error('Owned token extension encoding differs.');
      extensions.push(
        extension.__kind as MarketplaceTokenAccount['extensions'][number],
      );
      offset = end;
    }
  }
  return marketplaceTokenAccount.parse({
    address: entry.pubkey,
    program,
    walletOwner: wallet,
    mint: address(0),
    slot: observedSlot,
    amountRaw: view.getBigUint64(64, true).toString(),
    lamports: account.lamports,
    state: bytes[108] === 1 ? 'initialized' : 'frozen',
    delegate,
    delegatedAmountRaw,
    closeAuthority,
    nativeReserveRaw,
    extensions: extensions.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    byteLength: bytes.length,
    encodedDataSha256: await digest(account.data[0]),
  });
}

/** Server-internal. The caller must authenticate and authorize before invoking the supplied owned SQL reader. No financial capability. */
export async function inspectMarketplaceSaleTokens(
  readInventory: () => Promise<MarketplaceOwnedInventory>,
  input: unknown,
  options: { signal: AbortSignal; fetcher?: typeof fetch; now?: () => number },
) {
  const { fetcher = fetch, now = Date.now } = options,
    signal = AbortSignal.any([options.signal, AbortSignal.timeout(60000)]);
  const selection = operatorListingSelection.parse(input);
  signal.throwIfAborted();
  const startedAt = now(),
    before = admitMarketplaceOwnedInventory(await readInventory(), now());
  const wallet = before.wallets.find(
    (w) =>
      w.address === selection.address &&
      w.revision === selection.walletRevision,
  );
  if (!wallet)
    throw new MarketplaceSaleInspectionChangedError(
      'Seller wallet changed. Reload inventory.',
    );
  const sellerEvidenceSha256 = await tokenInspectionSourceHash(wallet),
    endpoint = getSolanaRpcEndpoint('mainnet');
  const rpc = async (method: string, params: unknown[], maxBytes = 16384) => {
    signal.throwIfAborted();
    const value = await balanceRpc(
      endpoint,
      method,
      params,
      signal,
      fetcher,
      maxBytes,
    );
    signal.throwIfAborted();
    return value;
  };
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw Error('Owned token provider network differs.');
  const floorSlot = Number(
    slot.parse(await rpc('getSlot', [{ commitment: 'confirmed' }])),
  );
  let floor = floorSlot;
  const accounts: MarketplaceTokenAccount[] = [],
    programs: {
      program: (typeof MARKETPLACE_TOKEN_PROGRAMS)[number];
      slot: number;
      count: number;
    }[] = [],
    seen = new Set<string>();
  for (const program of MARKETPLACE_TOKEN_PROGRAMS) {
    const result = z
      .object({
        context: z.object({ slot }),
        value: z.array(z.unknown()).max(MARKETPLACE_TOKEN_ACCOUNT_LIMIT),
      })
      .parse(
        await rpc(
          'getTokenAccountsByOwner',
          [
            selection.address,
            { programId: program },
            {
              encoding: 'base64',
              commitment: 'confirmed',
              minContextSlot: floor,
            },
          ],
          2097152,
        ),
      );
    const observed = Number(result.context.slot);
    if (
      observed < floor ||
      accounts.length + result.value.length > MARKETPLACE_TOKEN_ACCOUNT_LIMIT
    )
      throw Error('Owned token account context or enumeration limit differs.');
    requireConsistentSolanaSlots([floorSlot, observed]);
    for (const raw of result.value) {
      signal.throwIfAborted();
      const decoded = await decodeMarketplaceTokenAccount(
        raw,
        program,
        selection.address,
        observed,
      );
      if (seen.has(decoded.address))
        throw Error('Duplicate owned token account.');
      seen.add(decoded.address);
      accounts.push(decoded);
    }
    programs.push({ program, slot: observed, count: result.value.length });
    floor = observed;
  }
  const finalSlot = Number(
    slot.parse(
      await rpc('getSlot', [
        { commitment: 'confirmed', minContextSlot: floor },
      ]),
    ),
  );
  if (finalSlot < floor)
    throw Error('Owned token final context predates observations.');
  requireConsistentSolanaSlots([
    floorSlot,
    ...programs.map((p) => p.slot),
    finalSlot,
  ]);
  const after = admitMarketplaceOwnedInventory(await readInventory(), now()),
    current = after.wallets.find((w) => w.address === selection.address);
  signal.throwIfAborted();
  if (
    !current ||
    (await tokenInspectionSourceHash(current)) !== sellerEvidenceSha256
  )
    throw new MarketplaceSaleInspectionChangedError(
      'Seller wallet evidence changed during token inspection.',
    );
  signal.throwIfAborted();
  const observedAt = now();
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < startedAt ||
    observedAt - startedAt >= 60000
  )
    throw Error('Owned token inspection expired.');
  accounts.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  return marketplaceTokenInspection.parse({
    format: 'bundle-sale-token-inspection-v1',
    chain: 'Solana',
    selection,
    sellerEvidenceSha256,
    startedAt: new Date(startedAt).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(startedAt + 60000).toISOString(),
    source: new URL(endpoint).hostname,
    commitment: 'confirmed',
    floorSlot,
    finalSlot,
    programs,
    accounts,
    ...tokenInspectionCounts(accounts, selection.address),
    coverage: MARKETPLACE_TOKEN_COVERAGE,
    currentControlVerified: false,
    allAssetsAndAuthoritiesChecked: false,
    extensionSemanticsChecked: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
}
