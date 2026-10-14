import { verifyPumpLaunchGroupTrace } from './pump-launch-group-trace';
import {
  verifyPumpLaunchGroupSettlement,
  type PumpHolderSettlementEvidence,
} from './pump-holder-settlement';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import {
  pumpUnsignedInteger,
  pumpAccountBytes,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
import type { PumpHolderMessageInput } from './pump-holder-message';
import type {
  PumpHolderAllowances,
  collectPumpLaunchGroupFunding,
} from './pump-holder-funding';
type Evidence = {
  funding: Awaited<ReturnType<typeof collectPumpLaunchGroupFunding>>;
  response: unknown;
  minimumRentBySize: PumpHolderSettlementEvidence['minimumRentBySize'];
  creationAccountHashes: PumpHolderSettlementEvidence['creationAccountHashes'];
};
const sol = (account: PumpRpcAccount) =>
  account ? pumpUnsignedInteger(account.lamports) : 0n;
const token = (account: PumpRpcAccount) => {
  if (!account) return 0n;
  const data = pumpAccountBytes(account);
  if (data.length < 165) throw new Error('Group quote account data differs.');
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(64, true);
};

/** Independent economics over a reconstructed, reverified complete sequential trace. Never approves or signs. */
export async function verifyPumpLaunchGroupAccounting(
  supplied: PumpHolderMessageInput,
  suppliedLimits: PumpHolderAllowances,
  suppliedEvidence: Evidence,
  signal?: AbortSignal,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedLimits),
    evidence = structuredClone(suppliedEvidence);
  signal?.throwIfAborted();
  const trace = await verifyPumpLaunchGroupTrace(
      input,
      limits,
      evidence.funding,
      evidence.response,
      signal,
    ),
    group = await buildPumpLaunchPacketGroup(input, signal);
  const native = input.create.quoteMint === PUMP_NATIVE_QUOTE;
  const caps = new Map([
    [
      input.create.payer,
      pumpUnsignedInteger(limits.deployerFeeAndRentLimitRaw) +
        (native
          ? pumpUnsignedInteger(input.developer?.maximumQuoteCostRaw ?? '0')
          : 0n),
    ],
    ...input.holders.flatMap((h, i) =>
      h.kind === 'none'
        ? []
        : [
            [
              h.address,
              pumpUnsignedInteger(limits.holders[i].feeAndRentLimitRaw) +
                (native
                  ? pumpUnsignedInteger(
                      h.kind === 'exact-base-output'
                        ? h.maximumQuoteCostRaw
                        : h.quoteAmountRaw,
                    )
                  : 0n),
            ] as const,
          ],
    ),
  ]);
  const quoteLimits = new Map([
    [
      input.create.payer,
      pumpUnsignedInteger(input.developer?.maximumQuoteCostRaw ?? '0'),
    ],
    ...input.holders.flatMap((h) =>
      h.kind === 'none'
        ? []
        : [
            [
              h.address,
              pumpUnsignedInteger(
                h.kind === 'exact-base-output'
                  ? h.maximumQuoteCostRaw
                  : h.quoteAmountRaw,
              ),
            ] as const,
          ],
    ),
  ]);
  const quotes = new Map<string, bigint>(
    group.packets
      .flatMap((p) => p.buyerAccounts)
      .map((b) => [b.userQuoteAccount, quoteLimits.get(b.payer)!]),
  );
  const debits = new Map<string, bigint>(),
    quoteDebits = new Map<string, bigint>();
  const current = new Map<string, PumpRpcAccount>(
    trace.addresses.map((address, i) => [address, trace.before[i]]),
  );
  const prefixes: Awaited<
    ReturnType<typeof verifyPumpLaunchGroupSettlement>
  >[] = [];
  let cumulativeFee = 0n;
  for (const frame of trace.frames) {
    signal?.throwIfAborted();
    if (
      frame.before.reduce((sum, a) => sum + sol(a), 0n) -
        frame.after.reduce((sum, a) => sum + sol(a), 0n) !==
      pumpUnsignedInteger(frame.networkFeeRaw)
    )
      throw new Error('Group packet SOL conservation differs from its fee.');
    for (const [i, address] of frame.addresses.entries()) {
      if (caps.has(address)) {
        const debit = sol(frame.before[i]) - sol(frame.after[i]);
        const total = (debits.get(address) ?? 0n) + (debit > 0n ? debit : 0n);
        debits.set(address, total);
        if (total > caps.get(address)!)
          throw new Error(
            'Group wallet cumulative SOL debit exceeds its reviewed cap.',
          );
      }
      if (!native && quotes.has(address)) {
        const debit = token(frame.before[i]) - token(frame.after[i]);
        const total =
          (quoteDebits.get(address) ?? 0n) + (debit > 0n ? debit : 0n);
        quoteDebits.set(address, total);
        if (total > quotes.get(address)!)
          throw new Error(
            'Group wallet cumulative quote debit exceeds its reviewed cap.',
          );
      }
    }
    frame.addresses.forEach((address, i) =>
      current.set(address, frame.after[i]),
    );
    cumulativeFee += pumpUnsignedInteger(frame.networkFeeRaw);
    prefixes.push(
      await verifyPumpLaunchGroupSettlement(
        input,
        limits,
        {
          addresses: trace.addresses,
          before: trace.before,
          after: trace.addresses.map((address) => current.get(address)!),
          networkFeeRaw: cumulativeFee.toString(),
          minimumRentBySize: evidence.minimumRentBySize,
          creationAccountHashes: evidence.creationAccountHashes,
        },
        frame.index + 1,
      ),
    );
  }
  const accounting = prefixes.at(-1)!;
  if (
    !accounting.fullGroupAccountingValidated ||
    cumulativeFee.toString() !== trace.networkFeeRaw
  )
    throw new Error('Group economic coverage is incomplete.');
  signal?.throwIfAborted();
  return {
    ...accounting,
    format: 'pump-launch-group-accounting-v1' as const,
    traceVerificationRequired: false as const,
    sequentialTraceValidated: true as const,
    perPacketConservationValidated: true as const,
    cumulativeCapsValidated: true as const,
    economicPrefixesValidated: true as const,
    rpcCollectionRequired: true as const,
    programDeploymentReviewRequired: true as const,
    frames: trace.frames.map((f) => ({
      index: f.index,
      packetSha256: f.packetSha256,
      networkFeeRaw: f.networkFeeRaw,
    })),
    bankSlot: trace.bankSlot,
  };
}
