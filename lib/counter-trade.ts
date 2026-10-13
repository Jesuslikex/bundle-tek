import {
  requirePoolTradeMovement,
  type PoolTradeMovement,
  type PoolTradeMovementContext,
} from './pool-trade-movement';
import { walletAddress } from './wallet-workspace';
import { UUID } from './wallet-operation';

const MAX = (1n << 64n) - 1n;
const SCALE = 100_000_000n;
const SOL = 'So11111111111111111111111111111111111111112';
function raw(value: string, positive = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > MAX ||
    (positive && value === '0')
  )
    throw new Error('Invalid Counter atomic amount.');
  return BigInt(value);
}
function percent(value: string, probability = false) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(value)
  )
    throw new Error(
      'Counter percentages require plain decimals with at most six decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (probability ? units > SCALE : units === 0n)
    throw new Error('Counter percentage is outside its supported range.');
  return units;
}
export type CounterRules = {
  format: 'counter-evaluator-v1';
  responseSide: 'Buy' | 'Sell';
  replicationPercent: string;
  trigger:
    | { kind: 'rate'; percent: string }
    | { kind: 'minimum-token' | 'minimum-sol'; minimumRaw: string };
  minimumResponseTokenRaw: string;
  ignoredWallets: string[];
};
export type CounterDecision = {
  identity: string;
  fingerprint: string;
  outcome:
    | 'excluded-wallet'
    | 'ineligible-evidence'
    | 'below-trigger'
    | 'probability-rejected'
    | 'dust'
    | 'buffered'
    | 'proposal';
  draw: number | null;
  contributionTokenRaw: string;
  proposalTokenRaw: string | null;
};
export type CounterLedger = {
  format: 'counter-evaluation-ledger-v1';
  rulesKey: string;
  scope: Pick<
    PoolTradeMovementContext,
    'projectId' | 'revision' | 'mint' | 'decimals'
  >;
  queuedTokenRaw: string;
  decisions: CounterDecision[];
};
function rulesKey(rules: CounterRules) {
  if (
    !rules ||
    rules.format !== 'counter-evaluator-v1' ||
    !['Buy', 'Sell'].includes(rules.responseSide)
  )
    throw new Error('Invalid Counter rules.');
  percent(rules.replicationPercent);
  raw(rules.minimumResponseTokenRaw, true);
  if (
    !Array.isArray(rules.ignoredWallets) ||
    new Set(rules.ignoredWallets).size !== rules.ignoredWallets.length
  )
    throw new Error('Invalid excluded Counter wallets.');
  rules.ignoredWallets.forEach((w) => walletAddress(w, 'Solana'));
  if (rules.trigger?.kind === 'rate') percent(rules.trigger.percent, true);
  else if (
    rules.trigger?.kind === 'minimum-token' ||
    rules.trigger?.kind === 'minimum-sol'
  )
    raw(rules.trigger.minimumRaw, true);
  else throw new Error('Unsupported Counter trigger.');
  return JSON.stringify(rules);
}
export function initialCounterLedger(
  rules: CounterRules,
  scope: CounterLedger['scope'],
): CounterLedger {
  if (
    !UUID.test(scope.projectId) ||
    !Number.isSafeInteger(scope.revision) ||
    scope.revision < 1 ||
    !Number.isInteger(scope.decimals) ||
    scope.decimals < 0 ||
    scope.decimals > 255
  )
    throw new Error('Invalid Counter project scope.');
  walletAddress(scope.mint, 'Solana');
  return {
    format: 'counter-evaluation-ledger-v1',
    rulesKey: rulesKey(rules),
    scope: {
      projectId: scope.projectId,
      revision: scope.revision,
      mint: scope.mint,
      decimals: scope.decimals,
    },
    queuedTokenRaw: '0',
    decisions: [],
  };
}
export function counterProbabilityDraw() {
  const bound = Number(SCALE),
    cutoff = Math.floor(2 ** 32 / bound) * bound;
  const words = new Uint32Array(1);
  do {
    crypto.getRandomValues(words);
  } while (words[0] >= cutoff);
  return words[0] % bound;
}
export function validateCounterLedger(
  rules: CounterRules,
  ledger: CounterLedger,
) {
  initialCounterLedger(rules, ledger.scope);
  if (
    ledger.format !== 'counter-evaluation-ledger-v1' ||
    ledger.rulesKey !== rulesKey(rules) ||
    !Array.isArray(ledger.decisions)
  )
    throw new Error(
      'Counter rules changed. Start a separately reviewed ledger.',
    );
  const queued = raw(ledger.queuedTokenRaw);
  let reconciled = 0n;
  const identities = new Set<string>();
  for (const prior of ledger.decisions) {
    if (
      prior.draw !== null &&
      (!Number.isSafeInteger(prior.draw) ||
        prior.draw < 0 ||
        prior.draw >= Number(SCALE))
    )
      throw new Error('Invalid retained Counter probability sample.');
    const sampledOutcome = [
      'probability-rejected',
      'dust',
      'buffered',
      'proposal',
    ].includes(prior.outcome);
    if (rules.trigger.kind === 'rate' && sampledOutcome) {
      const rate = percent(rules.trigger.percent, true);
      if (rate > 0n && rate < SCALE) {
        if (
          prior.draw === null ||
          BigInt(prior.draw) >= rate !==
            (prior.outcome === 'probability-rejected')
        )
          throw new Error('Retained Counter probability decision differs.');
      } else if (
        prior.draw !== null ||
        (rate === 0n) !== (prior.outcome === 'probability-rejected')
      )
        throw new Error('Retained Counter probability decision differs.');
    } else if (prior.draw !== null || prior.outcome === 'probability-rejected')
      throw new Error('Unexpected retained Counter probability sample.');
    if (
      identities.has(prior.identity) ||
      typeof prior.identity !== 'string' ||
      typeof prior.fingerprint !== 'string'
    )
      throw new Error('Invalid Counter decision history.');
    identities.add(prior.identity);
    reconciled += raw(prior.contributionTokenRaw);
    if (reconciled > MAX)
      throw new Error('Counter history exceeds its amount range.');
    if (prior.outcome === 'proposal') {
      if (
        prior.proposalTokenRaw === null ||
        raw(prior.proposalTokenRaw, true) !== reconciled ||
        reconciled < raw(rules.minimumResponseTokenRaw)
      )
        throw new Error('Counter proposal history differs.');
      reconciled = 0n;
    } else if (
      prior.proposalTokenRaw !== null ||
      ![
        'excluded-wallet',
        'ineligible-evidence',
        'below-trigger',
        'probability-rejected',
        'dust',
        'buffered',
      ].includes(prior.outcome) ||
      (prior.outcome !== 'buffered' && prior.contributionTokenRaw !== '0') ||
      (prior.outcome === 'buffered' &&
        reconciled >= raw(rules.minimumResponseTokenRaw))
    )
      throw new Error('Counter decision history differs.');
  }
  if (reconciled !== queued)
    throw new Error('Counter queue does not reconcile with its decisions.');
  return ledger;
}

