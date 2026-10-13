import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
export const conditionalMonitorJobs = sqliteTable(
  'conditional_monitor_jobs',
  {
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull(),
    projectRevision: integer('project_revision').notNull(),
    enabled: integer('enabled').notNull(),
    nextCheckAt: integer('next_check_at').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    lastCheckedAt: integer('last_checked_at'),
    lastRunId: text('last_run_id'),
    matchKeys: text('match_keys').notNull().default('[]'),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.projectId] }),
    index('conditional_monitor_due').on(t.enabled, t.nextCheckAt, t.leaseUntil),
  ],
);
export const conditionalMonitorNotices = sqliteTable(
  'conditional_monitor_notices',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    document: text('document').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('conditional_monitor_notice_scope').on(
      t.ownerId,
      t.projectId,
      t.sequence,
    ),
  ],
);
export const conditionalMonitorRuntime = sqliteTable(
  'conditional_monitor_runtime',
  {
    name: text('name').primaryKey(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
);
