import schema from './pump-quote-route-schema.json';
import type { TrackedTransaction } from './tracked-wallet-transaction';
import type { WalletMovementClassification } from './wallet-movement-classification';
import { movementInvocation } from './movement-invocation';
import { movementAssociatedSetup } from './movement-associated-setup';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const uint = (value: string | undefined) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid amount.');
  return BigInt(value);
};
const read64 = (hex: string) =>
  BigInt(`0x${hex.match(/../g)!.reverse().join('')}`);
export function classifyPumpQuoteMovement(
  tx: TrackedTransaction,
  mint: string,
): WalletMovementClassification | null {
  const facts = tx.movementInstructions ?? [];
  const candidates = facts.filter(
    (i) =>
      i.program === schema.program &&
      (i.dataHex?.startsWith(schema.discriminator) ||
        i.dataHex?.startsWith(schema.buy.discriminator) ||
        i.dataHex?.startsWith(schema.exactQuote.discriminator)),
  );
  if (!candidates.length) return null;
  try {
    if (
      candidates.length !== 1 ||
      tx.failed ||
      !tx.walletSigner ||
      !tx.tokensComplete ||
      !tx.innerInstructionsAvailable
    )
      throw new Error();
    const route = candidates[0],
      a = route.accounts;
    const exactQuote = route.dataHex!.startsWith(
      schema.exactQuote.discriminator,
    );
    const buying =
      exactQuote || route.dataHex!.startsWith(schema.buy.discriminator);
    const layout = exactQuote
      ? schema.exactQuote
      : buying
        ? schema.buy
        : schema;
    if (
      !a ||
      a.length !== layout.accounts.length ||
      !route.dataHex ||
      !(
        exactQuote
          ? /^[0-9a-f]{48}00$/
          : buying
            ? /^[0-9a-f]{48}(00)?$/
            : /^[0-9a-f]{48}$/
      ).test(route.dataHex)
    )
      throw new Error();
    const account = (name: string) => a[layout.accounts.indexOf(name)];
    for (const [name, address] of Object.entries(layout.fixedAccounts))
      if (account(name) !== address) throw new Error();
    const base = tx.tokenChanges.filter((t) => t.mint === mint);
    const quote = tx.tokenChanges.filter(
      (t) => t.mint === account('quote_mint'),
    );
    const amount = read64(route.dataHex.slice(16, 32)),
      limit = read64(route.dataHex.slice(32, 48));
    const baseAmount =
      exactQuote && base.length === 1 ? BigInt(base[0].changeRaw) : amount;
    if (
      account('base_mint') !== mint ||
      account('quote_mint') === mint ||
      account('user') !== tx.address ||
      base.length !== 1 ||
      quote.length !== 1 ||
      amount === 0n ||
      base[0].changeRaw !== (buying ? baseAmount : -amount).toString() ||
      (exactQuote &&
        (baseAmount <= 0n ||
          baseAmount > (1n << 64n) - 1n ||
          baseAmount < limit)) ||
      !base[0].accounts.includes(account('associated_base_user')) ||
      !quote[0].accounts.includes(account('associated_quote_user')) ||
      base[0].program !== account('base_token_program') ||
      quote[0].program !== account('quote_token_program') ||
      ![TOKEN, TOKEN2022].includes(base[0].program) ||
      ![TOKEN, TOKEN2022].includes(quote[0].program)
    )
      throw new Error();
    const invocation = movementInvocation(facts, route);
    if (
      !route.topLevel &&
      (!invocation.root.accounts ||
        a.some((address) => !invocation.root.accounts!.includes(address)))
    )
      throw new Error();
    const setupFacts = new Set<typeof route>();
    const quoteRoles = [
      ['associated_quote_user', 'user'],
      ['associated_quote_bonding_curve', 'bonding_curve'],
      ['associated_quote_fee_recipient', 'fee_recipient'],
      ['associated_quote_buyback_fee_recipient', 'buyback_fee_recipient'],
      ['associated_creator_vault', 'creator_vault'],
      ['associated_user_volume_accumulator', 'user_volume_accumulator'],
    ];
    for (const create of invocation.descendants.filter(
      (i) => i.program === ATA,
    )) {
      const role = quoteRoles.find(
        ([token]) => account(token) === create.info?.account,
      );
      if (!role) throw new Error();
      for (const fact of movementAssociatedSetup(facts, create, {
        account: account(role[0]),
        owner: account(role[1]),
        mint: account('quote_mint'),
        tokenProgram: account('quote_token_program'),
        payer: tx.address,
      }))
        setupFacts.add(fact);
    }
    const branch = invocation.descendants.filter((i) => !setupFacts.has(i));
    const tokenLegs = branch.filter((i) =>
      [TOKEN, TOKEN2022].includes(i.program),
    );
    if (
      branch.some(
        (i) =>
          ![TOKEN, TOKEN2022, account('fee_program'), schema.program].includes(
            i.program,
          ),
      ) ||
      branch.some(
        (i) =>
          i.program === schema.program &&
          (!i.dataHex?.startsWith('e445a52e51cb9a1d') ||
            i.accounts?.length !== 1 ||
            i.accounts[0] !== account('event_authority')),
      ) ||
      tokenLegs.some((i) => i.type !== 'transferChecked' || !i.info)
    )
      throw new Error();
    const baseAccount = account('associated_base_user'),
      quoteAccount = account('associated_quote_user');
    if (
      new Set([
        baseAccount,
        quoteAccount,
        account('associated_base_bonding_curve'),
        account('associated_quote_bonding_curve'),
      ]).size !== 4
    )
      throw new Error();
    const baseLegs = tokenLegs.filter((i) => i.info?.mint === mint);
    if (baseLegs.length !== 1) throw new Error();
    const leg = baseLegs[0];
    if (
      leg.program !== base[0].program ||
      leg.info!.source !==
        (buying ? account('associated_base_bonding_curve') : baseAccount) ||
      leg.info!.destination !==
        (buying ? baseAccount : account('associated_base_bonding_curve')) ||
      leg.info!.authority !==
        (buying ? account('bonding_curve') : tx.address) ||
      uint(leg.info!.amount) !== baseAmount ||
      leg.info!.decimals !== String(base[0].decimals)
    )
      throw new Error();
    // Other operations on this wallet's base accounts invalidate attribution.
    const baseSetup = new Set<typeof route>();
    if (buying && base[0].beforeRaw === '0')
      for (const create of facts.filter(
        (i) => i.program === ATA && i.info?.account === baseAccount,
      ))
        for (const fact of movementAssociatedSetup(facts, create, {
          account: baseAccount,
          mint,
          owner: tx.address,
          tokenProgram: base[0].program,
          payer: tx.address,
        }))
          baseSetup.add(fact);
    for (const fact of facts.filter((i) =>
      [TOKEN, TOKEN2022].includes(i.program),
    )) {
      const touches = base[0].accounts.some(
        (address) =>
          fact.accounts?.includes(address) ||
          [
            fact.info?.source,
            fact.info?.destination,
            fact.info?.account,
          ].includes(address),
      );
      if (touches && fact !== leg && !baseSetup.has(fact)) throw new Error();
    }
    const quoteLegs = tokenLegs.filter(
      (i) => i.info?.mint === account('quote_mint'),
    );
    const recipients = [
      buying ? account('associated_quote_bonding_curve') : quoteAccount,
      account('associated_quote_fee_recipient'),
      account('associated_quote_buyback_fee_recipient'),
      account('associated_creator_vault'),
      account('associated_user_volume_accumulator'),
    ];
    if (
      tokenLegs.length !== baseLegs.length + quoteLegs.length ||
      quoteLegs.some(
        (i) =>
          i.program !== quote[0].program ||
          i.info!.source !==
            (buying
              ? quoteAccount
              : account('associated_quote_bonding_curve')) ||
          i.info!.authority !==
            (buying ? tx.address : account('bonding_curve')) ||
          !recipients.includes(i.info!.destination!) ||
          i.info!.decimals !== String(quote[0].decimals),
      )
    )
      throw new Error();
    quoteLegs.forEach((i) => uint(i.info!.amount));
    const proceeds = quoteLegs.filter(
      (i) =>
        i.info!.destination ===
        (buying ? account('associated_quote_bonding_curve') : quoteAccount),
    );
    if (
      proceeds.length !== 1 ||
      uint(proceeds[0].info!.amount) === 0n ||
      (!buying && uint(proceeds[0].info!.amount) < limit)
    )
      throw new Error();
    const quoteRaw = buying
      ? quoteLegs.reduce((sum, i) => sum + uint(i.info!.amount), 0n)
      : uint(proceeds[0].info!.amount);
    if (
      buying &&
      (quoteRaw === 0n ||
        quoteRaw > (exactQuote ? amount : limit) ||
        quoteRaw > (1n << 64n) - 1n)
    )
      throw new Error();
    return {
      kind: buying ? 'buy' : 'sell',
      basis: 'pump-quote-and-token-transfers',
      protocol: 'Pump.fun',
      reason: `Executed Pump.fun ${layout.name} and its base/quote transfer legs match the wallet token change. The quoted transfer is venue-level evidence; final wallet ${buying ? 'cost' : 'proceeds'} and other route legs are unverified.`,
      quote: {
        mint: account('quote_mint'),
        raw: quoteRaw.toString(),
        decimals: quote[0].decimals,
        scope: 'venue-transfer',
      },
      counterpartyAccounts: [
        account('associated_base_bonding_curve'),
        account('associated_quote_bonding_curve'),
      ],
    };
  } catch {
    return {
      kind: 'unknown',
      basis: 'unresolved',
      reason:
        'Pump.fun quote trade ancestry, account roles or exact transfer evidence is incomplete or contradictory.',
      counterpartyAccounts: [],
    };
  }
}
