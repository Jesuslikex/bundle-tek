import bs58 from 'bs58';
import { solanaTransferMessage } from './solana-transfer-message';
import { getSolanaRpcEndpoint, rpcCall } from './solana-rpc';

// The buyer signs, the server relays. Building the message server-side keeps the
// RPC and the blockhash off the client, matching the warm-up prepare/submit
// shape rather than inventing a second transport.
export const MARKETPLACE_PAYMENT_LIFETIME_MS = 120_000;

export type MarketplacePaymentTerms = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  expiresAt: string;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A signature is 64 bytes, so its base58 form is far longer than a key.
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;

export function marketplacePaymentMessage(
  from: string,
  to: string,
  blockhash: string,
  lamports: bigint,
) {
  if (!BASE58.test(from) || !BASE58.test(to))
    throw Error('Invalid payment wallet.');
  return solanaTransferMessage(from, to, blockhash, lamports);
}

export async function prepareMarketplacePayment(
  from: string,
  to: string,
  lamports: bigint,
  endpoint = getSolanaRpcEndpoint('mainnet'),
): Promise<MarketplacePaymentTerms> {
  const latest = await rpcCall<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>(endpoint, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
  const blockhash = latest?.value?.blockhash;
  const lastValidBlockHeight = latest?.value?.lastValidBlockHeight;
  if (
    typeof blockhash !== 'string' ||
    !Number.isSafeInteger(lastValidBlockHeight)
  )
    throw Error('The payment blockhash could not be read.');
  const message = marketplacePaymentMessage(from, to, blockhash, lamports);
  return {
    transaction: Buffer.from(message).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    expiresAt: new Date(Date.now() + MARKETPLACE_PAYMENT_LIFETIME_MS).toISOString(),
  };
}

/** Relays a signed payment and returns its signature. */
export async function submitMarketplacePayment(
  transaction: string,
  endpoint = getSolanaRpcEndpoint('mainnet'),
): Promise<string> {
  const signature = await rpcCall<string>(endpoint, 'sendTransaction', [
    transaction,
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  if (typeof signature !== 'string' || !SIGNATURE.test(signature))
    throw Error('The payment signature could not be read.');
  return signature;
}

/** The signature of a signed transfer is the first 64 bytes of the packet. */
export function marketplacePaymentSignature(transaction: string) {
  const bytes = Buffer.from(transaction, 'base64');
  if (bytes.length < 65) throw Error('The signed payment is too short.');
  return bs58.encode(bytes.subarray(1, 65));
}
