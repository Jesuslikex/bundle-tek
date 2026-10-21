import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  blob,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export * from './exchange-funding-schema';
export * from './pump-receipt-evidence-schema';
export * from './pump-purchase-cost-schema';
export * from './launch-layer-schema';
export * from './strategy-session-schema';
export * from './strategy-review-capacity-schema';
export * from './trade-amount-preferences-schema';
export * from './volume-bundle-schema';
export * from './volume-recovery-schema';
export * from './holder-index-schema';
export * from './jito-bundle-schema';
export * from './conditional-monitor-schema';
export * from './counter-trade-schema';
export * from './counter-reservation-schema';
export * from './launch-metadata-schema';
export * from './pump-launch-schema';

export const importedSupplyScopes = sqliteTable(
  'imported_supply_scopes',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    id: text('id').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.projectId, t.id] })],
);
export const supplyAlertReviews = sqliteTable(
  'supply_alert_reviews',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    scopeId: text('scope_id').notNull(),
    reviewedThrough: integer('reviewed_through').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.projectId, t.scopeId] })],
);
export const importedSupplyObservations = sqliteTable(
  'imported_supply_observations',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    scopeId: text('scope_id').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('imported_supply_observations_scope').on(
      t.ownerId,
      t.projectId,
      t.scopeId,
      t.sequence,
    ),
  ],
);
export const importedSupplyReadGates = sqliteTable(
  'imported_supply_read_gates',
  {
    ownerId: text('owner_id').primaryKey(),
    nextAllowedAt: integer('next_allowed_at').notNull(),
  },
);

export const walletOwnershipChallenges = sqliteTable(
  'wallet_ownership_challenges',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    message: text('message').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    claimId: text('claim_id'),
  },
  (table) => [
    index('idx_wallet_ownership_challenge_owner').on(
      table.ownerId,
      table.expiresAt,
    ),
  ],
);
export const walletOwnershipProofs = sqliteTable(
  'wallet_ownership_proofs',
  {
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    verifiedAt: text('verified_at').notNull(),
    challengeId: text('challenge_id').notNull(),
  },
  (table) => [
    uniqueIndex('idx_wallet_ownership_proof_account').on(
      table.ownerId,
      table.chain,
      table.address,
    ),
  ],
);

export const walletBalanceSnapshots = sqliteTable(
  'wallet_balance_snapshots',
  {
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    blockNumber: integer('block_number').notNull(),
  },
  (table) => [
    uniqueIndex('idx_wallet_balance_owner_chain_address').on(
      table.ownerId,
      table.chain,
      table.address,
    ),
  ],
);
export const walletHoldingsSnapshots = sqliteTable(
  'wallet_holdings_snapshots',
  {
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    maxSlot: integer('max_slot').notNull(),
  },
  (table) => [
    uniqueIndex('idx_wallet_holdings_owner_chain_address').on(
      table.ownerId,
      table.chain,
      table.address,
    ),
  ],
);
export const walletMintHoldingsSnapshots = sqliteTable(
  'wallet_mint_holdings_snapshots',
  {
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    mint: text('mint').notNull(),
    document: text('document').notNull(),
    maxSlot: integer('max_slot').notNull(),
  },
  (table) => [
    uniqueIndex('idx_wallet_mint_holdings_owner_address_mint').on(
      table.ownerId,
      table.chain,
      table.address,
      table.mint,
    ),
  ],
);
export const trackedWalletHoldings = sqliteTable(
  'tracked_wallet_holdings',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    maxSlot: integer('max_slot').notNull(),
  },
  (table) => [
    uniqueIndex('idx_tracked_holdings_owner_network_address').on(
      table.ownerId,
      table.network,
      table.address,
    ),
  ],
);
export const trackedWalletTransactions = sqliteTable(
  'tracked_wallet_transactions',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    signature: text('signature').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    slot: integer('slot').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_tracked_transaction_owner_wallet_signature').on(
      table.ownerId,
      table.network,
      table.address,
      table.signature,
    ),
    index('idx_tracked_transactions_wallet_time').on(
      table.ownerId,
      table.network,
      table.address,
      table.observedAt,
      table.signature,
    ),
  ],
);
export const walletBalanceGates = sqliteTable(
  'wallet_balance_gates',
  {
    ownerId: text('owner_id').notNull(),
    nextAllowedAt: integer('next_allowed_at').notNull(),
  },
  (table) => [uniqueIndex('idx_wallet_balance_gate_owner').on(table.ownerId)],
);

