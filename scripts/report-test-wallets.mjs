// One-off: report the local test wallets and their recorded balances.
import { createClient } from '@libsql/client';
import { resolve } from 'node:path';

const db = createClient({ url: 'file:' + resolve('dev.db') });
const wallets = await db.execute(
  'SELECT address,label,role,archived,tags FROM workspace_wallets ORDER BY label',
);
for (const w of wallets.rows)
  console.log(
    [w.label, w.role, w.archived ? 'archived' : 'active', w.tags].join(' | '),
  );
const balances = await db.execute(
  'SELECT wallet_address,lamports,observed_at FROM wallet_balance_snapshots ORDER BY observed_at DESC LIMIT 8',
).catch(() => ({ rows: [] }));
console.log('--- recent balance snapshots ---');
for (const b of balances.rows)
  console.log(b.wallet_address, b.lamports, b.observed_at);
