import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { planVolumeBundles } from '../lib/volume-bundle-plan';
import {
  constructVolumeBundle,
  VOLUME_TOKEN,
  VOLUME_SYSTEM,
  type VolumeBundleConstructionInput,
} from '../lib/volume-bundle-construction';
import type { VolumeFinalizedReceipt } from '../lib/volume-bundle-settlement';

// Deterministic synthetic keys only. No provider, real wallet, transaction simulation or send.
const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
export const wallet = bs58.encode(pair.publicKey);
export const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
export function volumeConstructionInput(): VolumeBundleConstructionInput {
  const plan = planVolumeBundles(
    {
      targetVolumeLamports: '1000000000',
      buyLamports: '50000000',
      durationSeconds: 1800,
      delayMinMs: 1000,
      delayMaxMs: 1000,
      tipBudgetLamports: '1000000',
      wallets: [wallet],
    },
    '0123456789abcdef0123456789abcdef',
  );
  const route = (tag: number) => [
    {
      programAddress: key(6),
      accounts: [
        { address: wallet, role: 3 as const },
        { address: key(2), role: 1 as const },
        { address: key(4), role: 1 as const },
        { address: key(5), role: 1 as const },
        { address: key(3), role: 0 as const },
        { address: VOLUME_TOKEN, role: 0 as const },
        { address: VOLUME_SYSTEM, role: 0 as const },
      ],
      dataBase64: btoa(String.fromCharCode(tag)),
    },
  ];
  return {
    plan,
    projectId: '00000000-0000-4000-8000-000000000001',
    projectRevision: 1,
    sessionId: '00000000-0000-4000-8000-000000000002',
    sessionRevision: 1,
    round: 0,
    mint: key(3),
    tokenAccount: key(2),
    tokenAmountRaw: '100000',
    minimumSellLamports: '49000000',
    networkFeeCapLamports: '5000',
    maximumLossLamports: '200000',
    tipRecipient: key(7),
    tipLamports: '2000',
    blockhash: key(8),
    lastValidBlockHeight: '500',
    buy: route(1),
    sell: route(2),
  };
}
export async function volumeSettlementFixture() {
  const input = volumeConstructionInput(),
    review = await constructVolumeBundle(input);
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
  );
  const signature = nacl.sign.detached(
    Uint8Array.from(tx.messageBytes),
    pair.secretKey,
  );
  const signed = {
    ...tx,
    signatures: { [wallet]: signature },
  } as unknown as typeof tx;
  const encoded = getBase64Decoder().decode(
    getTransactionEncoder().encode(signed),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  const keys = message.staticAccounts.map(String),
    index = (s: string) => keys.indexOf(s);
  const native = (from: string, to: string, amount: bigint) => {
    const bytes = new Uint8Array(12),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, amount, true);
    return {
      programIdIndex: index(VOLUME_SYSTEM),
      accounts: [index(from), index(to)],
      data: bs58.encode(bytes),
    };
  };
  const token = (from: string, to: string, authority: string) => {
    const bytes = new Uint8Array(10),
      view = new DataView(bytes.buffer);
    bytes[0] = 12;
    view.setBigUint64(1, 100000n, true);
    bytes[9] = 6;
    return {
      programIdIndex: index(VOLUME_TOKEN),
      accounts: [index(from), index(input.mint), index(to), index(authority)],
      data: bs58.encode(bytes),
    };
  };
  const before = keys.map(() => 1000000000),
    after = [...before];
  after[0] -= 107000;
  after[index(input.tipRecipient)] += 2000;
  after[index(key(4))] += 100000;
  const ownToken = {
    accountIndex: index(input.tokenAccount),
    mint: input.mint,
    owner: wallet,
    programId: VOLUME_TOKEN,
    uiTokenAmount: { amount: '0', decimals: 6 },
  };
  const receipt: VolumeFinalizedReceipt = {
    commitment: 'finalized',
    signature: bs58.encode(signature),
    result: {
      slot: 400,
      transaction: [encoded, 'base64'],
      meta: {
        err: null,
        fee: 5000,
        preBalances: before,
        postBalances: after,
        preTokenBalances: [ownToken],
        postTokenBalances: [structuredClone(ownToken)],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              native(wallet, key(4), 50000000n),
              token(key(5), input.tokenAccount, key(4)),
            ],
          },
          {
            index: 1,
            instructions: [
              token(input.tokenAccount, key(5), wallet),
              native(key(4), wallet, 49900000n),
            ],
          },
        ],
      },
    },
  };
  return { review, receipt, index, input };
}