export const projectArtwork = sqliteTable(
  'project_artwork',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    data: blob('data', { mode: 'buffer' }).notNull(),
    mime: text('mime').notNull(),
    byteLength: integer('byte_length').notNull(),
    createdAt: text('created_at').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (table) => [uniqueIndex('idx_artwork_owner_id').on(table.ownerId, table.id)],
);

export const walletFolders = sqliteTable(
  'wallet_folders',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#A6B1FF'),
    chain: text('chain').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_wallet_folders_owner_id').on(table.ownerId, table.id),
  ],
);

export const workspaceWallets = sqliteTable(
  'workspace_wallets',
  {
    ownerId: text('owner_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    folderId: text('folder_id').notNull(),
    folderIds: text('folder_ids'),
    label: text('label').notNull(),
    tags: text('tags').notNull().default('[]'),
    role: text('role').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_workspace_wallets_owner_chain_address').on(
      table.ownerId,
      table.chain,
      table.address,
    ),
    index('idx_workspace_wallets_folder').on(table.ownerId, table.folderId),
  ],
);

export const workspaceProjects = sqliteTable(
  'workspace_projects',
  {
    id: text('id').notNull(),
    ownerId: text('owner_id').notNull(),
    document: text('document').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
    mutationId: text('mutation_id').notNull().default('legacy'),
  },
  (table) => [
    uniqueIndex('idx_workspace_projects_owner_id').on(table.ownerId, table.id),
  ],
);

export const projectEvents = sqliteTable(
  'project_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    chain: text('chain').notNull(),
    launchpad: text('launchpad').notNull(),
    type: text('type').notNull(),
    changes: text('changes').notNull(),
    revision: text('revision').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_project_events_owner_id').on(table.ownerId, table.id)],
);

export const fundingPlans = sqliteTable(
  'funding_plans',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    document: text('document').notNull(),
    revision: integer('revision').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    mutationId: text('mutation_id').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_funding_owner_id').on(table.ownerId, table.id)],
);

export const fundingEvents = sqliteTable(
  'funding_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    name: text('name').notNull(),
    chain: text('chain').notNull(),
    type: text('type').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_funding_events_owner_id').on(table.ownerId, table.id)],
);

export const trackedWallets = sqliteTable(
  'tracked_wallets',
  {
    ownerId: text('owner_id').notNull(),
    address: text('address').notNull(),
    network: text('network').notNull(),
    label: text('label').notNull(),
    group: text('group_name').notNull().default(''),
    icon: text('icon').notNull().default('⭐'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_tracked_wallets_owner_address_network').on(
      table.ownerId,
      table.address,
      table.network,
    ),
  ],
);

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
  (table) => [
    index('idx_pulse_cycles_owner_created').on(table.ownerId, table.createdAt),
  ],
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
    uniqueIndex('idx_pulse_cycle_requests_owner_key').on(
      table.ownerId,
      table.idempotencyKey,
    ),
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
    quoteAddress: text('quote_address'),
    timing: text('timing'),
    holdersBuyQuote: text('holders_buy_quote'),
    holdersDistribution: text('holders_distribution'),
    tokenName: text('token_name').notNull(),
    ticker: text('ticker').notNull(),
    description: text('description').notNull(),
    mode: text('mode').notNull(),
    preset: text('preset').notNull(),
    developerBuy: real('developer_buy').notNull(),
    holdersBuy: real('holders_buy').notNull(),
    holderCount: integer('holder_count').notNull(),
    routingEmphasis: integer('routing_emphasis').notNull(),
    useHusher: integer('use_husher', { mode: 'boolean' })
      .notNull()
      .default(false),
    scheduled: integer('scheduled', { mode: 'boolean' })
      .notNull()
      .default(false),
    simulationSafety: text('simulation_safety').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_launch_plans_owner').on(table.ownerId)],
);

export const walletWarmupPlans = sqliteTable(
  'wallet_warmup_plans',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    document: text('document').notNull(),
    revision: integer('revision').notNull().default(1),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
    mutationId: text('mutation_id').notNull().default(''),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.id] })],
);

export const walletWarmupPlanEvents = sqliteTable(
  'wallet_warmup_plan_events',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    type: text('type').notNull(),
    revision: integer('revision').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_warmup_event_revision').on(
      table.ownerId,
      table.planId,
      table.revision,
    ),
  ],
);

