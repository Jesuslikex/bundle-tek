import { pumpLaunchGroupReviewFixture } from './pump-launch-group-review-fixture';
import { signSyntheticPumpGroup } from './pump-group-synthetic-signatures';
import { pumpRuntimePreviewFixture } from './pump-runtime-preview-fixture';
import { verifyPumpLaunchGroupSignatures } from '../lib/pump-launch-group-signatures';
import {
  buildPumpGroupTip,
  verifyPumpGroupTip,
  PUMP_GROUP_JITO_ENDPOINT,
  PUMP_GROUP_JITO_TIP_ACCOUNTS,
  type PumpGroupBroadcastReview,
  type PumpGroupBroadcastState,
} from '../lib/pump-group-broadcast';
import { pumpHolderDigest } from '../lib/pump-holder-review';
import type { PumpGroupView } from '../lib/pump-launch-group-client';
/** Only generated fixtures, public packets and synthetic signatures. No vault/provider access. */
export async function pumpGroupBroadcastClientFixture() {
  const f = await pumpLaunchGroupReviewFixture();
  const transactions = await signSyntheticPumpGroup(f.review.packets, [
    f.fixture.f.f.payerSigner,
    f.fixture.f.f.mintSigner,
    ...f.fixture.holderSigners,
  ]);
  const signed = await verifyPumpLaunchGroupSignatures(f.review, transactions),
    code = await pumpRuntimePreviewFixture(f.review);
  const body: Omit<PumpGroupBroadcastReview, 'sha256'> = {
    format: 'pump-group-jito-broadcast-v1',
    id: crypto.randomUUID(),
    reviewId: f.review.id,
    contextSha256: f.review.contextSha256,
    signedGroupSha256: signed.signedGroupSha256,
    codeIdentitySha256: code.identitySha256,
    endpoint: PUMP_GROUP_JITO_ENDPOINT,
    payer: f.review.input.create.payer,
    recipient: PUMP_GROUP_JITO_TIP_ACCOUNTS[0],
    tipRaw: '1000',
    tipFeeLimitRaw: '5000',
    tipTransaction: '',
    lastValidBlockHeight: f.review.input.create.lastValidBlockHeight,
    blockhash: f.review.input.create.blockhash,
    transactions,
    createdAt: new Date().toISOString(),
    expiresAt: f.review.expiresAt,
    atomicity: 'jito-transport-requested-not-proven',
    executionAllowed: false,
    completeLaunch: false,
  };
  body.tipTransaction = buildPumpGroupTip(body).transaction;
  const review = { ...body, sha256: await pumpHolderDigest(body) },
    message = buildPumpGroupTip(review).message;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      f.fixture.f.f.payerSigner.keyPair.privateKey,
      message,
    ),
  );
  const tip = await verifyPumpGroupTip(
    review,
    Buffer.from(Uint8Array.from([1, ...signature, ...message])).toString(
      'base64',
    ),
  );
  const group: PumpGroupView = {
    review: f.review,
    state: 'signed',
    receipt: null,
    quoteDecimals: 9,
    signedEvidence: signed,
  };
  const state: PumpGroupBroadcastState = {
    review,
    code,
    tip: null,
    attempted: false,
    result: null,
    recovery: null,
    reservationsReleased: false,
  };
  return { f, review, tip, group, state };
}
