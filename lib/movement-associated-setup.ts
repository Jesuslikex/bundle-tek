import type { MovementInstruction } from './tracked-wallet-transaction';
import { movementInvocation } from './movement-invocation';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
export function movementAssociatedSetup(
  facts: MovementInstruction[],
  create: MovementInstruction,
  scope: {
    account: string;
    mint: string;
    owner: string;
    tokenProgram: string;
    payer: string;
  },
) {
  const info = create.info;
  if (
    create.program !== ATA ||
    !['create', 'createIdempotent'].includes(create.type ?? '') ||
    info?.account !== scope.account ||
    info.mint !== scope.mint ||
    info.wallet !== scope.owner ||
    info.source !== scope.payer
  )
    throw new Error('Associated account setup scope differs.');
  const invocation = movementInvocation(facts, create);
  for (const child of invocation.descendants) {
    if (movementInvocation(facts, child).parent !== create)
      throw new Error('Unknown account setup callback.');
    const i = child.info;
    if (child.program === SYSTEM && child.type === 'createAccount') {
      if (
        i?.newAccount !== scope.account ||
        i.owner !== scope.tokenProgram ||
        i.source !== scope.payer ||
        !i.lamports ||
        !/^(0|[1-9]\d{0,19})$/.test(i.lamports) ||
        BigInt(i.lamports) > (1n << 64n) - 1n
      )
        throw new Error('Account rent creation differs.');
    } else if (
      child.program === scope.tokenProgram &&
      child.type === 'getAccountDataSize'
    ) {
      if (i?.mint !== scope.mint) throw new Error('Account size mint differs.');
    } else if (
      child.program === scope.tokenProgram &&
      child.type === 'initializeImmutableOwner'
    ) {
      if (i?.account !== scope.account)
        throw new Error('Immutable account differs.');
    } else if (
      child.program === scope.tokenProgram &&
      child.type === 'initializeAccount3'
    ) {
      if (
        i?.account !== scope.account ||
        i.mint !== scope.mint ||
        i.owner !== scope.owner
      )
        throw new Error('Token account initialization differs.');
    } else throw new Error('Unsupported account setup operation.');
  }
  return new Set([create, ...invocation.descendants]);
}