export const walletChallenges = sqliteTable(
  'wallet_challenges',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().default(''),
    origin: text('origin').notNull().default(''),
    claimNonce: text('claim_nonce'),
    walletAddress: text('wallet_address').notNull(),
    message: text('message').notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => [
    index('idx_wallet_challenges_address_expires').on(
      table.walletAddress,
      table.expiresAt,
    ),
    index('idx_wallet_challenges_owner_address').on(
      table.ownerId,
      table.walletAddress,
      table.expiresAt,
    ),
  ],
);

export const walletAuditEvents = sqliteTable(
  'wallet_audit_events',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().default(''),
    walletAddress: text('wallet_address').notNull(),
    network: text('network').notNull().default('devnet'),
    eventType: text('event_type').notNull(),
    transactionSignature: text('transaction_signature'),
    details: text('details').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_wallet_audit_address_created').on(
      table.walletAddress,
      table.createdAt,
    ),
    uniqueIndex('idx_wallet_audit_owner_transaction').on(
      table.ownerId,
      table.transactionSignature,
    ),
    index('idx_wallet_audit_owner_created').on(
      table.ownerId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const walletReceiptGates = sqliteTable('wallet_receipt_gates', {
  ownerId: text('owner_id').primaryKey(),
  claimedAt: integer('claimed_at').notNull(),
});

export const importedTokenProjects = sqliteTable(
  'imported_token_projects',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    revision: integer('revision').notNull().default(1),
    archived: integer('archived').notNull().default(0),
    mutationId: text('mutation_id').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    uniqueIndex('idx_imported_project_token').on(
      table.ownerId,
      table.chain,
      table.address,
    ),
  ],
);

export const importedTokenProjectEvents = sqliteTable(
  'imported_token_project_events',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    type: text('type').notNull(),
    revision: integer('revision').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_imported_event_revision').on(
      table.ownerId,
      table.projectId,
      table.revision,
    ),
  ],
);

export const importedTokenProjectGates = sqliteTable(
  'imported_token_project_gates',
  {
    ownerId: text('owner_id').primaryKey(),
    nextAllowedAt: integer('next_allowed_at').notNull(),
  },
);