/** Evaluation only: callers must persist the returned decision/queue atomically before exposing a proposal. */
export function evaluateCounterTrade(
  rules: CounterRules,
  ledger: CounterLedger,
  movement: PoolTradeMovement,
  context: PoolTradeMovementContext,
  draw: () => number = counterProbabilityDraw,
) {
  requirePoolTradeMovement(movement, context);
  if (!movement.classification)
    throw new Error('Counter classification is unavailable.');
  validateCounterLedger(rules, ledger);
  if (
    ledger.scope.projectId !== context.projectId ||
    ledger.scope.revision !== context.revision ||
    ledger.scope.mint !== context.mint ||
    ledger.scope.decimals !== context.decimals
  )
    throw new Error('Counter ledger project scope differs.');
  const queued = raw(ledger.queuedTokenRaw);
  const identity = JSON.stringify([
    movement.projectId,
    movement.mint,
    movement.wallet,
    movement.signature,
  ]);
  const fingerprint = JSON.stringify([
    movement.revision,
    movement.slot,
    movement.providerSide,
    movement.failed,
    movement.walletSigner,
    movement.blockAgrees,
    movement.sideAgrees,
    movement.tokenChange,
    movement.classification,
    movement.providerBlock,
  ]);
  const matches = ledger.decisions.filter((d) => d.identity === identity);
  if (matches.length > 1)
    throw new Error('Repeated Counter decision identity.');
  if (matches[0]) {
    if (matches[0].fingerprint !== fingerprint)
      throw new Error(
        'Counter evidence changed for an already-decided transaction.',
      );
    return {
      executionAllowed: false as const,
      replayed: true,
      ledger,
      decision: matches[0],
    };
  }
  const decision: CounterDecision = {
    identity,
    fingerprint,
    outcome: 'ineligible-evidence',
    draw: null,
    contributionTokenRaw: '0',
    proposalTokenRaw: null,
  };
  let nextQueued = queued;
  const opposite = rules.responseSide === 'Sell' ? 'buy' : 'sell';
  if (rules.ignoredWallets.includes(movement.wallet))
    decision.outcome = 'excluded-wallet';
  else if (
    !movement.failed &&
    movement.walletSigner &&
    movement.blockAgrees &&
    movement.sideAgrees === true &&
    movement.classification.kind === opposite &&
    movement.tokenChange
  ) {
    const delta = BigInt(movement.tokenChange.changeRaw);
    const observed = delta < 0n ? -delta : delta;
    let accepted = true;
    if (rules.trigger.kind === 'minimum-token')
      accepted = observed >= raw(rules.trigger.minimumRaw);
    if (rules.trigger.kind === 'minimum-sol') {
      const quote = movement.classification.quote;
      if (!quote || quote.mint !== SOL || quote.decimals !== 9)
        return append('ineligible-evidence');
      accepted = raw(quote.raw) >= raw(rules.trigger.minimumRaw);
    }
    if (!accepted) return append('below-trigger');
    if (
      rules.trigger.kind === 'rate' &&
      percent(rules.trigger.percent, true) === 0n
    )
      return append('probability-rejected');
    const contribution = (observed * percent(rules.replicationPercent)) / SCALE;
    if (contribution > MAX || queued + contribution > MAX)
      throw new Error('Counter accumulation exceeds its atomic amount range.');
    if (rules.trigger.kind === 'rate') {
      const rate = percent(rules.trigger.percent, true);
      if (rate < SCALE) {
        const sample = draw();
        if (
          !Number.isSafeInteger(sample) ||
          sample < 0 ||
          sample >= Number(SCALE)
        )
          throw new Error('Invalid Counter probability sample.');
        decision.draw = sample;
        if (BigInt(sample) >= rate) return append('probability-rejected');
      }
    }
    decision.contributionTokenRaw = contribution.toString();
    if (contribution === 0n) return append('dust');
    nextQueued += contribution;
    if (nextQueued >= raw(rules.minimumResponseTokenRaw)) {
      decision.proposalTokenRaw = nextQueued.toString();
      nextQueued = 0n;
      decision.outcome = 'proposal';
    } else decision.outcome = 'buffered';
  }
  return append(decision.outcome);
  function append(outcome: CounterDecision['outcome']) {
    decision.outcome = outcome;
    return {
      executionAllowed: false as const,
      replayed: false,
      decision,
      ledger: {
        ...ledger,
        queuedTokenRaw: nextQueued.toString(),
        decisions: [...ledger.decisions, decision],
      },
    };
  }
}
