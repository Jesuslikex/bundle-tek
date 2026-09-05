import { type ReceiptState } from './receipt';
import { PonsError, type Intent, validateIntent } from './intent';
export const schema = [
  `CREATE TABLE IF NOT EXISTS pons_jobs (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'created' CHECK(state IN ('created','simulating','simulated','simulation_failed','submitted','confirming','confirmed','reverted','reorged')),revision INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner_id,idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS pons_events (job_id TEXT NOT NULL,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,result TEXT,PRIMARY KEY(job_id,revision))`,
  `CREATE TRIGGER IF NOT EXISTS pons_created AFTER INSERT ON pons_jobs BEGIN INSERT INTO pons_events VALUES(NEW.id,NEW.owner_id,NEW.revision,NEW.state,NEW.updated_at,NEW.result); END`,
  `CREATE TRIGGER IF NOT EXISTS pons_updated AFTER UPDATE ON pons_jobs BEGIN INSERT INTO pons_events VALUES(NEW.id,NEW.owner_id,NEW.revision,NEW.state,NEW.updated_at,NEW.result); END`,
  `CREATE TRIGGER IF NOT EXISTS pons_immutable BEFORE UPDATE ON pons_jobs WHEN NEW.intent != OLD.intent OR NEW.owner_id != OLD.owner_id OR NEW.id != OLD.id OR NEW.idempotency_key != OLD.idempotency_key OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision+1 BEGIN SELECT RAISE(ABORT,'immutable intent or invalid revision'); END`,
];
export type Job = {
  id: string;
  owner_id: string;
  idempotency_key: string;
  intent: string;
  state:
    | 'created'
    | 'simulating'
    | 'simulated'
    | 'simulation_failed'
    | ReceiptState;
  revision: number;
  lease_token: string | null;
  lease_until: number | null;
  result: string | null;
  created_at: number;
  updated_at: number;
};
export class PonsStore {
  constructor(private db: D1Database) {}
  async ensure() {
    await this.db.batch(schema.map((s) => this.db.prepare(s)));
  }
  async create(owner: string, key: string, intent: Intent) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new PonsError(400, 'INVALID_IDEMPOTENCY_KEY');
    const payload = JSON.stringify(validateIntent(intent));
    const now = Date.now();
    await this.db
      .prepare(
        'INSERT INTO pons_jobs(id,owner_id,idempotency_key,intent,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',
      )
      .bind(crypto.randomUUID(), owner, key, payload, now, now)
      .run();
    const job = await this.db
      .prepare('SELECT * FROM pons_jobs WHERE owner_id=? AND idempotency_key=?')
      .bind(owner, key)
      .first<Job>();
    if (!job) throw new PonsError(503, 'STORAGE_FAILURE');
    if (job.intent !== payload)
      throw new PonsError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    return job;
  }
  async get(owner: string, id: string) {
    const job = await this.db
      .prepare('SELECT * FROM pons_jobs WHERE owner_id=? AND id=?')
      .bind(owner, id)
      .first<Job>();
    if (!job) throw new PonsError(404, 'JOB_NOT_FOUND');
    return job;
  }
  async claim(owner: string, id: string, revision: number, now = Date.now()) {
    await this.get(owner, id);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new PonsError(400, 'INVALID_REVISION');
    const token = crypto.randomUUID();
    const result = await this.db
      .prepare(
        `UPDATE pons_jobs SET state='simulating', revision=revision+1,lease_token=?,lease_until=?,result=NULL,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND (state IN ('created','simulation_failed','simulated') OR (state='simulating' AND lease_until<=?)) RETURNING *`,
      )
      .bind(token, now + 120000, now, owner, id, revision, now)
      .first<Job>();
    if (!result) throw new PonsError(409, 'REVISION_OR_LEASE_CONFLICT');
    const current = await this.get(owner, id);
    if (current.lease_token !== token || current.revision !== result.revision)
      throw new PonsError(409, 'CLAIM_SUPERSEDED');
    // Return the row owned by this claim, never a different worker's readback.
    return result;
  }
  async finish(
    owner: string,
    id: string,
    revision: number,
    token: string,
    outcome: { ok: boolean; [key: string]: unknown },
    now = Date.now(),
  ) {
    const result = await this.db
      .prepare(
        `UPDATE pons_jobs SET state=?,revision=revision+1,lease_token=NULL,lease_until=NULL,result=?,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND state='simulating' AND lease_token=? AND lease_until>? RETURNING *`,
      )
      .bind(
        outcome.ok ? 'simulated' : 'simulation_failed',
        JSON.stringify(outcome),
        now,
        owner,
        id,
        revision,
        token,
        now,
      )
      .first<Job>();
    if (!result) throw new PonsError(409, 'STALE_SIMULATION_LEASE');
    return this.get(owner, id);
  }
  async recordReceipt(
    owner: string,
    id: string,
    revision: number,
    state: ReceiptState,
    result: Record<string, unknown>,
  ) {
    const written = await this.db
      .prepare(
        `UPDATE pons_jobs SET state=?,revision=revision+1,result=?,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND state IN ('simulated','submitted','confirming','confirmed','reverted','reorged') RETURNING *`,
      )
      .bind(state, JSON.stringify(result), Date.now(), owner, id, revision)
      .first<Job>();
    if (!written) throw new PonsError(409, 'REVISION_OR_STATE_CONFLICT');
    return this.get(owner, id);
  }
  async events(owner: string, id: string) {
    await this.get(owner, id);
    return (
      await this.db
        .prepare(
          'SELECT revision,state,created_at,result FROM pons_events WHERE owner_id=? AND job_id=? ORDER BY revision DESC LIMIT 100',
        )
        .bind(owner, id)
        .all()
    ).results;
  }
}
