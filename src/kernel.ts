/**
 * once — idempotency kernel for side-effecting operations.
 *
 * Port of the Python kernel (once-kernel on PyPI). Semantics are matched
 * deliberately, not approximated: the two implementations share a payload
 * hash (see canonical.ts) so a Python service and a Node service can key the
 * same operation and agree about whether it already ran.
 *
 * The shape is begin → run the effect → complete/fail:
 *
 *   - `begin` either hands you the right to execute, or hands you the result
 *     of the call that already did. Exactly one caller gets `execute: true`.
 *   - A `fenceToken` gates `complete`/`fail`. A worker that stalled, lost its
 *     lease, and woke up late cannot commit over the worker that replaced it.
 *   - `generation` increases on every reclaim. Downstream systems can store
 *     the generation they last accepted and reject anything lower — fencing
 *     for storage we do not control.
 *
 * Why a lease at all: the hard failure is not two simultaneous calls, it is a
 * worker that dies *between* reserving the key and finishing the effect. An
 * in-memory "seen set" leaves that key claimed forever and the effect never
 * runs. The lease expires, the record is reclaimed, and the work proceeds.
 */

import { randomUUID } from "node:crypto";
import { payloadHashHex } from "./canonical.ts";

export { CanonicalizationError, payloadHashHex, canonicalBytes, fingerprint } from "./canonical.ts";

export const MAX_RESULT_BYTES = 65_536;
export const MAX_ERROR_BYTES = 2_048;

export type Status = "in_progress" | "completed" | "failed";

export interface Record_ {
  key: string;
  payloadHash: string;
  status: Status;
  fenceToken: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  /** IN_PROGRESS lease. Past this, another caller may reclaim the key. */
  leaseExpiresAt?: number;
  /** Monotonic per-key fencing generation. Starts at 1; +1 on every reclaim. */
  generation: number;
}

export class IdempotencyConflict extends Error {
  // Written out longhand rather than as constructor parameter properties:
  // that syntax emits code, so Node's strip-only TypeScript cannot run it.
  // Staying strip-only means this package needs no build step at all.
  readonly key: string;
  readonly existingHash: string;
  readonly attemptedHash: string;

  constructor(key: string, existingHash: string, attemptedHash: string) {
    super(
      `idempotency key ${JSON.stringify(key)} was already used with a different ` +
        `payload (stored ${existingHash.slice(0, 12)}…, attempted ` +
        `${attemptedHash.slice(0, 12)}…). Production must not guess which body wins.`,
    );
    this.name = "IdempotencyConflict";
    this.key = key;
    this.existingHash = existingHash;
    this.attemptedHash = attemptedHash;
  }
}