export const walletOperations = sqliteTable(
  'wallet_operations',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    kind: text('kind').notNull(),
    document: text('document').notNull(),
    claimHash: text('claim_hash').notNull(),
    state: text('state').notNull().default('preparing'),
    signature: text('signature'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    armedAt: text('armed_at'),
    minimumSlot: integer('minimum_slot'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    uniqueIndex('idx_wallet_operation_active')
      .on(table.ownerId, table.walletAddress)
      .where(
        sql`${table.state} IN ('preparing','awaiting_signature','submitted')`,
      ),
    uniqueIndex('idx_wallet_operation_signature').on(
      table.ownerId,
      table.signature,
    ),
    index('idx_wallet_operation_owner_updated').on(
      table.ownerId,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const warmupHistoryRuns = sqliteTable(
  'warmup_history_runs',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull().default('planned'),
    revision: integer('revision').notNull().default(1),
    lastEvent: text('last_event').notNull().default('run.snapshot'),
    leaseNonce: text('lease_nonce'),
    leaseUntil: integer('lease_until'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    uniqueIndex('idx_warmup_history_active')
      .on(table.ownerId, table.planId)
      .where(sql`${table.state} IN ('planned','running','paused')`),
    index('idx_warmup_history_plan').on(
      table.ownerId,
      table.planId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const warmupHistoryRunEvents = sqliteTable(
  'warmup_history_run_events',
  {
    ownerId: text('owner_id').notNull(),
    runId: text('run_id').notNull(),
    revision: integer('revision').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull(),
    completedCount: integer('completed_count').notNull(),
    errorCount: integer('error_count').notNull(),
    walletAddress: text('wallet_address'),
    resultDocument: text('result_document'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.runId, table.revision] }),
    index('idx_warmup_run_event_plan').on(
      table.ownerId,
      table.planId,
      table.createdAt,
      table.runId,
      table.revision,
    ),
  ],
);

export const trackedSignatureSnapshots = sqliteTable(
  'tracked_signature_snapshots',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.network, table.address] }),
  ],
);

export const importedMarketObservations = sqliteTable(
  'imported_market_observations',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.projectId] })],
);
export const marketReadGates = sqliteTable('market_read_gates', {
  ownerId: text('owner_id').primaryKey(),
  nextAllowedAt: integer('next_allowed_at').notNull(),
});
export const trackedEvmSnapshots = sqliteTable(
  'tracked_evm_snapshots',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.network, table.address] }),
  ],
);
export const trackerEvmReadGates = sqliteTable('tracker_evm_read_gates', {
  ownerId: text('owner_id').primaryKey(),
  nextAllowedAt: integer('next_allowed_at').notNull(),
});
export const trackedEvmHoldings = sqliteTable(
  'tracked_evm_holdings',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.network, table.address] }),
  ],
);
export const importedPoolCandles = sqliteTable(
  'imported_pool_candles',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.projectId] })],
);
export const importedPoolTrades = sqliteTable(
  'imported_pool_trades',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.projectId] })],
);
export const importedEvmBalances = sqliteTable(
  'imported_evm_balances',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    document: text('document').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.projectId, table.walletAddress],
    }),
  ],
);
export const trackedEvmTransactions = sqliteTable(
  'tracked_evm_transactions',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    hash: text('hash').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.network, table.address, table.hash],
    }),
  ],
);
export const trackedEvmDiscovery = sqliteTable(
  'tracked_evm_discovery',
  {
    ownerId: text('owner_id').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    document: text('document').notNull(),
    walletUpdatedAt: text('wallet_updated_at').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.network, table.address] }),
  ],
);
export const importedSwapPreparations = sqliteTable(
  'imported_swap_preparations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    walletAddress: text('wallet_address').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('imported_swap_preparations_project').on(
      table.ownerId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const warmupSwapPreparations = sqliteTable(
  'warmup_swap_preparations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    cycle: integer('cycle').notNull(),
    walletAddress: text('wallet_address').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('warmup_swap_preparations_plan').on(
      table.ownerId,
      table.planId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const warmupBuyReceipts = sqliteTable(
  'warmup_buy_receipts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    cycle: integer('cycle').notNull(),
    walletAddress: text('wallet_address').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    signature: text('signature').notNull(),
    remainingRaw: text('remaining_raw'),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('warmup_buy_receipts_preparation').on(
      table.ownerId,
      table.preparationId,
    ),
    uniqueIndex('warmup_buy_receipts_signature').on(
      table.ownerId,
      table.signature,
    ),
    index('warmup_buy_receipts_plan').on(
      table.ownerId,
      table.planId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const warmupSellReceipts = sqliteTable(
  'warmup_sell_receipts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    buyReceiptId: text('buy_receipt_id').notNull(),
    planId: text('plan_id').notNull(),
    signature: text('signature').notNull(),
    consumedRaw: text('consumed_raw').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('warmup_sell_receipts_preparation').on(
      table.ownerId,
      table.preparationId,
    ),
    uniqueIndex('warmup_sell_receipts_signature').on(
      table.ownerId,
      table.signature,
    ),
    index('warmup_sell_receipts_lot').on(table.ownerId, table.buyReceiptId),
  ],
);

export const warmupSigningEvents = sqliteTable(
  'warmup_signing_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    intentId: text('intent_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    planId: text('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    cycle: integer('cycle').notNull(),
    walletAddress: text('wallet_address').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull(),
    signature: text('signature'),
    failureReceipt: text('failure_receipt'),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('warmup_signing_events_owner').on(
      table.ownerId,
      table.createdAt,
      table.id,
    ),
    index('warmup_signing_events_intent').on(
      table.ownerId,
      table.intentId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const warmupSigningIntents = sqliteTable(
  'warmup_signing_intents',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    signature: text('signature'),
    failureReceipt: text('failure_receipt'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('warmup_signing_intents_preparation').on(
      table.ownerId,
      table.preparationId,
    ),
    uniqueIndex('warmup_signing_intents_signature')
      .on(table.ownerId, table.signature)
      .where(sql`${table.signature} IS NOT NULL`),
    uniqueIndex('warmup_signing_intents_active_wallet')
      .on(table.ownerId, table.walletAddress)
      .where(
        sql`${table.state} IN ('awaiting_signature','signed','submitted')`,
      ),
  ],
);

export const importedSwapSigningIntents = sqliteTable(
  'imported_swap_signing_intents',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    signature: text('signature'),
    failureReceipt: text('failure_receipt'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('imported_swap_signing_preparation').on(
      table.ownerId,
      table.preparationId,
    ),
    uniqueIndex('imported_swap_signing_signature')
      .on(table.ownerId, table.signature)
      .where(sql`${table.signature} IS NOT NULL`),
  ],
);
export const solanaSwapReservations = sqliteTable(
  'solana_swap_reservations',
  {
    ownerId: text('owner_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    scope: text('scope').notNull(),
    intentId: text('intent_id').notNull(),
    state: text('state').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.walletAddress] }),
    uniqueIndex('solana_swap_reservations_intent').on(
      table.ownerId,
      table.scope,
      table.intentId,
    ),
  ],
);
export const solanaSwapSignatures = sqliteTable(
  'solana_swap_signatures',
  {
    ownerId: text('owner_id').notNull(),
    signature: text('signature').notNull(),
    scope: text('scope').notNull(),
    intentId: text('intent_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.signature] }),
    uniqueIndex('solana_swap_signatures_intent').on(
      table.ownerId,
      table.scope,
      table.intentId,
    ),
  ],
);
export const importedSwapReceipts = sqliteTable(
  'imported_swap_receipts',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    intentId: text('intent_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    signature: text('signature').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('imported_swap_receipts_intent').on(
      table.ownerId,
      table.intentId,
    ),
    uniqueIndex('imported_swap_receipts_signature').on(
      table.ownerId,
      table.signature,
    ),
    index('imported_swap_receipts_project').on(
      table.ownerId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const importedSaleReceiptEvidence = sqliteTable(
  'imported_sale_receipt_evidence',
  {
    ownerId: text('owner_id').notNull(),
    receiptId: text('receipt_id')
      .notNull()
      .references(() => importedSwapReceipts.id),
    signature: text('signature').notNull(),
    parent: text('parent').notNull(),
    parentSha256: text('parent_sha256').notNull(),
    evidence: text('evidence').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.receiptId] }),
    uniqueIndex('imported_sale_receipt_evidence_signature').on(
      t.ownerId,
      t.signature,
    ),
  ],
);
export const launchSaleAllocations = sqliteTable(
  'launch_sale_allocations',
  {
    ownerId: text('owner_id').notNull(),
    saleReceiptId: text('sale_receipt_id').notNull(),
    saleSignature: text('sale_signature').notNull(),
    wallet: text('wallet').notNull(),
    mint: text('mint').notNull(),
    document: text('document').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.saleReceiptId] }),
    uniqueIndex('launch_sale_allocations_owner_id_sale_signature_unique').on(
      t.ownerId,
      t.saleSignature,
    ),
    index('launch_sale_allocations_inventory').on(
      t.ownerId,
      t.wallet,
      t.mint,
      t.saleReceiptId,
    ),
    foreignKey({
      columns: [t.ownerId, t.saleReceiptId],
      foreignColumns: [
        importedSaleReceiptEvidence.ownerId,
        importedSaleReceiptEvidence.receiptId,
      ],
    }),
  ],
);
export const importedSwapSigningEvents = sqliteTable(
  'imported_swap_signing_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    intentId: text('intent_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    projectId: text('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    walletAddress: text('wallet_address').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull(),
    signature: text('signature'),
    failureReceipt: text('failure_receipt'),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('imported_swap_signing_events_owner').on(
      table.ownerId,
      table.createdAt,
      table.sequence,
    ),
    index('imported_swap_signing_events_project').on(
      table.ownerId,
      table.projectId,
      table.createdAt,
      table.sequence,
    ),
    index('imported_swap_signing_events_intent').on(
      table.ownerId,
      table.intentId,
      table.sequence,
    ),
  ],
);

export const solanaExecutionReservations = sqliteTable(
  'solana_execution_reservations',
  {
    ownerId: text('owner_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    scope: text('scope').notNull(),
    intentId: text('intent_id').notNull(),
    state: text('state').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.walletAddress] })],
);
export const solanaExecutionSignatures = sqliteTable(
  'solana_execution_signatures',
  {
    ownerId: text('owner_id').notNull(),
    signature: text('signature').notNull(),
    scope: text('scope').notNull(),
    intentId: text('intent_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.signature] })],
);
export const nativeWithdrawals = sqliteTable(
  'native_withdrawals',
  {
    id: text('id').primaryKey().notNull(),
    ownerId: text('owner_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    walletRevision: integer('wallet_revision').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    signature: text('signature'),
    receipt: text('receipt'),
    failureReceipt: text('failure_receipt'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('native_withdrawals_owner_signature').on(
      table.ownerId,
      table.signature,
    ),
    index('native_withdrawals_owner').on(
      table.ownerId,
      table.createdAt,
      table.id,
    ),
    index('native_withdrawals_wallet').on(
      table.ownerId,
      table.walletAddress,
      table.createdAt,
      table.id,
    ),
  ],
);
export const nativeWithdrawalEvents = sqliteTable('native_withdrawal_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  ownerId: text('owner_id').notNull(),
  intentId: text('intent_id').notNull(),
  walletAddress: text('wallet_address').notNull(),
  state: text('state').notNull(),
  signature: text('signature'),
  failureReceipt: text('failure_receipt'),
  createdAt: text('created_at').notNull(),
});
export const importedTradeLotGates = sqliteTable(
  'imported_trade_lot_gates',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull().default(0),
    writeToken: text('write_token'),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.projectId] })],
);
export const conditionalSellOrders = sqliteTable(
  'conditional_sell_orders',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    index('conditional_sell_orders_project').on(
      table.ownerId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const conditionalLevelReservations = sqliteTable(
  'conditional_level_reservations',
  {
    ownerId: text('owner_id').notNull(),
    orderId: text('order_id').notNull(),
    level: integer('level').notNull(),
    intentId: text('intent_id').notNull(),
    unitsRaw: text('units_raw').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.orderId, table.level] }),
    uniqueIndex('conditional_level_reservations_intent').on(
      table.ownerId,
      table.intentId,
    ),
  ],
);
export const conditionalOrderEvents = sqliteTable(
  'conditional_order_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    orderId: text('order_id').notNull(),
    type: text('type').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('conditional_order_events_scope').on(
      t.ownerId,
      t.projectId,
      t.createdAt,
      t.sequence,
    ),
  ],
);
export const conditionalLevelFills = sqliteTable(
  'conditional_level_fills',
  {
    ownerId: text('owner_id').notNull(),
    orderId: text('order_id').notNull(),
    level: integer('level').notNull(),
    intentId: text('intent_id').notNull(),
    receiptId: text('receipt_id').notNull(),
    preparationId: text('preparation_id').notNull(),
    signature: text('signature').notNull(),
    unitsRaw: text('units_raw').notNull(),
    termsSha256: text('terms_sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.orderId, table.level] }),
    uniqueIndex('conditional_level_fills_intent').on(
      table.ownerId,
      table.intentId,
    ),
    uniqueIndex('conditional_level_fills_receipt').on(
      table.ownerId,
      table.receiptId,
    ),
  ],
);
export const importedTradeLotLinks = sqliteTable(
  'imported_trade_lot_links',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    buyReceiptId: text('buy_receipt_id').notNull(),
    sellReceiptId: text('sell_receipt_id').notNull(),
    unitsRaw: text('units_raw').notNull(),
    buySignature: text('buy_signature').notNull(),
    sellSignature: text('sell_signature').notNull(),
    buyPreparationSha256: text('buy_preparation_sha256').notNull(),
    sellPreparationSha256: text('sell_preparation_sha256').notNull(),
    createdAt: text('created_at').notNull(),
    writeToken: text('write_token'),
  },
  (table) => [
    uniqueIndex('imported_trade_lot_links_sell').on(
      table.ownerId,
      table.sellReceiptId,
      table.buyReceiptId,
    ),
    index('imported_trade_lot_links_project').on(
      table.ownerId,
      table.projectId,
    ),
  ],
);

