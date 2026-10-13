import {
  initialCounterLedger,
  validateCounterLedger,
  type CounterRules,
  type CounterLedger,
} from './counter-trade';
import { UUID } from './wallet-operation';
export type CounterPlan = {
  format: 'counter-plan-v1';
  executionAllowed: false;
  id: string;
  projectId: string;
  revision: number;
  state: 'active' | 'paused' | 'ended';
  projectDocument: string;
  rules: CounterRules;
  ledger: CounterLedger;
  createdAt: string;
  updatedAt: string;
};
export function decodeCounterPlan(value: unknown): CounterPlan {
  const p = value as CounterPlan;
  if (
    !p ||
    p.format !== 'counter-plan-v1' ||
    p.executionAllowed !== false ||
    !UUID.test(p.id) ||
    !UUID.test(p.projectId) ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 1 ||
    !['active', 'paused', 'ended'].includes(p.state) ||
    typeof p.projectDocument !== 'string' ||
    p.ledger?.scope?.projectId !== p.projectId ||
    new Date(p.createdAt).toISOString() !== p.createdAt ||
    new Date(p.updatedAt).toISOString() !== p.updatedAt ||
    p.updatedAt < p.createdAt
  )
    throw new Error('Counter plan context differs.');
  const initial = initialCounterLedger(p.rules, p.ledger.scope);
  if (
    initial.rulesKey !== p.ledger.rulesKey ||
    !Array.isArray(p.ledger.decisions) ||
    p.ledger.decisions.length > 1000 ||
    !/^(0|[1-9]\d{0,19})$/.test(p.ledger.queuedTokenRaw)
  )
    throw new Error('Counter ledger differs.');
  validateCounterLedger(p.rules, p.ledger);
  return p;
}
export async function readCounterPlan(
  db: D1Database,
  owner: string,
  project: string,
  id: string,
) {
  const row = await db
    .prepare(
      'SELECT revision,state,document FROM counter_trade_plans WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(owner, project, id)
    .first<{ revision: number; state: string; document: string }>();
  if (!row) return null;
  const p = decodeCounterPlan(JSON.parse(row.document));
  if (
    p.id !== id ||
    p.projectId !== project ||
    p.revision !== row.revision ||
    p.state !== row.state
  )
    throw new Error('Stored Counter identity differs.');
  return p;
}