export class InProgressError extends Error {
  readonly key: string;
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs = 100) {
    super(`operation for key ${JSON.stringify(key)} is already in progress`);
    this.name = "InProgressError";
    this.key = key;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ResultTooLarge extends Error {
  constructor(size: number, limit: number) {
    super(
      `result is ${size} bytes, over the ${limit}-byte cap. Store the payload ` +
        `elsewhere and keep a reference in the result.`,
    );
    this.name = "ResultTooLarge";
  }
}

export class WaitTimeout extends Error {
  constructor(key: string, ms: number) {
    super(`timed out after ${ms}ms waiting for key ${JSON.stringify(key)} to settle`);
    this.name = "WaitTimeout";
  }
}

/** Caller-supplied key. Scoping (tenant/route prefixes) is the caller's job. */
export function normalizeKey(key: string): string {
  const v = key.trim();
  if (!v) throw new Error("idempotency key must be non-empty");
  if (v.length > 256) throw new Error("idempotency key max length 256");
  return v;
}

/** Evidence that an operation ran, and what it ran on. */
export interface Receipt {
  key: string;
  status: Status;
  /** SHA-256 of the RFC 8785 canonical payload — proves WHAT ran. */
  payloadHash: string;
  /** 1 normally. Higher means a worker died mid-flight and another took over. */
  generation: number;
  firstSeenAt: string;
  settledAt: string;
  result?: unknown;
  error?: string;
}

export interface Outcome {
  /** True for exactly one caller: the one that must run the effect. */
  execute: boolean;
  record: Record_;
}

/**
 * Storage contract. Every mutating method is a compare-and-swap on
 * `fenceToken` — a stale worker must not be able to overwrite a live one.
 * Implementations must make each method atomic with respect to concurrent
 * callers; that is the entire correctness burden.
 */
export interface Store {
  get(key: string): Promise<Record_ | undefined>;
  /** Claim the key. Returns undefined if a live record already holds it. */
  createInProgress(rec: Record_): Promise<Record_ | undefined>;
  casComplete(key: string, fenceToken: string, result: unknown, expiresAt?: number): Promise<boolean>;
  casFail(key: string, fenceToken: string, error: string, allowRetry: boolean): Promise<boolean>;
  /** Take over a key whose lease has expired. Bumps generation. */
  reclaimIfLeaseDead(key: string, rec: Record_): Promise<Record_ | undefined>;
  heartbeat(key: string, fenceToken: string, leaseExpiresAt: number): Promise<boolean>;
}

const now = () => Date.now() / 1000;

/** Message text for anything thrown — `catch` gives `unknown`, not `Error`. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isExpired(r: Record_, t = now()): boolean {
  return r.expiresAt !== undefined && t >= r.expiresAt;
}

function leaseDead(r: Record_, t = now()): boolean {
  if (r.status !== "in_progress") return false;
  if (r.leaseExpiresAt === undefined) return false;
  return t >= r.leaseExpiresAt;
}

/** In-memory store. Correct within ONE process; loses everything on restart.
 *
 * This is the right default for tests and for a single short-lived CLI, and
 * the wrong one for production — a crash is exactly when you need the record
 * to survive. Use SqliteStore (or a Postgres store) for anything real. Node's
 * single-threaded event loop makes each method below atomic for free; a
 * durable store has to earn that with a transaction.
 */
export class MemoryStore implements Store {
  private readonly recs = new Map<string, Record_>();

  async get(key: string): Promise<Record_ | undefined> {
    const r = this.recs.get(key);
    if (r && isExpired(r)) {
      this.recs.delete(key);
      return undefined;
    }
    return r ? { ...r } : undefined;
  }

  async createInProgress(rec: Record_): Promise<Record_ | undefined> {
    const cur = this.recs.get(rec.key);
    if (cur && !isExpired(cur)) return undefined;
    // A fresh claim over an expired record continues the generation sequence,
    // so a straggler holding an old generation still loses.
    const next = { ...rec, generation: cur ? cur.generation + 1 : 1 };
    this.recs.set(rec.key, next);
    return { ...next };
  }

  async casComplete(key: string, fenceToken: string, result: unknown, expiresAt?: number) {
    const r = this.recs.get(key);
    if (!r || r.fenceToken !== fenceToken || r.status !== "in_progress") return false;
    Object.assign(r, { status: "completed" as Status, result, updatedAt: now(), expiresAt, leaseExpiresAt: undefined });
    return true;
  }

  async casFail(key: string, fenceToken: string, error: string, allowRetry: boolean) {
    const r = this.recs.get(key);
    if (!r || r.fenceToken !== fenceToken || r.status !== "in_progress") return false;
    if (allowRetry) {
      // A soft failure frees the key so the SAME payload may be retried.
      // Keeping it claimed would turn a transient error into a permanent one.
      this.recs.delete(key);
      return true;
    }
    Object.assign(r, { status: "failed" as Status, error: error.slice(0, MAX_ERROR_BYTES), updatedAt: now(), leaseExpiresAt: undefined });
    return true;
  }

  async reclaimIfLeaseDead(key: string, rec: Record_): Promise<Record_ | undefined> {
    const cur = this.recs.get(key);
    if (!cur || !leaseDead(cur)) return undefined;
    const next = { ...rec, generation: cur.generation + 1 };
    this.recs.set(key, next);
    return { ...next };
  }

  async heartbeat(key: string, fenceToken: string, leaseExpiresAt: number) {
    const r = this.recs.get(key);
    if (!r || r.fenceToken !== fenceToken || r.status !== "in_progress") return false;
    r.leaseExpiresAt = leaseExpiresAt;
    r.updatedAt = now();
    return true;
  }
}

export interface OnceOptions {
  store?: Store;
  defaultTtlSec?: number;
  defaultLeaseSec?: number;
  maxResultBytes?: number;
}

export class Once {
  private readonly store: Store;
  private readonly defaultTtlSec?: number;
  private readonly defaultLeaseSec: number;
  private readonly maxResultBytes: number;

  constructor(opts: OnceOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.defaultTtlSec = opts.defaultTtlSec;
    this.defaultLeaseSec = opts.defaultLeaseSec ?? 30;
    this.maxResultBytes = opts.maxResultBytes ?? MAX_RESULT_BYTES;
  }

  /** Claim the key, or report what the winning caller did. */
  async begin(
    key: string,
    payload: unknown,
    opts: { ttlSec?: number; leaseSec?: number } = {},
  ): Promise<Outcome> {
    const k = normalizeKey(key);
    const hash = payloadHashHex(payload);
    const ttl = opts.ttlSec ?? this.defaultTtlSec;
    const lease = opts.leaseSec ?? this.defaultLeaseSec;
    const t = now();

    const fresh = (): Record_ => ({
      key: k,
      payloadHash: hash,
      status: "in_progress",
      fenceToken: randomUUID(),
      createdAt: t,
      updatedAt: t,
      expiresAt: ttl !== undefined ? t + ttl : undefined,
      leaseExpiresAt: t + lease,
      generation: 1,
    });

    const claimed = await this.store.createInProgress(fresh());
    if (claimed) return { execute: true, record: claimed };

    const existing = await this.store.get(k);
    if (!existing) {
      // The holder expired between our claim attempt and this read. One retry
      // is enough: a second miss means someone else legitimately holds it.
      const retry = await this.store.createInProgress(fresh());
      if (retry) return { execute: true, record: retry };
      const again = await this.store.get(k);
      if (!again) throw new InProgressError(k);
      return this.settle(again, k, hash);
    }
    return this.settle(existing, k, hash);
  }

  private async settle(existing: Record_, k: string, hash: string): Promise<Outcome> {
    // Same key, different payload is never a dedupe — it is a bug in the
    // caller, and guessing which body wins is how money moves twice.
    if (existing.payloadHash !== hash) {
      throw new IdempotencyConflict(k, existing.payloadHash, hash);
    }
    if (existing.status === "in_progress") {
      if (leaseDead(existing)) {
        const t = now();
        const taken = await this.store.reclaimIfLeaseDead(k, {
          ...existing,
          fenceToken: randomUUID(),
          updatedAt: t,
          leaseExpiresAt: t + this.defaultLeaseSec,
        });
        if (taken) return { execute: true, record: taken };
      }
      throw new InProgressError(k);
    }
    return { execute: false, record: existing };
  }

  async complete(key: string, fenceToken: string, result: unknown, ttlSec?: number): Promise<boolean> {
    const size = Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
    if (size > this.maxResultBytes) throw new ResultTooLarge(size, this.maxResultBytes);
    const ttl = ttlSec ?? this.defaultTtlSec;
    return this.store.casComplete(normalizeKey(key), fenceToken, result, ttl !== undefined ? now() + ttl : undefined);
  }

  async fail(key: string, fenceToken: string, error: string, allowRetry = true): Promise<boolean> {
    return this.store.casFail(normalizeKey(key), fenceToken, error, allowRetry);
  }

  /**
   * Has this operation already happened? Answers WITHOUT running anything.
   *
   * Until now the only way to find out was to attempt the operation, which is
   * useless during reconciliation: "did we already refund order 4471?" is a
   * question ops and finance ask daily, and attempting a refund to find out is
   * not an acceptable way to answer it.
   *
   * Returns `"unknown"` when there is no record — which is genuinely different
   * from "it did not happen". A record can expire, or the operation may predate
   * the fence. Saying "no" there would be a lie.
   */
  async status(
    key: string,
  ): Promise<{ state: "completed" | "failed" | "in_progress" | "unknown"; record?: Record_ }> {
    const rec = await this.store.get(normalizeKey(key));
    if (!rec) return { state: "unknown" };
    return { state: rec.status, record: rec };
  }

  /**
   * A receipt proving what happened for this key, or null if nothing is known.
   *
   * For anyone in payments or regulated work, evidence is worth more than
   * prevention: "show me this refund was issued exactly once" is an audit
   * question with money attached to the answer. The payload hash makes the
   * receipt content-addressed — you can prove WHAT ran, not merely that
   * something did.
   */
  async receipt(key: string): Promise<Receipt | null> {
    const rec = await this.store.get(normalizeKey(key));
    if (!rec) return null;
    return {
      key: rec.key,
      status: rec.status,
      payloadHash: rec.payloadHash,
      /** Increments on every reclaim; >1 means a worker died and was replaced. */
      generation: rec.generation,
      firstSeenAt: new Date(rec.createdAt * 1000).toISOString(),
      settledAt: new Date(rec.updatedAt * 1000).toISOString(),
      result: rec.result,
      error: rec.error,
    };
  }

  /**
   * begin → fn() → complete/fail, with concurrent callers coalesced onto the
   * single execution rather than racing or erroring.
   */
  async run<T>(
    key: string,
    payload: unknown,
    fn: () => T | Promise<T>,
    opts: {
      ttlSec?: number;
      leaseSec?: number;
      waitTimeoutMs?: number;
      pollMs?: number;
    } = {},
  ): Promise<T> {
    const waitTimeoutMs = opts.waitTimeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 50;
    const deadline = Date.now() + waitTimeoutMs;

    for (;;) {
      let out: Outcome;
      try {
        out = await this.begin(key, payload, opts);
      } catch (e) {
        if (e instanceof InProgressError) {
          if (Date.now() >= deadline) throw new WaitTimeout(key, waitTimeoutMs);
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        throw e;
      }

      if (!out.execute) {
        if (out.record.status === "failed") {
          throw new Error(out.record.error || "idempotent call previously failed");
        }
        return out.record.result as T;
      }

      // The effect and the commit are handled separately ON PURPOSE. They fail
      // for opposite reasons and need opposite recoveries: an effect that did
      // not happen should be retryable, an effect that DID happen must never
      // be retryable just because we could not write down what it returned.
      let result: T;
      try {
        result = await fn();
      } catch (e) {
        // Nothing happened (or it failed): free the key so the same payload
        // can be retried; then surface the real error. Swallowing it here
        // would hide a genuine failure behind an idempotency concern.
        await this.#bestEffortFail(key, out.record.fenceToken, errText(e), true);
        throw e;
      }

      try {
        await this.complete(key, out.record.fenceToken, result, opts.ttlSec);
      } catch (e) {
        // The effect ALREADY RAN. Freeing the key here — which is what this
        // used to do — lets the very next caller fire it a second time, the
        // one outcome this library exists to prevent. An oversized result
        // reaches this path, and so does any store that refuses a value at
        // write time.
        //
        // So an unrecordable commit is terminal, not retryable: later callers
        // replay the failure instead of re-executing, and the caller still
        // sees the original error. Recovering means a NEW idempotency key,
        // because deciding whether an effect that already happened should
        // happen again belongs to the caller, not to a lease timeout.
        await this.#bestEffortFail(
          key,
          out.record.fenceToken,
          `once: effect executed but result could not be stored: ${errText(e)}`,
          false,
        );
        throw e;
      }
      return result;
    }
  }

  /**
   * Release or terminate a reservation while another error is already in
   * flight. Never throws: a zombie worker's CAS legitimately fails because it
   * is fenced out, and letting that surface would replace the caller's real
   * error with a bookkeeping one.
   */
  async #bestEffortFail(
    key: string,
    fenceToken: string,
    error: string,
    allowRetry: boolean,
  ): Promise<boolean> {
    try {
      return await this.fail(key, fenceToken, error, allowRetry);
    } catch {
      return false;
    }
  }
}