export const importedTradeSessions = sqliteTable(
  'imported_trade_sessions',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    index('imported_trade_sessions_project').on(
      t.ownerId,
      t.projectId,
      t.createdAt,
    ),
  ],
);

export const importedTradeSessionEvents = sqliteTable(
  'imported_trade_session_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    document: text('document').notNull(),
    approval: text('approval'),
    control: text('control'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('imported_trade_session_events_owner').on(t.ownerId, t.sequence),
    index('imported_trade_session_events_scope').on(
      t.ownerId,
      t.projectId,
      t.sessionId,
      t.sequence,
    ),
  ],
);

export const importedTradeSessionControls = sqliteTable(
  'imported_trade_session_controls',
  {
    ownerId: text('owner_id').notNull(),
    sessionId: text('session_id').notNull(),
    projectId: text('project_id').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.sessionId] }),
    index('imported_trade_session_controls_project').on(t.ownerId, t.projectId),
  ],
);

export const sessionPreparationJobs = sqliteTable(
  'session_preparation_jobs',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    entry: integer('entry').notNull(),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    notBefore: text('not_before').notNull(),
    nextAttemptAt: text('next_attempt_at').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: text('lease_until'),
    controlRevision: integer('control_revision'),
    preparationId: text('preparation_id'),
    payload: text('payload'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('session_preparation_jobs_live_entry')
      .on(t.ownerId, t.sessionId, t.entry)
      .where(sql`${t.state} IN ('queued','running')`),
    index('session_preparation_jobs_due').on(
      t.state,
      t.nextAttemptAt,
      t.notBefore,
    ),
    index('session_preparation_jobs_owner').on(
      t.ownerId,
      t.projectId,
      t.sessionId,
    ),
  ],
);
export const supplyMovementEvidence = sqliteTable(
  'supply_movement_evidence',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    observationId: text('observation_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('supply_movement_evidence_scope').on(
      t.ownerId,
      t.projectId,
      t.observationId,
      t.walletAddress,
      t.sequence,
    ),
  ],
);
export const sessionPreparationJobEvents = sqliteTable(
  'session_preparation_job_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    jobId: text('job_id').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('session_preparation_job_events_scope').on(
      t.ownerId,
      t.projectId,
      t.sessionId,
      t.sequence,
    ),
  ],
);
export const walletWarmupSessionV2Attempts = sqliteTable(
  'wallet_warmup_session_v2_attempts',
  {
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    journalId: text('journal_id').notNull(),
    actionId: text('action_id').notNull(),
    sequence: integer('sequence').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    previousId: text('previous_id'),
    reviewVersion: integer('review_version').notNull(),
    reviewSha256: text('review_sha256').notNull(),
    termsSha256: text('terms_sha256').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.id] }),
    uniqueIndex('warmup_v2_attempt_sequence').on(
      t.ownerId,
      t.journalId,
      t.sequence,
    ),
    uniqueIndex('warmup_v2_attempt_identity').on(t.id),
    uniqueIndex('warmup_v2_attempt_action_number').on(
      t.ownerId,
      t.journalId,
      t.actionId,
      t.attemptNo,
    ),
  ],
);
export const walletWarmupSessionV2AttemptOutcomes = sqliteTable(
  'wallet_warmup_session_v2_attempt_outcomes',
  {
    ownerId: text('owner_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    kind: text('kind').notNull(),
    summaryDocument: text('summary_document'),
    unsignedTransaction: text('unsigned_transaction'),
    packetSha256: text('packet_sha256'),
    feeDocument: text('fee_document'),
    refusalCode: text('refusal_code'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    recordSha256: text('record_sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.attemptId] }),
    foreignKey({
      columns: [t.ownerId, t.attemptId],
      foreignColumns: [
        walletWarmupSessionV2Attempts.ownerId,
        walletWarmupSessionV2Attempts.id,
      ],
    }),
    uniqueIndex('warmup_v2_attempt_packet').on(t.ownerId, t.packetSha256),
  ],
);
// 0135 owns the deferred foreign keys and admission triggers in SQL.
export const walletWarmupSessionV2AttemptPurposes = sqliteTable(
  'wallet_warmup_session_v2_attempt_purposes',
  {
    ownerId: text('owner_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    journalId: text('journal_id').notNull(),
    reviewVersion: integer('review_version').notNull(),
    reviewSha256: text('review_sha256').notNull(),
    termsSha256: text('terms_sha256').notNull(),
    mode: text('mode').notNull(),
    requestSha256: text('request_sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.attemptId] }),
    uniqueIndex('warmup_v2_purpose_identity').on(t.attemptId),
  ],
);
export const walletWarmupSessionV2RuntimeObservations = sqliteTable(
  'wallet_warmup_session_v2_runtime_observations',
  {
    ownerId: text('owner_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    purposeSha256: text('purpose_sha256').notNull(),
    packetSha256: text('packet_sha256').notNull(),
    document: text('document').notNull(),
    documentSha256: text('document_sha256').notNull(),
    outcomeSha256: text('outcome_sha256').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.attemptId] }),
    uniqueIndex('warmup_v2_runtime_packet').on(t.ownerId, t.packetSha256),
  ],
);
export * from './auth-schema';
export * from './auto-buy-budget-schema';
