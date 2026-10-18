import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit-v1';
import {
  getAllocateInstructionDataCodec,
  getAssignInstructionDataCodec,
  getCreateAccountInstructionDataCodec,
  getCreateAccountAllowPrefundInstructionDataCodec,
  getTransferSolInstructionDataCodec,
  identifySystemInstruction,
  SystemInstruction,
} from '@solana-program/system';
import bs58 from 'bs58';
import { requirePumpLaunchGroupReview } from './pump-launch-group-review';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
} from './pump-launch-config';
import createSchema from './pump-launch-schema.json';
import buySchema from './pump-initial-buy-schema.json';
import quoteSchema from './pump-exact-quote-schema.json';
import type {
  parsePumpGroupReceiptEvidence,
  PumpGroupReceiptEvidence,
} from './pump-group-receipt-evidence';
import {
  validatedAccountLaunchPayments,
  type AccountLaunchPayments,
  type PumpPaymentPacket,
  type PumpPaymentReason,
  type PumpPaymentWallet,
} from './account-launch-payments';
type Group = Parameters<typeof parsePumpGroupReceiptEvidence>[1];
type Built = Awaited<ReturnType<typeof requirePumpLaunchGroupReview>>['built'];
type Root = { program: string; accounts: string[]; data: Uint8Array };
type Setup = { payer: string; owner: string };
const SYSTEM = '11111111111111111111111111111111',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
class CoverageError extends Error {
  constructor(readonly reason: PumpPaymentReason) {
    super(reason);
  }
}
const refuse = (reason: PumpPaymentReason): never => {
  throw new CoverageError(reason);
};
const index = (v: unknown, bound: number) => {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && /^(0|[1-9]\d{0,5})$/.test(v)
        ? Number(v)
        : -1;
  if (!Number.isSafeInteger(n) || n < 0 || n >= bound)
    return refuse('instruction-scope-differs');
  return n;
};
const prefix = (data: Uint8Array, bytes: number[]) =>
  data.length >= bytes.length && bytes.every((v, i) => data[i] === v);
