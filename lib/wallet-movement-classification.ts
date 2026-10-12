import type {
  TrackedTransaction,
  MovementInstruction,
} from './tracked-wallet-transaction';
import { decodeJupiterRoute } from './jupiter-route-assessment';
import { walletAddress } from './wallet-workspace';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const WSOL = 'So11111111111111111111111111111111111111112';
export type WalletMovementClassification = {
  kind: 'buy' | 'sell' | 'transfer' | 'unknown';
  basis: 'jupiter-route-and-transfers' | 'spl-token-transfer' | 'unresolved';
  reason: string;
  counterpartyAccounts: string[];
  quote?: { mint: string; raw: string; decimals: number };
};
const unknown = (reason: string): WalletMovementClassification => ({
  kind: 'unknown',
  basis: 'unresolved',
  reason,
  counterpartyAccounts: [],
});
export function requireMovementClassification(
  value: WalletMovementClassification | undefined,
  changeRaw: string,
) {
  if (value === undefined) return;
  if (
    !value ||
    !['buy', 'sell', 'transfer', 'unknown'].includes(value.kind) ||
    typeof value.reason !== 'string' ||
    !value.reason ||
    value.reason.length > 512 ||
    !Array.isArray(value.counterpartyAccounts) ||
    value.counterpartyAccounts.length > 64
  )
    throw new Error('Invalid movement classification.');
  value.counterpartyAccounts.forEach((account) =>
    walletAddress(account, 'Solana'),
  );
  if (
    value.kind === 'unknown'
      ? value.basis !== 'unresolved' || value.quote !== undefined
      : value.kind === 'transfer'
        ? value.basis !== 'spl-token-transfer' || value.quote !== undefined
        : value.basis !== 'jupiter-route-and-transfers' ||
          !value.quote ||
          (value.kind === 'buy'
            ? BigInt(changeRaw) <= 0n
            : BigInt(changeRaw) >= 0n)
  )
    throw new Error('Movement classification does not match its token change.');
  if (value.quote) {
    walletAddress(value.quote.mint, 'Solana');
    if (
      amount(value.quote.raw) === 0n ||
      !Number.isSafeInteger(value.quote.decimals) ||
      value.quote.decimals < 0 ||
      value.quote.decimals > 255
    )
      throw new Error('Invalid movement quote.');
  }
}
const amount = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error();
  return BigInt(value);
};
function transfers(instructions: MovementInstruction[]) {
  return instructions
    .filter(
      (i) =>
        [TOKEN, TOKEN2022].includes(i.program) &&
        ['transfer', 'transferChecked'].includes(i.type ?? ''),
    )
    .map((i) => {
      if (!i.info?.source || !i.info.destination) throw new Error();
      return {
        source: i.info.source,
        destination: i.info.destination,
        raw: amount(i.info.amount),
        mint: i.info.mint,
      };
    });
}
export function classifyWalletMovement(
  tx: TrackedTransaction,
  mint: string,
): WalletMovementClassification {
  try {
    if (
      tx.failed ||
      !tx.tokensComplete ||
      !tx.innerInstructionsAvailable ||
      !tx.movementInstructions
    )
      return unknown(
        'Complete successful transaction instructions are unavailable.',
      );
    const target = tx.tokenChanges.filter((change) => change.mint === mint);
    if (target.length !== 1 || BigInt(target[0].changeRaw) === 0n)
      return unknown('No unique nonzero wallet token change.');
    const changed = target[0],
      delta = BigInt(changed.changeRaw),
      facts = tx.movementInstructions;
    const legs = transfers(facts);
    const known = new Set([SYSTEM, TOKEN, TOKEN2022, ATA, COMPUTE]);
    const routes = facts.filter((i) => i.topLevel && i.program === JUPITER);
    if (routes.length) {
      if (
        routes.length !== 1 ||
        !tx.walletSigner ||
        facts.some(
          (i) => i.topLevel && !known.has(i.program) && i.program !== JUPITER,
        )
      )
        return unknown(
          'Multiple or unrecognized top-level operations prevent swap attribution.',
        );
      const route = routes[0],
        value = route.dataHex ? decodeJupiterRoute(route.dataHex) : null;
      if (!value || !route.accounts)
        return unknown('Jupiter route layout is not decoded.');
      const a = route.accounts;
      const authority =
        a[value.v2 ? (value.shared ? 1 : 0) : value.shared ? 2 : 1];
      const source =
        a[value.v2 ? (value.shared ? 2 : 1) : value.shared ? 3 : 2];
      const destination =
        a[value.v2 ? (value.shared ? 5 : 2) : value.shared ? 6 : 3];
      if (
        authority !== tx.address ||
        !source ||
        !destination ||
        source === destination
      )
        return unknown(
          'Swap authority or account boundaries differ from this wallet.',
        );
      const ownership = new Map<string, { mint: string; decimals: number }>();
      for (const change of tx.tokenChanges)
        for (const account of change.accounts ?? [])
          ownership.set(account, {
            mint: change.mint,
            decimals: change.decimals,
          });
      for (const instruction of facts) {
        const info = instruction.info;
        if (!info?.account || !info.mint) continue;
        if (
          (instruction.program === ATA &&
            ['create', 'createIdempotent'].includes(instruction.type ?? '') &&
            info.wallet === tx.address) ||
          ([TOKEN, TOKEN2022].includes(instruction.program) &&
            [
              'initializeAccount',
              'initializeAccount2',
              'initializeAccount3',
            ].includes(instruction.type ?? '') &&
            info.owner === tx.address)
        ) {
          if (info.mint === WSOL)
            ownership.set(info.account, { mint: WSOL, decimals: 9 });
        }
      }
      const input = ownership.get(source),
        output = ownership.get(destination);
      if (!input || !output || input.mint === output.mint)
        return unknown(
          'Swap source and destination ownership/mints are incomplete.',
        );
      const outgoing = legs.filter((t) => t.source === source),
        incoming = legs.filter((t) => t.destination === destination);
      if (
        outgoing.some((t) => t.mint && t.mint !== input.mint) ||
        incoming.some((t) => t.mint && t.mint !== output.mint)
      )
        return unknown('Decoded swap transfer mints disagree.');
      const inputRaw = outgoing.reduce((s, t) => s + t.raw, 0n),
        outputRaw = incoming.reduce((s, t) => s + t.raw, 0n);
      if (inputRaw !== BigInt(value.inAmountRaw) || !outputRaw)
        return unknown(
          'Swap transfers do not reconcile with the decoded route amount.',
        );
      const buy = output.mint === mint && delta === outputRaw;
      const sell = input.mint === mint && -delta === inputRaw;
      if (!buy && !sell)
        return unknown(
          'Wallet target change does not reconcile with swap transfer legs.',
        );
      const quote = buy ? input : output;
      const other = tx.tokenChanges.filter(
        (t) => t.mint !== mint && BigInt(t.changeRaw) !== 0n,
      );
      if (
        other.some((t) => t.mint !== quote.mint) ||
        other.length > 1 ||
        (other.length === 1 &&
          BigInt(other[0].changeRaw) !== (buy ? -inputRaw : outputRaw))
      )
        return unknown(
          'Additional wallet token movements prevent a unique swap classification.',
        );
      if (!other.length && quote.mint !== WSOL)
        return unknown('The opposite asset change is missing.');
      return {
        kind: buy ? 'buy' : 'sell',
        basis: 'jupiter-route-and-transfers',
        reason:
          'Decoded wallet-authorized Jupiter route and actual SPL transfer legs reconcile with the target change.',
        counterpartyAccounts: [
          ...new Set(
            buy
              ? incoming.map((t) => t.source)
              : outgoing.map((t) => t.destination),
          ),
        ],
        quote: {
          mint: quote.mint,
          decimals: quote.decimals,
          raw: (buy ? inputRaw : outputRaw).toString(),
        },
      };
    }
    if (
      facts.some((i) => i.topLevel && !known.has(i.program)) ||
      facts.some(
        (i) =>
          i.program === SYSTEM &&
          i.type === 'transfer' &&
          (i.info?.source === tx.address || i.info?.destination === tx.address),
      ) ||
      tx.tokenChanges.some((t) => t.mint !== mint && BigInt(t.changeRaw) !== 0n)
    )
      return unknown(
        'Unrecognized program or multiple asset changes require another protocol decoder.',
      );
    const accounts = new Set(changed.accounts);
    const matching = legs.filter(
      (t) =>
        (accounts.has(t.source) || accounts.has(t.destination)) &&
        (!t.mint || t.mint === mint),
    );
    const net = matching.reduce(
      (sum, t) =>
        sum +
        (accounts.has(t.destination) ? t.raw : 0n) -
        (accounts.has(t.source) ? t.raw : 0n),
      0n,
    );
    if (net !== delta || !matching.length)
      return unknown(
        'Parsed token transfers do not reconcile with the wallet change.',
      );
    return {
      kind: 'transfer',
      basis: 'spl-token-transfer',
      reason:
        'Parsed SPL transfers reconcile with this wallet token change; no supported swap operation is present.',
      counterpartyAccounts: [
        ...new Set(
          matching.flatMap((t) =>
            accounts.has(t.source) && !accounts.has(t.destination)
              ? [t.destination]
              : !accounts.has(t.source) && accounts.has(t.destination)
                ? [t.source]
                : [],
          ),
        ),
      ],
    };
  } catch {
    return unknown(
      'Instruction evidence is malformed or outside the supported decoder.',
    );
  }
}
