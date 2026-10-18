import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  validateVolumePumpRoute,
  type VolumePumpRoute,
} from './volume-bundle-route';
import { reviewVolumePumpInner } from './volume-bundle-simulation';
import { withdrawalFailureReason } from './withdrawal-failure';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getBase64Decoder,
} from '@solana/kit';
import {
  requireVolumeBundleConstruction,
  volumeUint,
  volumeReject,
  volumeBytesDigest,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
  type VolumeBundleConstruction,
} from './volume-bundle-construction';

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: { amount: string; decimals: number };
};
type InnerInstruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
};
/** Collected finalized getTransaction result with base64 encoding. No provider call or signature creation. */
export type VolumeFinalizedReceipt = {
  commitment: 'finalized';
  signature: string;
  result: {
    slot: number;
    transaction: [string, 'base64'];
    meta: {
      err: unknown;
      fee: number | string;
      preBalances: (number | string)[];
      postBalances: (number | string)[];
      preTokenBalances: TokenBalance[];
      postTokenBalances: TokenBalance[];
      innerInstructions: { index: number; instructions: InnerInstruction[] }[];
      loadedAddresses?: { writable: string[]; readonly: string[] };
    };
  };
};
const integer = (value: unknown) => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      return volumeReject('Unsafe receipt integer.');
    return BigInt(value);
  }
  return volumeUint(value);
};
/** Verifies an already signed packet. Never creates a signature or contacts a provider. */
export async function inspectVolumeSignedPacket(
  supplied: VolumeBundleConstruction,
  encoded: string,
) {
  const review = await requireVolumeBundleConstruction(supplied);
  if (typeof encoded !== 'string' || encoded.length > 1644)
    volumeReject('Bounded signed packet required.');
  const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const tx = getTransactionDecoder().decode(raw);
  const unsigned = getTransactionDecoder().decode(
    Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
  );
  const [sig] = Object.values(tx.signatures);
  if (
    raw.length > 1232 ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== encoded ||
    Object.keys(tx.signatures).join(',') !== review.wallet ||
    !sig ||
    !nacl.sign.detached.verify(
      Uint8Array.from(tx.messageBytes),
      Uint8Array.from(sig),
      bs58.decode(review.wallet),
    ) ||
    tx.messageBytes.length !== unsigned.messageBytes.length ||
    tx.messageBytes.some((b, i) => b !== unsigned.messageBytes[i])
  )
    return volumeReject('Signed packet differs from reserved construction.');
  return {
    signature: bs58.encode(sig),
    signedPacketSha256: await volumeBytesDigest(raw),
  };
}
/** Receipt accounting only. Caller must collect authenticated finalized RPC evidence; route/code/custody admission stays separate. */
export async function verifyVolumeBundleSettlement(
  supplied: VolumeBundleConstruction,
  suppliedReceipt: VolumeFinalizedReceipt,
) {
  return verifySettlement(supplied, suppliedReceipt);
}
/** Captured native Pump policy: sells debit program-owned lamports directly. */
export async function verifyVolumePumpSettlement(
  supplied: VolumeBundleConstruction,
  suppliedRoute: VolumePumpRoute,
  receipt: VolumeFinalizedReceipt,
) {
  const route = await validateVolumePumpRoute(
    supplied,
    suppliedRoute.identities,
  );
  if (JSON.stringify(route) !== JSON.stringify(suppliedRoute))
    volumeReject('Settlement route differs.');
  return verifySettlement(supplied, receipt, route);
}
async function verifySettlement(
  supplied: VolumeBundleConstruction,
  suppliedReceipt: VolumeFinalizedReceipt,
  pump?: VolumePumpRoute,
) {
  const review = await requireVolumeBundleConstruction(supplied),
    receipt = structuredClone(suppliedReceipt);
  const result = receipt?.result,
    meta = result?.meta;
  if (
    receipt?.commitment !== 'finalized' ||
    !result ||
    !Number.isSafeInteger(result.slot) ||
    result.slot < 1 ||
    !meta ||
    (!pump && meta.err !== null) ||
    meta.err === undefined ||
    !Array.isArray(result.transaction) ||
    result.transaction.length !== 2 ||
    result.transaction[1] !== 'base64' ||
    typeof result.transaction[0] !== 'string' ||
    result.transaction[0].length > 1644
  )
    volumeReject(
      'A complete finalized receipt is required. Unknown evidence retains its hold.',
    );
  const packet = await inspectVolumeSignedPacket(review, result.transaction[0]);
  if (packet.signature !== receipt.signature)
    volumeReject('Finalized wallet signature differs.');
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(result.transaction[0]), (c) => c.charCodeAt(0)),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    ),
    keys = message.staticAccounts.map(String);
  if (
    (meta.loadedAddresses?.writable?.length ?? 0) ||
    (meta.loadedAddresses?.readonly?.length ?? 0) ||
    message.version !== 0 ||
    (message.addressTableLookups?.length ?? 0)
  )
    return volumeReject('Lookup settlement is unsupported.');
  const tokenIndex = keys.indexOf(review.input.tokenAccount),
    tipIndex = keys.indexOf(review.input.tipRecipient);
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== keys.length ||
    meta.postBalances.length !== keys.length ||
    tokenIndex < 1 ||
    tipIndex < 1
  )
    volumeReject('Complete balance vectors required.');
  const before = meta.preBalances.map(integer),
    after = meta.postBalances.map(integer),
    fee = integer(meta.fee);
  if (
    after.reduce((sum, n) => sum + n, 0n) -
      before.reduce((sum, n) => sum + n, 0n) !==
      -fee ||
    keys.some(
      (_, i) =>
        i >= keys.length - message.header.numReadonlyNonSignerAccounts &&
        before[i] !== after[i],
    )
  )
    volumeReject('Native conservation or readonly balances differ.');
  if (
    fee > BigInt(review.input.networkFeeCapLamports) ||
    after[tipIndex] - before[tipIndex] !==
      (meta.err === null ? BigInt(review.input.tipLamports) : 0n) ||
    before[tokenIndex] !== after[tokenIndex]
  )
    volumeReject('Fee, tip or token-account rent changed.');
  const tokens = (rows: TokenBalance[]) => {
    if (!Array.isArray(rows) || rows.length > keys.length)
      return volumeReject('Complete token metadata required.');
    const map = new Map<number, TokenBalance>();
    for (const row of rows) {
      if (
        !row ||
        !Number.isSafeInteger(row.accountIndex) ||
        !keys[row.accountIndex] ||
        map.has(row.accountIndex) ||
        typeof row.owner !== 'string' ||
        typeof row.mint !== 'string' ||
        typeof row.programId !== 'string' ||
        !Number.isSafeInteger(row.uiTokenAmount?.decimals) ||
        row.uiTokenAmount.decimals < 0 ||
        row.uiTokenAmount.decimals > 18
      )
        volumeReject('Token identity metadata differs.');
      volumeUint(row.uiTokenAmount.amount);
      map.set(row.accountIndex, row);
    }
    return map;
  };
  const pre = tokens(meta.preTokenBalances),
    post = tokens(meta.postTokenBalances);
  const own = new Set<number>();
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(index),
      b = post.get(index);
    if (a?.owner !== review.wallet && b?.owner !== review.wallet) continue;
    own.add(index);
    if (
      !a ||
      !b ||
      a.owner !== b.owner ||
      a.mint !== b.mint ||
      a.programId !== b.programId ||
      a.uiTokenAmount.decimals !== b.uiTokenAmount.decimals ||
      a.uiTokenAmount.amount !== b.uiTokenAmount.amount ||
      before[index] !== after[index]
    )
      volumeReject('Existing wallet token inventory or custody changed.');
  }
  const target =
    pre.get(tokenIndex) ?? volumeReject('Target token metadata required.');
  if (
    !own.has(tokenIndex) ||
    target?.programId !== VOLUME_TOKEN ||
    target.mint !== review.input.mint ||
    (meta.err === null && target.uiTokenAmount.amount !== '0')
  )
    volumeReject('Use an existing empty standard SPL token account.');
  if (pump) {
    const curveIndex = keys.indexOf(pump.accounts.associated_bonding_curve),
      curve = pre.get(curveIndex),
      curvePost = post.get(curveIndex);
    if (
      pre.size !== 2 ||
      post.size !== 2 ||
      !curve ||
      !curvePost ||
      curve.owner !== pump.accounts.bonding_curve ||
      curve.mint !== review.input.mint ||
      curve.programId !== VOLUME_TOKEN ||
      curve.uiTokenAmount.decimals !== 6 ||
      target.uiTokenAmount.decimals !== 6 ||
      curvePost.owner !== curve.owner ||
      curvePost.mint !== curve.mint ||
      curvePost.programId !== curve.programId ||
      curvePost.uiTokenAmount.decimals !== curve.uiTokenAmount.decimals ||
      curvePost.uiTokenAmount.amount !== curve.uiTokenAmount.amount ||
      (meta.err === null &&
        integer(curve.uiTokenAmount.amount) <
          BigInt(review.input.tokenAmountRaw))
    )
      volumeReject('Complete unchanged Pump token inventories required.');
    if (meta.err !== null) {
      const error = withdrawalFailureReason(meta.err);
      if (
        (error.instructionIndex !== undefined &&
          error.instructionIndex >= message.instructions.length) ||
        after[0] - before[0] !== -fee ||
        before.some((value, i) => i > 0 && after[i] !== value)
      )
        volumeReject(
          'Finalized failure must roll back all balances except the payer fee.',
        );
      return {
        format: 'volume-bundle-settlement-v1' as const,
        outcome: 'failed' as const,
        constructionSha256: review.sha256,
        signature: receipt.signature,
        slot: result.slot,
        signedPacketSha256: packet.signedPacketSha256,
        buyLamports: '0',
        sellLamports: '0',
        actualVolumeLamports: '0',
        feeLamports: fee.toString(),
        tipLamports: '0',
        netLamports: (-fee).toString(),
        tokenInventoryDeltaRaw: '0',
        accountingVerified: true as const,
        executionAllowed: false as const,
        signingAllowed: false as const,
        durableTransitionRequired: true as const,
        routeAndCustodyAdmissionRequired: true as const,
        routeSha256: pump.sha256,
        pumpAccountingVerified: true as const,
        atomicRollbackVerified: true as const,
        error,
      };
    }
  }
  let buyTokens = 0n,
    sellTokens = 0n,
    buySol = 0n,
    sellSol = 0n;
  let buyTransfers = 0,
    sellTransfers = 0;
  const groups = new Set<number>(),
    end = review.buyInstructionCount + review.sellInstructionCount;
  if (
    !Array.isArray(meta.innerInstructions) ||
    meta.innerInstructions.length > end
  )
    volumeReject('Inner transfer evidence required.');
  for (const group of pump ? [] : meta.innerInstructions) {
    if (
      !Number.isSafeInteger(group.index) ||
      group.index < 0 ||
      group.index >= end ||
      groups.has(group.index) ||
      !Array.isArray(group.instructions) ||
      group.instructions.length > 128
    )
      volumeReject('Inner instruction attribution differs.');
    groups.add(group.index);
    const buy = group.index < review.buyInstructionCount;
    for (const ix of group.instructions) {
      if (
        !Number.isSafeInteger(ix.programIdIndex) ||
        !keys[ix.programIdIndex] ||
        !Array.isArray(ix.accounts) ||
        ix.accounts.length > 64 ||
        ix.accounts.some((i) => !Number.isSafeInteger(i) || !keys[i]) ||
        typeof ix.data !== 'string' ||
        ix.data.length > 2048
      )
        volumeReject('Incomplete raw inner instruction.');
      const program = keys[ix.programIdIndex];
      if (
        program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
        ix.accounts.some((i) => i === 0 || own.has(i))
      )
        volumeReject('Token-2022 wallet effects require a separate policy.');
      if (ix.accounts.includes(tipIndex))
        volumeReject('Tip recipient was touched by the route.');
      if (program !== VOLUME_TOKEN && program !== VOLUME_SYSTEM) continue;
      const data = bs58.decode(ix.data),
        view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (program === VOLUME_SYSTEM && ix.accounts.includes(0)) {
        if (
          data.length !== 12 ||
          view.getUint32(0, true) !== 2 ||
          ix.accounts.length !== 2
        )
          volumeReject('Unexpected native wallet instruction.');
        const amount = view.getBigUint64(4, true);
        if (buy && ix.accounts[0] === 0 && ix.accounts[1] !== 0)
          buySol += amount;
        else if (!buy && ix.accounts[1] === 0 && ix.accounts[0] !== 0)
          sellSol += amount;
        else volumeReject('Native movement belongs to the wrong leg.');
      }
      if (program !== VOLUME_TOKEN || !ix.accounts.some((i) => own.has(i)))
        continue;
      const checked =
        data[0] === 12 && data.length === 10 && ix.accounts.length === 4;
      if (
        !checked &&
        !(data[0] === 3 && data.length === 9 && ix.accounts.length === 3)
      )
        volumeReject('Unexpected wallet token instruction.');
      const source = ix.accounts[0],
        destination = ix.accounts[checked ? 2 : 1],
        authority = ix.accounts[checked ? 3 : 2];
      if (
        checked &&
        (keys[ix.accounts[1]] !== review.input.mint ||
          data[9] !== target.uiTokenAmount.decimals)
      )
        volumeReject('Transfer mint or decimals differs.');
      const amount = view.getBigUint64(1, true);
      if (
        buy &&
        destination === tokenIndex &&
        !own.has(source) &&
        authority !== 0
      ) {
        buyTokens += amount;
        buyTransfers++;
      } else if (
        !buy &&
        source === tokenIndex &&
        !own.has(destination) &&
        authority === 0
      ) {
        sellTokens += amount;
        sellTransfers++;
      } else
        volumeReject(
          'Transfer spends existing inventory or belongs to the wrong leg.',
        );
    }
  }
  const targetRaw = BigInt(review.input.tokenAmountRaw),
    tip = BigInt(review.input.tipLamports);
  const net = after[0] - before[0],
    loss = -net;
  if (pump) {
    buySol = reviewVolumePumpInner(
      review,
      pump,
      keys,
      meta.innerInstructions,
    ).buyLamports;
    sellSol = net + buySol + tip + fee;
    buyTokens = sellTokens = targetRaw;
    buyTransfers = sellTransfers = 1;
    const allowed = new Set([
      review.wallet,
      review.input.tipRecipient,
      pump.accounts.bonding_curve,
      pump.accounts.creator_vault,
      pump.accounts.fee_recipient,
    ]);
    if (keys.some((key, i) => !allowed.has(key) && before[i] !== after[i]))
      volumeReject('Unexpected Pump native movement.');
  }
  if (
    buyTransfers !== 1 ||
    sellTransfers !== 1 ||
    buyTokens !== targetRaw ||
    sellTokens !== targetRaw ||
    buySol <= 0n ||
    buySol > BigInt(review.input.plan.rounds[review.input.round].buyLamports) ||
    sellSol < BigInt(review.input.minimumSellLamports) ||
    net !== sellSol - buySol - tip - fee ||
    loss > BigInt(review.input.maximumLossLamports)
  )
    volumeReject(
      'Round output, native spending, proceeds or loss limit differs.',
    );
  return {
    format: 'volume-bundle-settlement-v1' as const,
    outcome: 'succeeded' as const,
    constructionSha256: review.sha256,
    signature: receipt.signature,
    slot: result.slot,
    signedPacketSha256: packet.signedPacketSha256,
    buyLamports: buySol.toString(),
    sellLamports: sellSol.toString(),
    actualVolumeLamports: (buySol + sellSol).toString(),
    feeLamports: fee.toString(),
    tipLamports: tip.toString(),
    netLamports: net.toString(),
    tokenInventoryDeltaRaw: '0',
    accountingVerified: true as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    durableTransitionRequired: true as const,
    routeAndCustodyAdmissionRequired: true as const,
    ...(pump
      ? { routeSha256: pump.sha256, pumpAccountingVerified: true as const }
      : {}),
  };
}