function decode<T>(
  codec: { read(bytes: Uint8Array, offset: number): readonly [T, number] },
  bytes: Uint8Array,
): T {
  try {
    const [v, end] = codec.read(bytes, 0);
    if (end !== bytes.length) return refuse('instruction-scope-differs');
    return v;
  } catch (e) {
    if (e instanceof CoverageError) throw e;
    return refuse('instruction-scope-differs');
  }
}
function analyze(
  evidence: PumpGroupReceiptEvidence,
  built: Built,
  packetIndex: number,
  signal: AbortSignal,
): PumpPaymentPacket {
  const frame = evidence.report.packets[packetIndex],
    packet = built.packets[packetIndex];
  const base: PumpPaymentPacket = {
    index: packetIndex,
    outcome: frame.outcome,
    verified: false,
    reason: 'receipt-unobserved',
    networkFeeLamports: frame.networkFeeRaw,
    wallets: [],
  };
  if (frame.outcome === 'not-observed') return base;
  const source = evidence.receipts[packetIndex];
  if (
    !source ||
    !record(source.meta) ||
    !frame.effectsAvailable ||
    frame.networkFeeRaw === null
  )
    return { ...base, reason: 'balance-metadata-missing' };
  const payer = built.manifest.payer;
  const meta = source.meta;
  if (frame.outcome === 'failed')
    return {
      ...base,
      verified: true,
      reason: null,
      wallets: [
        {
          wallet: payer,
          hasBuy: false,
          acquiredRaw: '0',
          preTokenBalanceRecovered: false,
          purchaseQuoteRaw: '0',
          accountFundingLamports: '0',
          networkFeeLamports: frame.networkFeeRaw,
        },
      ],
    };
  try {
    const tx = getTransactionDecoder().decode(
      Buffer.from((source.transaction as string[])[0], 'base64'),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
        tx.messageBytes,
      ),
      keys = message.staticAccounts.map(String);
    if (
      message.version !== 1 ||
      message.numStaticAccounts !== keys.length ||
      message.numInstructions !== message.instructionHeaders.length ||
      message.instructionHeaders.length !== message.instructionPayloads.length
    )
      return refuse('instruction-scope-differs');
    const roots: Root[] = message.instructionHeaders.map((header, i) => {
      const payload = message.instructionPayloads[i];
      if (
        header.numInstructionAccounts !==
          payload.instructionAccountIndices.length ||
        header.numInstructionDataBytes !== payload.instructionData.length
      )
        return refuse('instruction-scope-differs');
      return {
        program: keys[index(header.programAccountIndex, keys.length)],
        accounts: payload.instructionAccountIndices.map(
          (i) => keys[index(i, keys.length)],
        ),
        data: Uint8Array.from(payload.instructionData),
      };
    });
    if (
      roots.length !== packet.instructions.length ||
      roots.some(
        (r, i) =>
          r.program !== String(packet.instructions[i].programAddress) ||
          Buffer.compare(
            r.data,
            Uint8Array.from(packet.instructions[i].data ?? []),
          ) !== 0 ||
          r.accounts.join(',') !==
            (packet.instructions[i].accounts ?? [])
              .map((a) => String(a.address))
              .join(','),
      )
    )
      return refuse('instruction-scope-differs');
    const create = built.packets[0].instructions.find(
      (ix) =>
        String(ix.programAddress) === PUMP_LAUNCH_PROGRAM &&
        prefix(
          Uint8Array.from(ix.data ?? []),
          createSchema.instruction.discriminator,
        ),
    );
    if (!create?.accounts) return refuse('instruction-scope-differs');
    const creation = create.accounts.map((a) => String(a.address));
    const native = evidence.report.quoteMint === PUMP_NATIVE_QUOTE;
    const allWallets = new Set(evidence.report.wallets.map((w) => w.address));
    const buyers = new Map<string, (typeof packet.buyerAccounts)[number]>(
      packet.buyerAccounts.map((b) => [b.payer, b]),
    );
    const participants = new Set([payer, ...buyers.keys()]);
    const isBuy = (r: Root) =>
      r.program === PUMP_LAUNCH_PROGRAM &&
      r.data.length === 25 &&
      (prefix(r.data, buySchema.instruction.discriminator) ||
        prefix(r.data, quoteSchema.instruction.discriminator));
    const buyRoots = new Map<string, number>();
    roots.forEach((r, i) => {
      if (isBuy(r)) {
        const b = buyers.get(r.accounts[8]);
        if (
          !b ||
          buyRoots.has(b.payer) ||
          r.accounts[9] !== b.userBaseAccount ||
          r.accounts[10] !== b.userQuoteAccount ||
          r.accounts[11] !== b.volumeAccount ||
          r.accounts[13] !== b.buybackAccount
        )
          return refuse('instruction-scope-differs');
        buyRoots.set(b.payer, i);
      }
    });
    if (buyRoots.size !== buyers.size)
      return refuse('instruction-scope-differs');
    const creationRoles = new Map<string, string>([
      [creation[0], PUMP_TOKEN_2022],
      [creation[2], PUMP_LAUNCH_PROGRAM],
      [creation[3], PUMP_TOKEN_2022],
      ...(!native
        ? [[creation[17], built.quote.tokenProgram] as [string, string]]
        : []),
    ]);
    function setup(root: Root, target: string): Setup | null {
      if (allWallets.has(target)) return null;
      if (
        root.program === PUMP_LAUNCH_PROGRAM &&
        prefix(root.data, createSchema.instruction.discriminator)
      ) {
        const owner = creationRoles.get(target);
        return owner ? { payer, owner } : null;
      }
      if (isBuy(root)) {
        const b = buyers.get(root.accounts[8]);
        if (!b) return null;
        if (target === b.volumeAccount)
          return { payer: b.payer, owner: PUMP_LAUNCH_PROGRAM };
        if (target === b.userBaseAccount)
          return { payer: b.payer, owner: PUMP_TOKEN_2022 };
        if (!native && target === b.buybackAccount)
          return { payer: b.payer, owner: built.quote.tokenProgram };
        return null;
      }
      if (
        root.program === ATA &&
        root.data.length === 1 &&
        root.data[0] === 1 &&
        root.accounts[1] === target
      ) {
        const b = buyers.get(root.accounts[0]);
        if (!b) return null;
        if (
          target === b.userBaseAccount &&
          root.accounts[2] === b.payer &&
          root.accounts[3] === evidence.report.mint &&
          root.accounts[5] === PUMP_TOKEN_2022
        )
          return { payer: b.payer, owner: PUMP_TOKEN_2022 };
        if (
          !native &&
          target === b.buybackAccount &&
          root.accounts[2] === b.buybackRecipient &&
          root.accounts[3] === evidence.report.quoteMint &&
          root.accounts[5] === built.quote.tokenProgram
        )
          return { payer: b.payer, owner: built.quote.tokenProgram };
      }
      return null;
    }
    if (!Array.isArray(meta.innerInstructions))
      return refuse('instruction-metadata-missing');
    const allocations = new Map<
      string,
      { space: bigint | null; owner: string | null }
    >();
    const flows: {
      root: number;
      from: string;
      to: string;
      amount: bigint;
      parent: string;
    }[] = [];
    let previous = -1,
      total = 0;
    for (const group of meta.innerInstructions) {
      signal.throwIfAborted();
      if (!record(group) || !Array.isArray(group.instructions))
        return refuse('instruction-scope-differs');
      const rootIndex = index(group.index, roots.length);
      if (
        rootIndex <= previous ||
        group.instructions.length > 4096 ||
        (total += group.instructions.length) > 4096
      )
        return refuse('instruction-scope-differs');
      previous = rootIndex;
      const root = roots[rootIndex],
        stack = [root.program];
      for (const instruction of group.instructions) {
        signal.throwIfAborted();
        if (
          !record(instruction) ||
          !Array.isArray(instruction.accounts) ||
          typeof instruction.data !== 'string'
        )
          return refuse('instruction-scope-differs');
        const depth = index(instruction.stackHeight, 65);
        if (depth < 2 || depth > stack.length + 1)
          return refuse('instruction-scope-differs');
        stack.length = depth - 1;
        const parent = stack[depth - 2],
          program = keys[index(instruction.programIdIndex, keys.length)];
        stack.push(program);
        const accounts = instruction.accounts.map(
          (v) => keys[index(v, keys.length)],
        );
        const available = new Set(root.accounts);
        if (
          (program !== root.program && !available.has(program)) ||
          accounts.some((a) => !available.has(a))
        )
          return refuse('instruction-scope-differs');
        if (program !== SYSTEM) continue;
        let data: Uint8Array, type: SystemInstruction;
        try {
          data = bs58.decode(instruction.data);
          if (bs58.encode(data) !== instruction.data)
            return refuse('instruction-scope-differs');
          type = identifySystemInstruction(data);
        } catch (e) {
          if (e instanceof CoverageError) throw e;
          return refuse('native-instruction-unsupported');
        }
        const account = (i: number) =>
          accounts[i] ?? refuse('instruction-scope-differs');
        function allocation(
          target: string,
          space: bigint | null,
          owner: string | null,
        ) {
          const role = setup(root, target);
          if (!role || (owner !== null && owner !== role.owner))
            return refuse('setup-funding-unclassified');
          if (
            owner !== null &&
            [PUMP_TOKEN_2022, built.quote.tokenProgram].includes(owner) &&
            Array.isArray(meta.preTokenBalances) &&
            meta.preTokenBalances.some(
              (row) =>
                record(row) &&
                keys[index(row.accountIndex, keys.length)] === target,
            )
          )
            return refuse('setup-funding-unclassified');
          const key = rootIndex + ':' + target,
            prior = allocations.get(key);
          if (
            prior &&
            ((space !== null &&
              prior.space !== null &&
              space !== prior.space) ||
              (owner !== null && prior.owner !== null && owner !== prior.owner))
          )
            return refuse('setup-funding-unclassified');
          allocations.set(key, {
            space: space ?? prior?.space ?? null,
            owner: owner ?? prior?.owner ?? null,
          });
        }
        if (type === SystemInstruction.TransferSol) {
          const d = decode(getTransferSolInstructionDataCodec(), data);
          flows.push({
            root: rootIndex,
            from: account(0),
            to: account(1),
            amount: d.amount,
            parent,
          });
        } else if (
          type === SystemInstruction.CreateAccount ||
          type === SystemInstruction.CreateAccountAllowPrefund
        ) {
          const d =
            type === SystemInstruction.CreateAccount
              ? decode(getCreateAccountInstructionDataCodec(), data)
              : decode(
                  getCreateAccountAllowPrefundInstructionDataCodec(),
                  data,
                );
          const target = account(
            type === SystemInstruction.CreateAccount ? 1 : 0,
          );
          allocation(target, d.space, String(d.programAddress));
          if (d.lamports > 0n)
            flows.push({
              root: rootIndex,
              from: account(type === SystemInstruction.CreateAccount ? 0 : 1),
              to: target,
              amount: d.lamports,
              parent,
            });
        } else if (type === SystemInstruction.Allocate) {
          const d = decode(getAllocateInstructionDataCodec(), data);
          allocation(account(0), d.space, null);
        } else if (type === SystemInstruction.Assign) {
          const d = decode(getAssignInstructionDataCodec(), data);
          allocation(account(0), null, String(d.programAddress));
        } else return refuse('native-instruction-unsupported');
      }
    }
    const movement = new Map<string, bigint>(),
      funding = new Map<string, bigint>(),
      payments = new Map<string, bigint>();
    const add = (m: Map<string, bigint>, k: string, n: bigint) =>
      m.set(k, (m.get(k) ?? 0n) + n);
    for (const f of flows) {
      if (f.amount === 0n) continue;
      // Refunds/other incoming native credits need their own attribution. Do
      // not call gross outgoing transfers a net buy debit when money returned.
      if (allWallets.has(f.to)) return refuse('native-flow-unexplained');
      if (allWallets.has(f.from)) add(movement, f.from, -f.amount);
      if (!allWallets.has(f.from)) continue;
      if (!participants.has(f.from)) return refuse('native-flow-unexplained');
      const root = roots[f.root],
        role = setup(root, f.to),
        allocated = allocations.get(f.root + ':' + f.to);
      if (
        role &&
        role.payer === f.from &&
        allocated?.owner === role.owner &&
        allocated.space !== null &&
        allocated.space > 0n
      ) {
        add(funding, f.from, f.amount);
        continue;
      }
      const b = buyers.get(f.from);
      if (
        native &&
        b &&
        buyRoots.get(b.payer) === f.root &&
        f.parent === PUMP_LAUNCH_PROGRAM &&
        [root.accounts[5], b.buybackAccount].includes(f.to)
      ) {
        add(payments, f.from, f.amount);
        continue;
      }
      return refuse('setup-funding-unclassified');
    }
    for (const w of frame.wallets) {
      const expected =
        (movement.get(w.address) ?? 0n) -
        (w.address === payer ? BigInt(frame.networkFeeRaw) : 0n);
      if (expected !== BigInt(w.solDeltaRaw))
        return refuse('native-flow-unexplained');
      if (
        !participants.has(w.address) &&
        (w.tokenDeltaRaw !== '0' || (!native && w.quoteDeltaRaw !== '0'))
      )
        return refuse('purchase-effect-differs');
    }
    function recoveredStartingAmount(wallet: string): bigint | null {
      const buyer = buyers.get(wallet);
      if (
        !buyer ||
        !Array.isArray(meta.preTokenBalances) ||
        !Array.isArray(meta.postTokenBalances)
      )
        return null;
      const accountIndex = keys.indexOf(buyer.userBaseAccount);
      if (
        accountIndex < 0 ||
        meta.preTokenBalances.some(
          (row) =>
            record(row) &&
            index(row.accountIndex, keys.length) === accountIndex,
        )
      )
        return null;
      const setupIndex = roots.findIndex(
        (r) =>
          r.program === ATA &&
          r.accounts[0] === wallet &&
          r.accounts[1] === buyer.userBaseAccount,
      );
      if (
        setupIndex < 0 ||
        roots
          .slice(0, setupIndex)
          .some((r) => r.accounts.includes(buyer.userBaseAccount))
      )
        return null;
      const allocated = allocations.get(
          setupIndex + ':' + buyer.userBaseAccount,
        ),
        role = setup(roots[setupIndex], buyer.userBaseAccount);
      if (
        !role ||
        role.payer !== wallet ||
        role.owner !== PUMP_TOKEN_2022 ||
        allocated?.owner !== PUMP_TOKEN_2022 ||
        allocated.space === null ||
        allocated.space < 165n
      )
        return null;
      const post = meta.postTokenBalances.find(
        (row) =>
          record(row) && index(row.accountIndex, keys.length) === accountIndex,
      );
      if (
        !record(post) ||
        post.owner !== wallet ||
        post.mint !== evidence.report.mint ||
        post.programId !== PUMP_TOKEN_2022 ||
        !record(post.uiTokenAmount) ||
        post.uiTokenAmount.decimals !== 6 ||
        typeof post.uiTokenAmount.amount !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(post.uiTokenAmount.amount) ||
        BigInt(post.uiTokenAmount.amount) > (1n << 64n) - 1n
      )
        return null;
      return BigInt(post.uiTokenAmount.amount);
    }
    const wallets: PumpPaymentWallet[] = [];
    for (const wallet of participants) {
      const effect = frame.wallets.find((w) => w.address === wallet);
      if (!effect || (!native && effect.quoteDeltaRaw === null))
        return refuse('balance-metadata-missing');
      const hasBuy = buyers.has(wallet),
        acquired =
          effect.tokenDeltaRaw === null
            ? recoveredStartingAmount(wallet)
            : BigInt(effect.tokenDeltaRaw),
        spent = native
          ? (payments.get(wallet) ?? 0n)
          : -BigInt(effect.quoteDeltaRaw!);
      if (acquired === null) return refuse('balance-metadata-missing');
      if (
        hasBuy ? acquired <= 0n || spent <= 0n : acquired !== 0n || spent !== 0n
      )
        return refuse('purchase-effect-differs');
      wallets.push({
        wallet,
        hasBuy,
        acquiredRaw: acquired.toString(),
        preTokenBalanceRecovered: effect.tokenDeltaRaw === null,
        purchaseQuoteRaw: spent.toString(),
        accountFundingLamports: (funding.get(wallet) ?? 0n).toString(),
        networkFeeLamports: wallet === payer ? frame.networkFeeRaw : '0',
      });
    }
    return { ...base, verified: true, reason: null, wallets };
  } catch (e) {
    if (e instanceof CoverageError) return { ...base, reason: e.reason };
    throw e;
  }
}

