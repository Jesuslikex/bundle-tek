import { UUID } from './wallet-operation';
import { projectWarmupOperation } from './token-warmup-operation';
import {
  validatedWithdrawalActivity,
  withdrawalActivityLabel,
  withdrawalActivityDetail,
} from './withdrawal-activity';
import {
  decodeConditionalOrder,
  conditionalOrderSide,
} from './conditional-order';
import {
  decodeSessionJobEvent,
  sessionJobLabels,
  sessionJobEventDetail,
} from './session-preparation-job-events';
import {
  isImportedSigningEvent,
  importedSigningEventLabel,
} from './imported-signing-events';
import {
  decodeTradeSessionEvent,
  sessionEventLabels,
  sessionEventDetail,
} from './imported-trade-session-events';
import {
  isJitoBundleEvent,
  jitoBundleEventLabel,
  jitoBundleEventDetail,
} from './jito-bundle-events';

import type { TokenOperation } from './token-operation-history';
import {
  historyCursor,
  historySources,
  type HistorySource,
  type OperationCategory,
  type OperationRow,
} from './token-operation-history';
const sources: Record<
  HistorySource,
  {
    table: string;
    select: string;
    condition?: string;
    required?: string[];
    from?: string;
    scope?: string;
  }
> = {
  project: {
    table: 'imported_token_project_events',
    select: `id,'project' AS source,'Project' AS category,revision AS ordinal,created_at AS createdAt,json_object('id',id,'projectId',project_id,'createdAt',created_at,'type',type,'revision',revision) AS payload`,
  },
  preparation: {
    table: 'imported_swap_preparations',
    select: `id,'preparation' AS source,'Preparation' AS category,0 AS ordinal,created_at AS createdAt,json_object('id',id,'projectId',project_id,'createdAt',created_at,'projectRevision',project_revision,'document',document) AS payload`,
  },
  signing: {
    table: 'imported_swap_signing_events',
    select: `id,'signing' AS source,json_extract(document,'$.side') AS category,sequence AS ordinal,created_at AS createdAt,json_object('id',id,'sequence',sequence,'projectId',project_id,'createdAt',created_at,'intentId',intent_id,'preparationId',preparation_id,'projectRevision',project_revision,'walletRevision',wallet_revision,'wallet',wallet_address,'type',type,'state',state,'signature',signature,'failureReceipt',failure_receipt,'document',document) AS payload`,
  },
  session: {
    table: 'imported_trade_session_events',
    condition: ` AND type LIKE 'session.%'`,
    select: `id,'session' AS source,'Session' AS category,sequence AS ordinal,created_at AS createdAt,json_object('id',id,'sequence',sequence,'projectId',project_id,'createdAt',created_at,'sessionId',session_id,'type',type,'document',document,'approval',approval,'control',control) AS payload`,
  },
  bundle: {
    table: 'jito_bundle_events',
    select: `id,'bundle' AS source,'Bundle' AS category,sequence AS ordinal,created_at AS createdAt,json_object('id',id,'sequence',sequence,'projectId',project_id,'createdAt',created_at,'sessionId',session_id,'bundleId',bundle_id,'type',type,'packet',packet,'document',document) AS payload`,
  },
  job: {
    table: 'session_preparation_job_events',
    select: `id,'job' AS source,'Jobs' AS category,sequence AS ordinal,created_at AS createdAt,json_object('id',id,'sequence',sequence,'projectId',project_id,'createdAt',created_at,'sessionId',session_id,'jobId',job_id,'document',document,'sessionRecord',__SESSION_RECORD__) AS payload`,
  },
  conditional: {
    table: 'conditional_order_events',
    select: `id,'conditional' AS source,'Conditional' AS category,sequence AS ordinal,created_at AS createdAt,json_object('id',id,'sequence',sequence,'projectId',project_id,'orderId',order_id,'type',type,'createdAt',created_at,'document',document) AS payload`,
  },
  withdrawal: {
    table: 'native_withdrawal_events',
    required: ['native_withdrawals'],
    from: 'native_withdrawal_events e JOIN native_withdrawals w ON w.owner_id=e.owner_id AND w.id=e.intent_id AND w.wallet_address=e.wallet_address JOIN imported_token_projects p ON p.owner_id=e.owner_id',
    scope: `e.owner_id=? AND p.id=? AND p.chain='Solana' AND json_extract(w.document,'$.token.mint')=p.address`,
    select: `printf('%032x',e.sequence) AS id,'withdrawal' AS source,'Withdrawals' AS category,e.sequence AS ordinal,e.created_at AS createdAt,json_object('id',printf('%032x',e.sequence),'projectId',p.id,'selectedMint',p.address,'sequence',e.sequence,'createdAt',e.created_at,'withdrawalId',w.id,'wallet',w.wallet_address,'walletRevision',w.wallet_revision,'state',e.state,'signature',e.signature,'document',w.document,'receipt',CASE WHEN e.state='finalized' THEN w.receipt ELSE NULL END,'failureReceipt',e.failure_receipt,'withdrawalCreatedAt',w.created_at) AS payload`,
  },
  warmup: {
    table: 'warmup_signing_events',
    required: ['warmup_swap_preparations', 'warmup_signing_intents'],
    from: 'warmup_signing_events e JOIN imported_token_projects p ON p.owner_id=e.owner_id LEFT JOIN warmup_swap_preparations w ON w.owner_id=e.owner_id AND w.id=e.preparation_id LEFT JOIN warmup_signing_intents i ON i.owner_id=e.owner_id AND i.id=e.intent_id',
    scope: `e.owner_id=? AND p.id=? AND p.chain='Solana' AND CASE json_extract(e.document,'$.side') WHEN 'Buy' THEN json_extract(e.document,'$.outputMint') ELSE json_extract(e.document,'$.inputMint') END=p.address AND (i.id IS NULL OR json_extract(i.document,'$.network') IS NOT 'devnet' OR e.failure_receipt IS NOT NULL)`,
    select: `e.id AS id,'warmup' AS source,'Warmup' AS category,e.sequence AS ordinal,e.created_at AS createdAt,json_object('id',e.id,'projectId',p.id,'selectedMint',p.address,'sequence',e.sequence,'createdAt',e.created_at,'intentId',e.intent_id,'preparationId',e.preparation_id,'planId',e.plan_id,'planRevision',e.plan_revision,'cycle',e.cycle,'wallet',e.wallet_address,'type',e.type,'state',e.state,'signature',e.signature,'failureReceipt',e.failure_receipt,'document',e.document,'preparation',CASE WHEN w.id IS NULL THEN NULL ELSE json_object('id',w.id,'planId',w.plan_id,'planRevision',w.plan_revision,'cycle',w.cycle,'wallet',w.wallet_address,'walletRevision',w.wallet_revision,'document',w.document,'createdAt',w.created_at) END,'intent',CASE WHEN i.id IS NULL THEN NULL ELSE json_object('id',i.id,'preparationId',i.preparation_id,'wallet',i.wallet_address,'documentId',json_extract(i.document,'$.id'),'documentPreparationId',json_extract(i.document,'$.preparationId'),'documentWallet',json_extract(i.document,'$.wallet'),'signature',i.signature,'maximumFeeLamports',json_extract(i.document,'$.maximumFeeLamports'),'network',json_extract(i.document,'$.network'),'sha256',json_extract(i.document,'$.sha256'),'inputMint',json_extract(i.document,'$.inputMint'),'outputMint',json_extract(i.document,'$.outputMint'),'inputRaw',json_extract(i.document,'$.inputRaw'),'minimumOutputRaw',json_extract(i.document,'$.minimumOutputRaw'),'createdAt',i.created_at) END,'successfulReceipt',__WARMUP_RECEIPT__,'linkedBuyReceipt',__WARMUP_LINKED_BUY__) AS payload`,
  },
};

