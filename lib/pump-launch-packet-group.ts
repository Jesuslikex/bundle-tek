import {
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageConfig,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
  type Instruction,
} from '@solana/kit-v1';
import {
  collectPumpHolderInstructionUnits,
  type PumpHolderMessageInput,
} from './pump-holder-message';

const limits = {
  computeUnitLimit: 1400000,
  loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
  priorityFeeLamports: 0n,
};
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    ),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
type Unit = Awaited<
  ReturnType<typeof collectPumpHolderInstructionUnits>
>['units'][number];

/** Offline unsigned assembly. No transport, funding/simulation attestation or signing authority. */
export async function buildPumpLaunchPacketGroup(
  supplied: PumpHolderMessageInput,
  signal?: AbortSignal,
) {
  const current = () => {
    if (signal?.aborted)
      throw new Error('Launch group construction cancelled.');
  };
  current();
  const { input, created, units, buyers } =
    await collectPumpHolderInstructionUnits(supplied, signal);
  current();
  function compile(selected: Unit[]) {
    const instructions: Instruction[] = selected.flatMap(
      (unit) => unit.instructions,
    );
    const holderIndices = selected.flatMap((u) =>
      u.holderIndex === null ? [] : [u.holderIndex],
    );
    const containsCreation = selected[0].holderIndex === null;
    const required = [
      input.create.payer,
      ...(containsCreation ? [input.create.mint] : []),
      ...holderIndices.map((i) => input.holders[i].address),
    ];
    // The pinned v1 compiler also bounds signers and instructions; bytes/accounts alone are insufficient.
    if (required.length > 12 || instructions.length > 64) return null;
    const accounts = new Set([
      input.create.payer,
      ...instructions.flatMap((i) => [
        String(i.programAddress),
        ...(i.accounts ?? []).map((a) => String(a.address)),
      ]),
    ]);
    if (accounts.size > 64) return null;
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageConfig(
        limits,
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(input.create.blockhash),
            lastValidBlockHeight: input.create.lastValidBlockHeight,
          },
          setTransactionMessageFeePayer(
            address(input.create.payer),
            createTransactionMessage({ version: 1 }),
          ),
        ),
      ),
    );
    const compiled = compileTransactionMessage(message),
      signers = compiled.staticAccounts
        .slice(0, compiled.header.numSignerAccounts)
        .map(String);
    if (
      signers.length !== required.length ||
      signers[0] !== input.create.payer ||
      required.some((key) => !signers.includes(key))
    )
      throw new Error('Launch group packet signer set differs.');
    const tx = compileTransaction(message),
      bytes = Uint8Array.from(getTransactionEncoder().encode(tx));
    if (bytes.length > 4096) return null;
    if (Object.values(tx.signatures).some((value) => value !== null))
      throw new Error('Launch group must remain unsigned.');
    return {
      bytes,
      instructions,
      holderIndices,
      requiredSigners: signers,
      containsCreation,
      containsDeveloperBuy: containsCreation && !!input.developer,
      accountCount: accounts.size,
    };
  }
  const compiledPackets: NonNullable<ReturnType<typeof compile>>[] = [];
  let selected: Unit[] = [];
  let accepted: ReturnType<typeof compile> = null;
  for (const unit of units) {
    current();
    const candidate = compile([...selected, unit]);
    if (candidate) {
      selected.push(unit);
      accepted = candidate;
      continue;
    }
    if (!accepted)
      throw new Error(
        'One indivisible launch operation exceeds packet limits. No group was returned.',
      );
    compiledPackets.push(accepted);
    selected = [unit];
    accepted = compile(selected);
    if (!accepted)
      throw new Error(
        'One indivisible holder operation exceeds packet limits. No group was returned.',
      );
  }
  if (accepted) compiledPackets.push(accepted);
  if (
    !compiledPackets.length ||
    compiledPackets.length > 201 ||
    !compiledPackets[0].containsCreation ||
    compiledPackets.slice(1).some((p) => p.containsCreation)
  )
    throw new Error('Launch group creation/order differs.');
  const activeIndices = input.holders.flatMap((h, i) =>
    h.kind === 'none' ? [] : [i],
  );
  if (
    JSON.stringify(compiledPackets.flatMap((p) => p.holderIndices)) !==
    JSON.stringify(activeIndices)
  )
    throw new Error('Complete holder coverage differs.');
  async function encodePacket(
    index: number,
    p: NonNullable<ReturnType<typeof compile>>,
  ) {
    current();
    const packetSha256 = await hash(p.bytes);
    current();
    return {
      index,
      transactionVersion: 1 as const,
      feePayer: input.create.payer,
      containsCreation: p.containsCreation,
      containsDeveloperBuy: p.containsDeveloperBuy,
      holderIndices: p.holderIndices,
      requiredSigners: p.requiredSigners,
      packetBytes: p.bytes.length,
      packetLimit: 4096 as const,
      accountCount: p.accountCount,
      accountLimit: 64 as const,
      signerLimit: 12 as const,
      instructionLimit: 64 as const,
      resourceLimits: { ...limits, priorityFeeLamports: '0' },
      transaction: getBase64Decoder().decode(p.bytes),
      packetSha256,
      instructions: p.instructions,
      buyerAccounts: buyers
        .filter(
          (b) =>
            p.holderIndices.some((i) => input.holders[i].address === b.payer) ||
            (p.containsDeveloperBuy && b.payer === input.create.payer),
        )
        .map((b) => ({
          payer: b.payer,
          userBaseAccount: b.userBaseAccount,
          userQuoteAccount: b.userQuoteAccount,
          volumeAccount: b.volumeAccount,
          buybackRecipient: b.buybackRecipient,
          buybackAccount: b.buybackAccount,
        })),
    };
  }
  const packets: Awaited<ReturnType<typeof encodePacket>>[] = [];
  for (const [index, p] of compiledPackets.entries())
    packets.push(await encodePacket(index, p));
  const slots = input.holders.map((holder, index) => ({
    index,
    address: holder.address,
    kind: holder.kind,
    tokenAmountRaw:
      holder.kind === 'exact-base-output' ? holder.tokenAmountRaw : null,
    maximumQuoteCostRaw:
      holder.kind === 'exact-base-output' ? holder.maximumQuoteCostRaw : null,
    quoteAmountRaw:
      holder.kind === 'exact-quote-input' ? holder.quoteAmountRaw : null,
    minimumTokenOutputRaw:
      holder.kind === 'exact-quote-input' ? holder.minimumTokenOutputRaw : null,
    packetIndex:
      holder.kind === 'none'
        ? null
        : packets.find((p) => p.holderIndices.includes(index))!.index,
  }));
  const encodeAccount = (
    account: PumpHolderMessageInput['create']['global'],
  ) => ({
    address: account.address,
    owner: account.owner,
    executable: account.executable,
    slot: account.slot,
    data: getBase64Decoder().decode(account.data),
  });
  const creationInput = {
    name: input.create.name,
    symbol: input.create.symbol,
    uri: input.create.uri,
    payer: input.create.payer,
    mint: input.create.mint,
    quoteMint: input.create.quoteMint,
    blockhash: input.create.blockhash,
    lastValidBlockHeight: input.create.lastValidBlockHeight.toString(),
    global: encodeAccount(input.create.global),
    ...(input.create.quoteMintAccount
      ? { quoteMintAccount: encodeAccount(input.create.quoteMintAccount) }
      : {}),
    ...(input.create.quoteControl
      ? { quoteControl: encodeAccount(input.create.quoteControl) }
      : {}),
  };
  const manifest = {
    format: 'pump-launch-packet-group-plan-v1' as const,
    payer: input.create.payer,
    mint: input.create.mint,
    quoteMint: input.create.quoteMint,
    blockhash: input.create.blockhash,
    lastValidBlockHeight: input.create.lastValidBlockHeight.toString(),
    creationInput,
    developer: input.developer
      ? {
          tokenAmountRaw: input.developer.tokenAmountRaw,
          maximumQuoteCostRaw: input.developer.maximumQuoteCostRaw,
        }
      : null,
    slots,
    packetHashes: packets.map((p) => p.packetSha256),
  };
  const manifestSha256 = await hash(
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  current();
  return {
    format: manifest.format,
    manifest,
    manifestSha256,
    packets,
    quote: created.quote,
    executionAllowed: false as const,
    signingAllowed: false as const,
    completeLaunch: false as const,
    fundingReviewRequired: true as const,
    sequentialSimulationRequired: true as const,
    transportReviewRequired: true as const,
    atomicity: 'not-established' as const,
    jitoTransactionCountFit: packets.length <= 5,
    tipIncluded: false as const,
    activeHolderCount: activeIndices.length,
    zeroHolderCount: slots.length - activeIndices.length,
  };
}
