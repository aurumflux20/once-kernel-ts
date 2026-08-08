/**
 * Durable store on SQLite, via Node's built-in `node:sqlite` — no dependency.
 *
 * This is the store that makes the library worth having. An in-memory guard
 * handles two simultaneous calls, which is the easy half; it loses everything
 * on the crash that happens *between* reserving a key and finishing the effect,
 * which is the half that actually costs money. Veridex's own idempotency module
 * ships in-memory and says "swap this for postgres/redis in production" — this
 * is that swap, written rather than left to the reader.
 *
 * Atomicity comes from SQLite, not from application logic. Every mutation is a
 * single statement with its guard in the WHERE clause, so two processes racing
 * the same key resolve inside the database engine. Read-then-write in JavaScript
 * would be a time-of-check-to-time-of-use bug — precisely the one this library
 * exists to prevent, and one it would be embarrassing to ship.
 */

import { DatabaseSync } from "node:sqlite";
import type { Record_, Status, Store } from "../kernel.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS once_records (
  key              TEXT PRIMARY KEY,
  payload_hash     TEXT NOT NULL,
  status           TEXT NOT NULL,
  fence_token      TEXT NOT NULL,
  result_json      TEXT,
  error            TEXT,
  created_at       REAL NOT NULL,
  updated_at       REAL NOT NULL,
  expires_at       REAL,
  lease_expires_at REAL,
  generation       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS once_records_expires_at ON once_records (expires_at);
`;

interface Row {
  key: string;
  payload_hash: string;
  status: string;
  fence_token: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  lease_expires_at: number | null;
  generation: number;
}

const toRecord = (r: Row): Record_ => ({
  key: r.key,
  payloadHash: r.payload_hash,
  status: r.status as Status,
  fenceToken: r.fence_token,
  result: r.result_json === null ? undefined : JSON.parse(r.result_json),
  error: r.error ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at ?? undefined,
  leaseExpiresAt: r.lease_expires_at ?? undefined,
  generation: r.generation,
});

const now = () => Date.now() / 1000;

export interface SqliteStoreOptions {
  /** File path, or ":memory:" for tests. */
  path?: string;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(opts: SqliteStoreOptions = {}) {
    this.db = new DatabaseSync(opts.path ?? ":memory:");
    // WAL lets readers proceed during a write, and survives process death
    // better than the rollback journal. NORMAL sync is the standard pairing:
    // durable across process crashes, which is the failure we care about.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    // Without a busy timeout, a concurrent writer fails instantly with
    // SQLITE_BUSY instead of waiting its turn — which would surface as a
    // spurious "already in progress" rather than a queued claim.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  async get(key: string): Promise<Record_ | undefined> {
    const row = this.db
      .prepare("SELECT * FROM once_records WHERE key = ?")
      .get(key) as Row | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && now() >= row.expires_at) return undefined;
    return toRecord(row);
  }

  /**
   * Claim the key, atomically.
   *
   * One statement: insert if absent, or take over an EXPIRED record and bump
   * its generation. The WHERE on the upsert branch is what makes this safe —
   * if a live record holds the key, no row is written and none is returned,
   * so the caller learns it lost without ever reading first.
   */
  async createInProgress(rec: Record_): Promise<Record_ | undefined> {
    const row = this.db
      .prepare(
        `INSERT INTO once_records
           (key, payload_hash, status, fence_token, result_json, error,
            created_at, updated_at, expires_at, lease_expires_at, generation)
         VALUES (?, ?, 'in_progress', ?, NULL, NULL, ?, ?, ?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           payload_hash     = excluded.payload_hash,
           status           = 'in_progress',
           fence_token      = excluded.fence_token,
           result_json      = NULL,
           error            = NULL,
           created_at       = excluded.created_at,
           updated_at       = excluded.updated_at,
           expires_at       = excluded.expires_at,
           lease_expires_at = excluded.lease_expires_at,
           generation       = once_records.generation + 1
         WHERE once_records.expires_at IS NOT NULL
           AND once_records.expires_at <= ?
         RETURNING *`,
      )
      .get(
        rec.key,
        rec.payloadHash,
        rec.fenceToken,
        rec.createdAt,
        rec.updatedAt,
        rec.expiresAt ?? null,
        rec.leaseExpiresAt ?? null,
        now(),
      ) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  async casComplete(
    key: string,
    fenceToken: string,
    result: unknown,
    expiresAt?: number,
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE once_records
            SET status = 'completed', result_json = ?, error = NULL,
                updated_at = ?, expires_at = ?, lease_expires_at = NULL
          WHERE key = ? AND fence_token = ? AND status = 'in_progress'`,
      )
      .run(JSON.stringify(result ?? null), now(), expiresAt ?? null, key, fenceToken);
    return Number(r.changes) === 1;
  }

  async casFail(
    key: string,
    fenceToken: string,
    error: string,
    allowRetry: boolean,
  ): Promise<boolean> {
    if (allowRetry) {
      // Free the key so the SAME payload can be retried. Holding it would turn
      // a transient network blip into a permanently un-runnable operation.
      const r = this.db
        .prepare(
          `DELETE FROM once_records
            WHERE key = ? AND fence_token = ? AND status = 'in_progress'`,
        )
        .run(key, fenceToken);
      return Number(r.changes) === 1;
    }
    const r = this.db
      .prepare(
        `UPDATE once_records
            SET status = 'failed', error = ?, updated_at = ?, lease_expires_at = NULL
          WHERE key = ? AND fence_token = ? AND status = 'in_progress'`,
      )
      .run(error.slice(0, 2048), now(), key, fenceToken);
    return Number(r.changes) === 1;
  }

  /** Take over a key whose lease is dead. The lease check is in the WHERE, so
   *  two rescuers racing produce exactly one winner. */
  async reclaimIfLeaseDead(key: string, rec: Record_): Promise<Record_ | undefined> {
    const row = this.db
      .prepare(
        `UPDATE once_records
            SET fence_token = ?, updated_at = ?, lease_expires_at = ?,
                generation = generation + 1
          WHERE key = ?
            AND status = 'in_progress'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
        RETURNING *`,
      )
      .get(rec.fenceToken, now(), rec.leaseExpiresAt ?? null, key, now()) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  async heartbeat(key: string, fenceToken: string, leaseExpiresAt: number): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE once_records
            SET lease_expires_at = ?, updated_at = ?
          WHERE key = ? AND fence_token = ? AND status = 'in_progress'`,
      )
      .run(leaseExpiresAt, now(), key, fenceToken);
    return Number(r.changes) === 1;
  }

  /** Delete expired records. Not required for correctness — `get` already
   *  treats them as absent — but keeps the table from growing without bound. */
  vacuumExpired(): number {
    const r = this.db
      .prepare("DELETE FROM once_records WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now());
    return Number(r.changes);
  }
}