/** Projects already cryptographically parsed retained evidence. No provider,
 * writes, lot admission or economic/signing authority. The owner service must
 * call parsePumpGroupReceiptEvidence before this projection. */
export async function projectVerifiedPumpGroupPayments(
  evidence: PumpGroupReceiptEvidence,
  group: Group,
  signal: AbortSignal,
): Promise<AccountLaunchPayments> {
  signal.throwIfAborted();
  const { built, review } = await requirePumpLaunchGroupReview(
    structuredClone(group.review),
    false,
  );
  if (
    !group.signedEvidence ||
    evidence.report.reviewId !== review.id ||
    evidence.report.contextSha256 !== review.contextSha256 ||
    evidence.report.signedGroupSha256 !==
      group.signedEvidence.signedGroupSha256 ||
    evidence.receipts.length !== built.packets.length
  )
    throw new Error('Retained payment projection scope differs.');
  const packets = built.packets.map((_, i) =>
    analyze(evidence, built, i, signal),
  );
  const wallets = packets.flatMap((p) => p.wallets);
  const sum = (key: 'purchaseQuoteRaw' | 'accountFundingLamports') =>
    wallets.reduce((s, w) => s + BigInt(w[key]), 0n).toString();
  const result: AccountLaunchPayments = {
    format: 'pump-group-payments-v1',
    reviewId: review.id,
    mint: evidence.report.mint,
    evidenceSha256: evidence.sha256,
    quoteMint: evidence.report.quoteMint,
    quoteDecimals: evidence.report.quoteDecimals,
    packets,
    verifiedPacketCount: packets.filter((p) => p.verified).length,
    purchaseQuoteSubtotalRaw: sum('purchaseQuoteRaw'),
    accountFundingSubtotalLamports: sum('accountFundingLamports'),
    knownNetworkFeeLamports: packets
      .reduce((s, p) => s + BigInt(p.networkFeeLamports ?? '0'), 0n)
      .toString(),
    complete: packets.every((p) => p.verified),
    rentRecoveryVerified: false,
    venueFeeSplitVerified: false,
    acquisitionBasisVerified: false,
    tipIncluded: false,
    executionAllowed: false,
  };
  signal.throwIfAborted();
  return validatedAccountLaunchPayments(result, {
    reviewId: review.id,
    mint: evidence.report.mint,
    evidenceSha256: evidence.sha256,
  });
}
