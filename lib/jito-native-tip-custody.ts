import { snapshotJitoEvidence } from './jito-evidence-json';
import { inspectJitoTipReceiver } from './jito-tip-account-evidence';

/** Native diagnostic only: shared tip receiver is not a controlled wallet.
 * Exact payer custody and simulation spending remain independently required. */
export async function inspectJitoNativeTipCustody(input: {
  tip: string;
  before: unknown[];
  after: unknown[];
}) {
  const v = snapshotJitoEvidence(input, 16384);
  const fail = (): never => {
    throw Error('Native custody role evidence differs.');
  };
  if (v.before.length !== 4 || v.after.length !== 4) fail();
  if (
    JSON.stringify(v.before[0]) !== JSON.stringify(v.after[0]) ||
    JSON.stringify(v.before[3]) !== JSON.stringify(v.after[3])
  )
    fail();
  const first = await inspectJitoTipReceiver({
    address: v.tip,
    account: v.before[1],
    rentAccount: v.before[3],
  });
  const last = await inspectJitoTipReceiver({
    address: v.tip,
    account: v.after[1],
    rentAccount: v.after[3],
  });
  const withoutBalance = (a: unknown) => {
    const { lamports: _balance, ...rest } = a as Record<string, unknown>;
    return rest;
  };
  if (
    JSON.stringify(withoutBalance(v.before[1])) !==
    JSON.stringify(withoutBalance(v.after[1]))
  )
    fail();
  return {
    payerUnchanged: true as const,
    tipIdentityRentUnchanged: true as const,
    externalTipBalanceDelta: (
      BigInt(last.lamports) - BigInt(first.lamports)
    ).toString(),
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
