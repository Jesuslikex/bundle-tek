import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit';
import { volumePumpFixture } from './volume-pump-simulation-fixture';
import { VOLUME_TOKEN } from '../lib/volume-bundle-construction';
import type { VolumeFinalizedReceipt } from '../lib/volume-bundle-settlement';
export async function volumePumpSettlementFixture() {
  const f = await volumePumpFixture();
  // Same documented synthetic seed as volume-bundle-fixture. No actual wallet is used.
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(f.review.transaction), (c) => c.charCodeAt(0)),
  );
  const signature = nacl.sign.detached(
    Uint8Array.from(tx.messageBytes),
    pair.secretKey,
  );
  const packet = getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...tx,
      signatures: { [f.review.wallet]: signature },
    } as unknown as typeof tx),
  );
  const tokens = [
    {
      accountIndex: f.index(f.input.tokenAccount),
      mint: f.input.mint,
      owner: f.review.wallet,
      programId: VOLUME_TOKEN,
      uiTokenAmount: { amount: '0', decimals: 6 },
    },
    {
      accountIndex: f.index(f.roles.associated_bonding_curve),
      mint: f.input.mint,
      owner: f.roles.bonding_curve,
      programId: VOLUME_TOKEN,
      uiTokenAmount: { amount: '1000000', decimals: 6 },
    },
  ];
  const receipt: VolumeFinalizedReceipt = {
    commitment: 'finalized',
    signature: bs58.encode(signature),
    result: {
      slot: 1100,
      transaction: [packet, 'base64'],
      meta: {
        err: null,
        fee: 5000,
        preBalances: f.before.slice(0, -2).map((a) => a.lamports),
        postBalances: f.after.slice(0, -2).map((a) => a.lamports),
        preTokenBalances: tokens,
        postTokenBalances: structuredClone(tokens),
        innerInstructions: f.simulation.value.innerInstructions,
        loadedAddresses: { writable: [], readonly: [] },
      },
    },
  };
  return { ...f, packet, receipt };
}
