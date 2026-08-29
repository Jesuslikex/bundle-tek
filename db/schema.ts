import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const pulseStrategies = sqliteTable(
  'pulse_strategies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: text('owner_id').notNull(),
    strategy: text('strategy').notNull(),
    agents: integer('agents').notNull(),
    budget: real('budget').notNull(),
    cadence: integer('cadence').notNull(),
    orderSize: real('order_size').notNull(),
    spread: integer('spread').notNull(),
    inventory: integer('inventory').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    network: text('network').notNull().default('devnet'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_pulse_strategies_owner').on(table.ownerId)],
);

export const pulseCycles = sqliteTable(
  'pulse_cycles',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    strategy: text('strategy').notNull(),
    slot: integer('slot').notNull(),
    blockhash: text('blockhash').notNull(),
    rpcLatencyMs: integer('rpc_latency_ms').notNull(),
    plannedOrders: integer('planned_orders').notNull(),
    projectedTurnover: real('projected_turnover').notNull(),
    riskScore: integer('risk_score').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_pulse_cycles_owner_created').on(table.ownerId, table.createdAt)],
);

export const pulseCycleGates = sqliteTable('pulse_cycle_gates', {
  ownerId: text('owner_id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  claimedAt: text('claimed_at').notNull(),
});

export const pulseCycleRequests = sqliteTable(
  'pulse_cycle_requests',
  {
    ownerId: text('owner_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    cycleId: text('cycle_id'),
    claimedAt: text('claimed_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('idx_pulse_cycle_requests_owner_key').on(table.ownerId, table.idempotencyKey),
    index('idx_pulse_cycle_requests_claimed').on(table.claimedAt),
  ],
);

export const launchPlans = sqliteTable(
  'launch_plans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    launchpad: text('launchpad').notNull(),
    currency: text('currency').notNull(),
    tokenName: text('token_name').notNull(),
    ticker: text('ticker').notNull(),
    description: text('description').notNull(),
    mode: text('mode').notNull(),
    preset: text('preset').notNull(),
    developerBuy: real('developer_buy').notNull(),
    holdersBuy: real('holders_buy').notNull(),
    holderCount: integer('holder_count').notNull(),
    routingEmphasis: integer('routing_emphasis').notNull(),
    useHusher: integer('use_husher', { mode: 'boolean' }).notNull().default(false),
    scheduled: integer('scheduled', { mode: 'boolean' }).notNull().default(false),
    simulationSafety: text('simulation_safety').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_launch_plans_owner').on(table.ownerId)],
);

export const walletChallenges = sqliteTable(
  'wallet_challenges',
  {
    id: text('id').primaryKey(),
    walletAddress: text('wallet_address').notNull(),
    message: text('message').notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => [index('idx_wallet_challenges_address_expires').on(table.walletAddress, table.expiresAt)],
);

export const walletAuditEvents = sqliteTable(
  'wallet_audit_events',
  {
    id: text('id').primaryKey(),
    walletAddress: text('wallet_address').notNull(),
    network: text('network').notNull().default('devnet'),
    eventType: text('event_type').notNull(),
    transactionSignature: text('transaction_signature'),
    details: text('details').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_wallet_audit_address_created').on(table.walletAddress, table.createdAt),
    uniqueIndex('idx_wallet_audit_transaction').on(table.transactionSignature),
  ],
);