// These summaries are optional evidence. Missing receipt tables must not hide
// immutable approval events, and earlier states never acquire a later receipt.
function warmupReceiptSelections(tables: ReadonlySet<string>) {
  const buy = tables.has('warmup_buy_receipts');
  const sell = tables.has('warmup_sell_receipts');
  const buyFields = (alias: string) =>
    `json_object('id',${alias}.id,'preparationId',${alias}.preparation_id,'planId',${alias}.plan_id,'planRevision',${alias}.plan_revision,'cycle',${alias}.cycle,'wallet',${alias}.wallet_address,'walletRevision',${alias}.wallet_revision,'signature',${alias}.signature,'document',${alias}.document,'createdAt',${alias}.created_at)`;
  const buyReceipt = buy
    ? `(SELECT ${buyFields('r')} FROM warmup_buy_receipts r WHERE r.owner_id=e.owner_id AND r.preparation_id=e.preparation_id LIMIT 1)`
    : 'NULL';
  const sellReceipt = sell
    ? `(SELECT json_object('id',r.id,'preparationId',r.preparation_id,'planId',r.plan_id,'buyReceiptId',r.buy_receipt_id,'signature',r.signature,'consumedRaw',r.consumed_raw,'document',r.document,'createdAt',r.created_at) FROM warmup_sell_receipts r WHERE r.owner_id=e.owner_id AND r.preparation_id=e.preparation_id LIMIT 1)`
    : 'NULL';
  return {
    receipt: `CASE WHEN e.state='finalized' THEN CASE json_extract(e.document,'$.side') WHEN 'Buy' THEN ${buyReceipt} WHEN 'Sell' THEN ${sellReceipt} END ELSE NULL END`,
    linkedBuy:
      buy && sell
        ? `CASE WHEN e.state='finalized' AND json_extract(e.document,'$.side')='Sell' THEN (SELECT ${buyFields('b')} FROM warmup_sell_receipts r JOIN warmup_buy_receipts b ON b.owner_id=r.owner_id AND b.id=r.buy_receipt_id WHERE r.owner_id=e.owner_id AND r.preparation_id=e.preparation_id LIMIT 1) ELSE NULL END`
        : 'NULL',
  };
}
export async function readTokenOperations(
  db: D1Database,
  owner: string,
  projectId: string,
  category: OperationCategory,
  cursor: string | null,
) {
  const tableNames = [
    ...new Set([
      ...historySources.flatMap((s) => [
        sources[s].table,
        ...(sources[s].required ?? []),
      ]),
      'warmup_buy_receipts',
      'warmup_sell_receipts',
    ]),
  ];
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tableNames.map(() => '?').join(',')})`,
    )
    .bind(...tableNames)
    .all<{ name: string }>();
  const available = historySources.filter((s) =>
    [sources[s].table, ...(sources[s].required ?? [])].every((name) =>
      tables.results.some((t) => t.name === name),
    ),
  );
  const missingSources = historySources.filter((s) => !available.includes(s));
  if (!available.length) {
    if (cursor) throw new Error('Cursor unavailable.');
    return {
      projectId,
      category,
      executionAllowed: false as const,
      records: [],
      missingSources,
      nextCursor: null,
    };
  }
  const categories: Record<HistorySource, readonly OperationCategory[]> = {
    project: ['Project'],
    preparation: ['Preparation'],
    signing: ['Buy', 'Sell'],
    session: ['Session'],
    bundle: ['Bundle'],
    job: ['Jobs'],
    conditional: ['Conditional'],
    warmup: ['Warmup'],
    withdrawal: ['Withdrawals'],
  };
  const selected = available.filter(
    (s) => category === 'All' || categories[s].includes(category),
  );
  const warmupReceipts = warmupReceiptSelections(
    new Set(tables.results.map((table) => table.name)),
  );
  const selection = (s: HistorySource) =>
    `SELECT ${sources[s].select
      .replace(
        '__SESSION_RECORD__',
        available.includes('session')
          ? `(SELECT json_object('id',e.id,'sequence',e.sequence,'projectId',e.project_id,'sessionId',e.session_id,'type',e.type,'createdAt',e.created_at,'document',e.document,'approval',e.approval,'control',e.control) FROM imported_trade_session_events e WHERE e.owner_id=session_preparation_job_events.owner_id AND e.project_id=session_preparation_job_events.project_id AND e.session_id=session_preparation_job_events.session_id AND e.type IN ('session.saved','session.baseline') ORDER BY e.sequence ASC LIMIT 1)`
          : 'NULL',
      )
      .replace('__WARMUP_RECEIPT__', warmupReceipts.receipt)
      .replace(
        '__WARMUP_LINKED_BUY__',
        warmupReceipts.linkedBuy,
      )} FROM ${sources[s].from ?? sources[s].table} WHERE ${sources[s].scope ?? 'owner_id=? AND project_id=?'}${sources[s].condition ?? ''}`;
  let anchor: OperationRow | null = null;
  if (cursor) {
    const cursorSource = cursor.split(':')[0] as HistorySource;
    if (!selected.includes(cursorSource)) return null;
    anchor = await db
      .prepare(
        `WITH selected AS (${selection(cursorSource)}) SELECT * FROM selected WHERE (?='All' OR category=?) AND source||':'||id=?`,
      )
      .bind(owner, projectId, category, category, cursor)
      .first<OperationRow>();
    if (!anchor) return null;
    await projectOperation(anchor, projectId);
  }
  if (!selected.length)
    return {
      projectId,
      category,
      executionAllowed: false as const,
      records: [],
      missingSources,
      nextCursor: null,
    };
  const boundary = anchor
    ? ' AND (createdAt<? OR (createdAt=? AND (source<? OR (source=? AND (ordinal<? OR (ordinal=? AND id<?))))))'
    : '';
  const boundaryBinds = anchor
    ? [
        anchor.createdAt,
        anchor.createdAt,
        anchor.source,
        anchor.source,
        anchor.ordinal,
        anchor.ordinal,
        anchor.id,
      ]
    : [];
  const order =
    ' ORDER BY createdAt DESC,source DESC,ordinal DESC,id DESC LIMIT 51';
  // At most 51 rows from each source can contribute to the global top 51.
  // Apply category/cursor bounds before materialization, including on older pages.
  const selections = selected.map(
    (s) =>
      `SELECT * FROM (SELECT * FROM (${selection(s)}) WHERE (?='All' OR category=?)${boundary}${order})`,
  );
  const binds = selected.flatMap(() => [
    owner,
    projectId,
    category,
    category,
    ...boundaryBinds,
  ]);
  // Workerd bounds compound SELECT terms more tightly than native SQLite.
  const groups: string[] = [];
  let level = selections;
  while (level.length > 4) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += 4) {
      const name = `history_group_${groups.length}`;
      groups.push(
        `${name} AS MATERIALIZED (${level.slice(start, start + 4).join(' UNION ALL ')})`,
      );
      next.push(`SELECT * FROM ${name}`);
    }
    level = next;
  }
  const scope = `WITH ${groups.length ? groups.join(',') + ',' : ''}history AS (${level.join(' UNION ALL ')}) `;
  const rows = await db
    .prepare(scope + 'SELECT * FROM history' + order)
    .bind(...binds)
    .all<OperationRow>();
  const decoded = await Promise.all(
    rows.results.map((r) => projectOperation(r, projectId)),
  );
  const records = decoded.slice(0, 50);
  return {
    projectId,
    category,
    executionAllowed: false as const,
    records,
    missingSources,
    nextCursor:
      decoded.length > 50
        ? historyCursor(projectId, category, records.at(-1)!.key)
        : null,
  };
}

const projectLabels: Record<string, string> = {
  'project.import': 'Token imported',
  'project.refresh': 'Identity refreshed',
  'project.archive': 'Project archived',
  'project.restore': 'Project restored',
  'project.settings': 'Trade settings saved',
};
export async function projectOperation(
  row: OperationRow,
  projectId: string,
): Promise<TokenOperation> {
  if (
    !UUID.test(projectId) ||
    !(UUID.test(row.id) || /^[a-f0-9]{32}$/.test(row.id)) ||
    !historySources.includes(row.source) ||
    !Number.isSafeInteger(row.ordinal) ||
    row.ordinal < 0 ||
    typeof row.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    new Date(row.createdAt).toISOString() !== row.createdAt
  )
    throw new Error('Invalid operation identity.');
  const p = JSON.parse(row.payload);
  if (
    !p ||
    p.projectId !== projectId ||
    p.id !== row.id ||
    p.createdAt !== row.createdAt
  )
    throw new Error('Operation context differs.');
  const base = {
    key: `${row.source}:${row.id}`,
    projectId,
    source: row.source,
    category: row.category,
    createdAt: row.createdAt,
    signature: null as string | null,
  };
  if (row.source === 'warmup') return projectWarmupOperation(row, p, base);
  if (row.source === 'withdrawal') {
    const event = await validatedWithdrawalActivity({
      sequence: p.sequence,
      createdAt: p.createdAt,
      withdrawal: {
        id: p.withdrawalId,
        wallet: p.wallet,
        walletRevision: p.walletRevision,
        state: p.state,
        signature: p.signature,
        document: JSON.parse(p.document),
        receipt: p.receipt ? JSON.parse(p.receipt) : null,
        failureReceipt: p.failureReceipt ? JSON.parse(p.failureReceipt) : null,
        createdAt: p.withdrawalCreatedAt,
        updatedAt: p.createdAt,
      },
    });
    if (
      event.sequence !== row.ordinal ||
      row.category !== 'Withdrawals' ||
      !event.withdrawal.document.token ||
      event.withdrawal.document.token.mint !== p.selectedMint
    )
      throw new Error('Token withdrawal history differs.');
    return {
      ...base,
      label: withdrawalActivityLabel(event.withdrawal.state),
      state: event.withdrawal.state,
      signature: event.withdrawal.signature,
      details: [
        withdrawalActivityDetail(event),
        'Attributed by the retained token mint. This does not establish that the action was started in this project. Account-wide SOL withdrawals are excluded.',
      ],
    };
  }
  if (row.source === 'conditional') {
    const order = decodeConditionalOrder(JSON.parse(p.document));
    if (
      p.sequence !== row.ordinal ||
      row.category !== 'Conditional' ||
      order.id !== p.orderId ||
      order.terms.projectId !== projectId ||
      order.updatedAt !== row.createdAt ||
      p.type !== (order.state === 'draft' ? 'order.saved' : 'order.cancelled')
    )
      throw new Error('Conditional history differs.');
    return {
      ...base,
      label:
        order.state === 'draft'
          ? 'Conditional order saved'
          : 'Conditional order cancelled',
      state: order.state,
      details: [
        `Order ${order.id}; revision ${order.revision}; ${order.terms.kind} ${conditionalOrderSide(order).toLowerCase()} with ${order.terms.levels.length} levels`,
        `Wallet ${order.terms.wallet}; wallet revision ${order.terms.walletRevision}; ${order.terms.totalRaw} atomic ${conditionalOrderSide(order) === 'Buy' ? 'SOL input' : 'token'} units`,
        ...order.terms.levels.map(
          (level) =>
            `Level ${level.level}: ${level.unitsRaw} atomic units at ${level.targetUsd} USD`,
        ),
        'Order configuration is not trigger evidence, signing approval or execution. Earlier order transitions were not reconstructed.',
      ],
    };
  }
  if (row.source === 'job') {
    const e = decodeSessionJobEvent({ ...p, document: JSON.parse(p.document) });
    if (e.sequence !== row.ordinal || row.category !== 'Jobs')
      throw new Error('Job event differs.');
    let walletDetail =
      'Wallet mapping unavailable; this event retains a session entry number.';
    if (p.sessionRecord !== null) {
      const r = JSON.parse(p.sessionRecord);
      const session = decodeTradeSessionEvent({
        ...r,
        document: JSON.parse(r.document),
        approval: r.approval ? JSON.parse(r.approval) : null,
        control: r.control ? JSON.parse(r.control) : null,
      });
      const entry = session.document.terms.entries.find(
        (item) => item.entry === e.document.entry,
      );
      if (
        session.projectId !== projectId ||
        session.sessionId !== e.sessionId ||
        !['session.saved', 'session.baseline'].includes(session.type) ||
        !entry ||
        Date.parse(session.document.createdAt) > Date.parse(e.createdAt)
      )
        throw new Error('Retained job wallet mapping differs.');
      walletDetail = `Wallet ${entry.wallet}; wallet revision ${entry.walletRevision}; ${entry.unitsRaw} atomic input units. Mapping comes from retained session terms.`;
    }
    return {
      ...base,
      label: sessionJobLabels[e.document.state],
      state: e.document.state,
      details: [
        sessionJobEventDetail(e),
        walletDetail,
        'Unsigned preparation outcome; this job does not sign, submit or prove a trade.',
      ],
    };
  }
  if (row.source === 'signing') {
    p.document = JSON.parse(p.document);
    p.failureReceipt = p.failureReceipt ? JSON.parse(p.failureReceipt) : null;
    if (
      !isImportedSigningEvent(p) ||
      p.sequence !== row.ordinal ||
      p.document.side !== row.category
    )
      throw new Error('Signing event differs.');
    return {
      ...base,
      label: `${p.document.side}: ${p.state === 'failed' && !p.failureReceipt ? 'Failed approval recorded' : importedSigningEventLabel(p.type)}`,
      state: p.state,
      signature: p.signature,
      details: [
        `Wallet ${p.wallet}`,
        `Input ${p.document.inputRaw} atomic units; minimum output ${p.document.minimumOutputRaw} atomic units`,
        `Approval ${p.intentId}; preparation ${p.preparationId}`,
        ...(p.type === 'approval.baseline'
          ? ['Retained state; earlier transitions were not reconstructed.']
          : []),
        ...(p.failureReceipt
          ? [
              'Finalized failure evidence retained; this is not a successful swap.',
            ]
          : []),
        ...(p.state === 'failed' && !p.failureReceipt
          ? [
              'This event has no retained failure receipt; failure evidence is not established by this view.',
            ]
          : []),
      ],
    };
  }
  if (row.source === 'session') {
    const e = decodeTradeSessionEvent({
      ...p,
      document: JSON.parse(p.document),
      approval: p.approval ? JSON.parse(p.approval) : null,
      control: p.control ? JSON.parse(p.control) : null,
    });
    if (
      !e.type.startsWith('session.') ||
      e.sequence !== row.ordinal ||
      row.category !== 'Session'
    )
      throw new Error('Session event differs.');
    return {
      ...base,
      label: sessionEventLabels[e.type],
      state: e.document.state,
      sessionEventId: e.id,
      details: [sessionEventDetail(e)],
    };
  }
  if (row.source === 'bundle') {
    p.document = JSON.parse(p.document);
    if (
      !isJitoBundleEvent(p) ||
      p.sequence !== row.ordinal ||
      row.category !== 'Bundle'
    )
      throw new Error('Bundle event differs.');
    return {
      ...base,
      label: jitoBundleEventLabel(p),
      state: p.document.state,
      details: [jitoBundleEventDetail(p)],
    };
  }
  if (row.source === 'project') {
    if (
      !Object.hasOwn(projectLabels, p.type) ||
      !Number.isSafeInteger(p.revision) ||
      p.revision < 1 ||
      p.revision !== row.ordinal ||
      row.category !== 'Project'
    )
      throw new Error('Project event differs.');
    return {
      ...base,
      label: projectLabels[p.type],
      state: 'recorded',
      details: [
        `Project revision ${p.revision}; identity/settings record, not a trade receipt.`,
      ],
    };
  }
  const d = JSON.parse(p.document);
  if (
    d.executionAllowed !== false ||
    !['Buy', 'Sell'].includes(d.side) ||
    row.category !== 'Preparation' ||
    typeof d.wallet !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(d.inAmountRaw) ||
    BigInt(d.inAmountRaw) > (1n << 64n) - 1n ||
    typeof d.simulation?.succeeded !== 'boolean' ||
    !Number.isSafeInteger(p.projectRevision) ||
    p.projectRevision < 1
  )
    throw new Error('Preparation event differs.');
  return {
    ...base,
    label: `${d.side} preparation saved`,
    state: d.simulation.succeeded ? 'simulated' : 'simulation_failed',
    details: [
      `Wallet ${d.wallet}; project revision ${p.projectRevision}`,
      `Input ${d.inAmountRaw} atomic units`,
      'Unsigned preparation; simulation does not establish signing, submission or execution.',
    ],
  };
}
