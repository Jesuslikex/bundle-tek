import schema from './pump-native-route-schema.json';
import type { TrackedTransaction } from './tracked-wallet-transaction';
import type { WalletMovementClassification } from './wallet-movement-classification';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const FEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const WSOL = 'So11111111111111111111111111111111111111112';
const unknown = (reason: string): WalletMovementClassification => ({
  kind: 'unknown',
  basis: 'unresolved',
  reason,
  counterpartyAccounts: [],
});
const uint = (raw: string | undefined) => {
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(raw) ||
    BigInt(raw) > (1n << 64n) - 1n
  )
    throw new Error();
  return BigInt(raw);
};
export function classifyNativePumpMovement(
  tx: TrackedTransaction,
  mint: string,
): WalletMovementClassification | null {
  const facts = tx.movementInstructions ?? [];
  const routes = facts.filter(
    (i) => i.topLevel && i.program === schema.program,
  );
  if (!routes.length) return null;
  try {
    if (
      routes.length !== 1 ||
      !tx.walletSigner ||
      tx.failed ||
      !tx.tokensComplete ||
      !tx.innerInstructionsAvailable
    )
      return unknown(
        'Native Pump.fun needs one successful wallet-authorized instruction.',
      );
    const known = new Set([
      SYSTEM,
      TOKEN,
      TOKEN2022,
      ATA,
      COMPUTE,
      FEE,
      schema.program,
    ]);
    if (
      facts.some((i) => !known.has(i.program)) ||
      facts.some(
        (i) =>
          i.topLevel &&
          ![SYSTEM, TOKEN, TOKEN2022, ATA, COMPUTE, schema.program].includes(
            i.program,
          ),
      )
    )
      return unknown(
        'Additional unsupported instructions prevent native Pump.fun attribution.',
      );
    const route = routes[0],
      hex = route.dataHex,
      accounts = route.accounts;
    const variant = schema.instructions.find((i) =>
      hex?.startsWith(i.discriminator),
    );
    if (
      !variant ||
      !accounts ||
      accounts.length !== variant.accounts.length ||
      !hex ||
      !/^(?:[a-f0-9]{2})+$/.test(hex) ||
      hex.length !== (variant.name === 'sell' ? 24 : 26) * 2
    )
      return unknown('Native Pump.fun layout is not decoded.');
    const a = (name: string) => accounts[variant.accounts.indexOf(name)];
    if (
      a('user') !== tx.address ||
      a('mint') !== mint ||
      a('system_program') !== SYSTEM ||
      a('program') !== schema.program ||
      a('fee_program') !== FEE ||
      ![TOKEN, TOKEN2022].includes(a('token_program'))
    )
      return unknown(
        'Native Pump.fun account roles differ from the wallet or mint.',
      );
    const curve = a('bonding_curve'),
      fee = a('fee_recipient'),
      creator = a('creator_vault'),
      userToken = a('associated_user'),
      curveToken = a('associated_bonding_curve');
    if (
      new Set([curve, fee, creator, tx.address, userToken, curveToken]).size !==
      6
    )
      return unknown('Native Pump.fun payment and token roles overlap.');
    const bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    const view = new DataView(bytes.buffer),
      first = view.getBigUint64(8, true),
      second = view.getBigUint64(16, true);
    if (!first || (variant.name !== 'sell' && (bytes[24] > 1 || bytes[25] > 1)))
      return unknown('Native Pump.fun arguments are invalid.');
    const target = tx.tokenChanges.filter((t) => t.mint === mint);
    if (
      target.length !== 1 ||
      !target[0].accounts.includes(userToken) ||
      target[0].program !== a('token_program') ||
      tx.tokenChanges.some((t) => t.mint !== mint && BigInt(t.changeRaw) !== 0n)
    )
      return unknown(
        'Native Pump.fun token ownership or changes are incomplete.',
      );
    const delta = BigInt(target[0].changeRaw),
      sell = variant.name === 'sell';
    if (sell ? delta >= 0n : delta <= 0n)
      return unknown('Native Pump.fun token direction differs.');
    const tokenLegs = facts.filter(
      (i) =>
        [TOKEN, TOKEN2022].includes(i.program) &&
        ['transfer', 'transferChecked'].includes(i.type ?? ''),
    );
    let tokenNet = 0n;
    for (const leg of tokenLegs) {
      const info = leg.info;
      if (
        !info ||
        (info.mint &&
          info.mint !== mint &&
          (info.source === userToken || info.destination === userToken))
      )
        throw new Error();
      if (info.source === userToken || info.destination === userToken) {
        if (
          leg.program !== a('token_program') ||
          (sell
            ? info.source !== userToken || info.destination !== curveToken
            : info.destination !== userToken || info.source !== curveToken)
        )
          return unknown(
            'Native Pump.fun token transfers cross unexpected accounts.',
          );
        tokenNet += (sell ? -1n : 1n) * uint(info.amount);
      }
    }
    if (tokenNet !== delta)
      return unknown('Native Pump.fun token transfers do not reconcile.');
    let nativeRaw = 0n;
    if (!sell) {
      const payments = facts.filter(
        (i) =>
          i.program === SYSTEM &&
          i.type === 'transfer' &&
          (i.info?.source === tx.address || i.info?.destination === tx.address),
      );
      let curvePayment = 0n;
      const paid = new Map<string, bigint>();
      for (const payment of payments) {
        if (
          payment.topLevel ||
          payment.info?.source !== tx.address ||
          ![curve, fee, creator].includes(payment.info.destination!)
        )
          return unknown(
            'Additional native payments prevent Pump.fun buy attribution.',
          );
        const raw = uint(payment.info.lamports);
        nativeRaw += raw;
        paid.set(
          payment.info.destination!,
          (paid.get(payment.info.destination!) ?? 0n) + raw,
        );
        if (payment.info.destination === curve) curvePayment += raw;
      }
      const tokens = delta;
      if (
        !tx.nativeAccountChanges ||
        [curve, fee, creator].some((account) => {
          const changes = tx.nativeAccountChanges!.filter(
            (b) => b.address === account,
          );
          return (
            changes.length !== 1 ||
            uint(changes[0].afterRaw) - uint(changes[0].beforeRaw) !==
              (paid.get(account) ?? 0n)
          );
        })
      )
        return unknown(
          'Native Pump.fun buy payment-account balances do not reconcile.',
        );
      const partial = bytes[25] === 1;
      if (
        !curvePayment ||
        !nativeRaw ||
        (variant.name === 'buy'
          ? nativeRaw > second || (partial ? tokens > first : tokens !== first)
          : nativeRaw > first || tokens < second)
      )
        return unknown(
          'Native Pump.fun buy payments do not satisfy its instruction bounds.',
        );
    } else {
      if (
        -delta !== first ||
        !tx.nativeAccountChanges ||
        facts.some(
          (i) =>
            i.program === ATA ||
            (i.program === SYSTEM && i.type !== 'transfer') ||
            ([TOKEN, TOKEN2022].includes(i.program) &&
              !['transfer', 'transferChecked'].includes(i.type ?? '')),
        )
      )
        return unknown(
          'Native Pump.fun sell includes unresolved rent or token-account operations.',
        );
      const balances = new Map<string, bigint>();
      for (const b of tx.nativeAccountChanges) {
        const change = uint(b.afterRaw) - uint(b.beforeRaw);
        if (balances.has(b.address) || change.toString() !== b.changeRaw)
          throw new Error();
        balances.set(b.address, change);
      }
      const walletChange = balances.get(tx.address),
        curveChange = balances.get(curve),
        feeChange = balances.get(fee),
        creatorChange = balances.get(creator);
      if (
        walletChange === undefined ||
        curveChange === undefined ||
        feeChange === undefined ||
        creatorChange === undefined ||
        tx.nativeChangeRaw !== walletChange.toString()
      )
        throw new Error();
      const networkFee = uint(tx.feeRaw);
      if ([curve, fee, creator].includes(tx.feePayer)) throw new Error();
      nativeRaw = walletChange + (tx.feePayer === tx.address ? networkFee : 0n);
      const allowed = new Set([tx.address, curve, fee, creator, tx.feePayer]);
      if (
        !nativeRaw ||
        nativeRaw < second ||
        curveChange >= 0n ||
        feeChange < 0n ||
        creatorChange < 0n ||
        -curveChange !== nativeRaw + feeChange + creatorChange ||
        [...balances].some(
          ([account, change]) => !allowed.has(account) && change !== 0n,
        ) ||
        (tx.feePayer !== tx.address &&
          balances.get(tx.feePayer) !== -networkFee) ||
        facts.some((i) => i.program === SYSTEM && i.type === 'transfer')
      )
        return unknown(
          'Native Pump.fun sell SOL settlement does not reconcile uniquely.',
        );
    }
    return {
      kind: sell ? 'sell' : 'buy',
      basis: 'pump-native-and-token-transfers',
      protocol: 'Pump.fun',
      reason:
        'Decoded wallet-authorized native Pump.fun instruction, token transfers and SOL payment evidence reconcile.',
      counterpartyAccounts: [curveToken],
      quote: {
        mint: WSOL,
        raw: nativeRaw.toString(),
        decimals: 9,
        asset: 'native-sol',
      },
    };
  } catch {
    return unknown('Native Pump.fun evidence is malformed or incomplete.');
  }
}
