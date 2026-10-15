import {
  address,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { VaultSession } from './browser-wallet-vault';
import { verifySolanaSignature } from './solana-signature';
import {
  requirePumpLaunchGroupReview,
  requirePumpLaunchGroupConsent,
  type PumpLaunchGroupReview,
  type PumpLaunchGroupConsent,
} from './pump-launch-group-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';

/** Browser-local primitive. Caller must establish durable approval, runtime qualification and a synchronous live UI/vault guard before unlocking. No RPC, storage or submission. */
export async function signPumpLaunchGroup(
  suppliedSessions: ReadonlyMap<string, VaultSession>,
  suppliedReview: PumpLaunchGroupReview,
  suppliedConsent: PumpLaunchGroupConsent,
  current: () => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const review = structuredClone(suppliedReview),
    consent = structuredClone(suppliedConsent),
    sessions = new Map(suppliedSessions);
  const seeds = new Map<
    string,
    { bytes: Uint8Array; hex: string; session: VaultSession }
  >();
  let identitiesReady = false;
  const selectedWallet = (session: VaultSession, key: string) => {
    const matches = Array.isArray(session?.payload?.wallets)
      ? session.payload.wallets.filter(
          (wallet) => wallet.family === 'solana' && wallet.address === key,
        )
      : [];
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].seed))
      throw new Error('Unlock each exact group wallet and mint identity once.');
    return matches[0];
  };
  const active = () => {
    signal?.throwIfAborted();
    if (typeof current !== 'function' || (current() as unknown) !== undefined)
      throw new Error('A synchronous live group signing guard is required.');
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new Error('Group review expired before signing completed.');
    if (identitiesReady) {
      if (suppliedSessions.size !== sessions.size)
        throw new Error('Group vault selection changed during signing.');
      for (const [key, seed] of seeds) {
        if (
          suppliedSessions.get(key) !== seed.session ||
          selectedWallet(seed.session, key).seed !== seed.hex
        )
          throw new Error('Group vault identity changed during signing.');
      }
    }
    signal?.throwIfAborted();
  };
  active();
  requirePumpLaunchGroupConsent(review, consent);
  const { built, transactions: unsigned } =
    await requirePumpLaunchGroupReview(review);
  active();
  const required = [
    ...new Set(built.packets.flatMap((p) => p.requiredSigners)),
  ];
  if (
    sessions.size !== required.length ||
    required.some((key) => !sessions.has(key))
  )
    throw new Error(
      'Unlock exactly the complete group signer set; zero slots do not sign.',
    );
  try {
    // Validate all identities before creating any signature, including keys only used in the last packet.
    for (const key of required) {
      active();
      const session = sessions.get(key)!,
        hex = selectedWallet(session, key).seed,
        bytes = Uint8Array.from(hex.match(/../g)!, (part) =>
          parseInt(part, 16),
        );
      seeds.set(key, { bytes, hex, session });
      const pair = nacl.sign.keyPair.fromSeed(bytes);
      try {
        if (bs58.encode(pair.publicKey) !== key)
          throw new Error(
            'Group vault seed does not match its reviewed address.',
          );
      } finally {
        pair.secretKey.fill(0);
      }
    }
    identitiesReady = true;
    active();
    const transactions: string[] = [];
    for (const [index, original] of unsigned.entries()) {
      active();
      const signatures = { ...original.signatures };
      for (const key of built.packets[index].requiredSigners) {
        active();
        const pair = nacl.sign.keyPair.fromSeed(seeds.get(key)!.bytes);
        try {
          const bytes = nacl.sign.detached(
            Uint8Array.from(original.messageBytes),
            pair.secretKey,
          );
          if (
            !verifySolanaSignature(
              Uint8Array.from(original.messageBytes),
              bytes,
              pair.publicKey,
            )
          )
            throw new Error('Group signature failed strict verification.');
          signatures[address(key)] = bytes as SignatureBytes;
        } finally {
          pair.secretKey.fill(0);
        }
      }
      active();
      transactions.push(
        getBase64Decoder().decode(
          getTransactionEncoder().encode({ ...original, signatures }),
        ),
      );
    }
    active();
    const evidence = await verifyPumpLaunchGroupSignatures(
      review,
      transactions,
      signal,
    );
    active();
    return evidence;
  } finally {
    for (const seed of seeds.values()) seed.bytes.fill(0);
    seeds.clear();
  }
}
