/**
 * One Door — every irreversible action passes a single gate that answers
 * three questions before anything fires:
 *
 *   1. Did this already happen?          (once lease — no duplicates)
 *   2. Is there budget left for it?      (spend ceiling — no runaway loops)
 *   3. May it run without a human?       (clearance policy — no surprises)
 *
 * The three checks share one choke point on purpose. Installed separately,
 * a rate limiter cannot deduplicate, an idempotency layer cannot budget,
 * and a policy engine can do neither atomically. Composed here, the once
 * lease provides the atomicity and the other two ride inside it.
 *
 * Ordering is load-bearing:
 *
 *   - Clearance runs FIRST and is pure: an action that may not run alone
 *     must not consume budget or claim the key.
 *   - The lease runs SECOND: a replay returns the stored result WITHOUT
 *     touching the budget — a retry of yesterday's charge costs nothing.
 *   - Budget reserves THIRD, before the effect: ten concurrent calls each
 *     seeing headroom is the race `SpendLimiter` exists to close.
 *   - A failed effect releases both the reservation and the key, so a
 *     transient error never strands budget or blocks a legitimate retry.
 */

import {
  IdempotencyConflict,
  InProgressError,
  Once,
  ResultTooLarge,
  WaitTimeout,
  type Outcome,
} from "./kernel.ts";
import { BudgetExceeded, SpendLimiter } from "./budget.ts";

/** Decides whether an effect may run without a human in the loop. */
export interface ClearancePolicy {
  allows(req: DoorRequest): { allowed: boolean; reason?: string };
}

/** Clears everything. The default — One Door without a policy is dedup+budget. */
export class AllowAll implements ClearancePolicy {
  allows(): { allowed: boolean } {
    return { allowed: true };
  }
}

/**
 * Clears only listed tools. The deny message names the list so an agent
 * reading the refusal knows the block is policy, not failure.
 */
export class AllowList implements ClearancePolicy {
  private readonly cleared: Set<string>;
  constructor(cleared: Iterable<string>) {
    this.cleared = new Set(cleared);
  }
  allows(req: DoorRequest): { allowed: boolean; reason?: string } {
    const tool = req.tool ?? "";
    if (this.cleared.has(tool)) return { allowed: true };
    return {
      allowed: false,
      reason: `tool "${tool || "(unnamed)"}" is not on the clearance list`,
    };
  }
}

export interface DoorRequest {
  /** Idempotency key — what makes two attempts "the same action". */
  key: string;
  /** Payload fingerprinted for conflict detection (RFC 8785). */
  payload: unknown;
  /** Spend this action represents. Omit (or 0) for non-metered effects. */
  amount?: number;
  /** Tool/action name — what clearance policies decide on. */
  tool?: string;
  /** Human-readable label for refusal messages. Defaults to tool or key. */
  what?: string;
}

export type DoorRefusal = {
  passed: false;
  reason: "not_cleared" | "over_budget" | "conflict";
  detail: string;
};

export type DoorPass<T> = {
  passed: true;
  /** True when this call did NOT execute — the stored result was returned. */
  replay: boolean;
  result: T;
};

export type DoorOutcome<T> = DoorPass<T> | DoorRefusal;

export interface OneDoorOptions {
  once?: Once;
  budget?: SpendLimiter;
  policy?: ClearancePolicy;
  /** How long a concurrent caller waits for the executor's result. */
  waitTimeoutMs?: number;
  pollMs?: number;
}

export class OneDoor {
  private readonly once: Once;
  private readonly budget?: SpendLimiter;
  private readonly policy: ClearancePolicy;
  private readonly waitTimeoutMs: number;
  private readonly pollMs: number;

  constructor(opts: OneDoorOptions = {}) {
    this.once = opts.once ?? new Once();
    this.budget = opts.budget;
    this.policy = opts.policy ?? new AllowAll();
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 50;
  }

  /** begin(), but a concurrent in-flight holder is waited out, not thrown. */
  private async claim(key: string, payload: unknown): Promise<Outcome> {
    const deadline = Date.now() + this.waitTimeoutMs;
    for (;;) {
      try {
        return await this.once.begin(key, payload);
      } catch (err) {
        if (err instanceof InProgressError) {
          if (Date.now() >= deadline) throw new WaitTimeout(key, this.waitTimeoutMs);
          await new Promise((r) => setTimeout(r, this.pollMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Pass an effect through the door. Exactly one concurrent caller with the
   * same key executes; the rest wait and receive the same result as a replay.
   * Refusals are values, not exceptions — an agent can read the reason and
   * choose its next move. Only the effect's own error is rethrown.
   */
  async pass<T>(req: DoorRequest, effect: () => Promise<T>): Promise<DoorOutcome<T>> {
    const label = req.what ?? req.tool ?? req.key;

    // 1 · Clearance — pure, costs nothing, consumes nothing.
    const verdict = this.policy.allows(req);
    if (!verdict.allowed) {
      return {
        passed: false,
        reason: "not_cleared",
        detail: verdict.reason ?? `"${label}" is not cleared to run without a human`,
      };
    }

    // 2 · The lease — the atomic heart. A replay never reaches the budget.
    let out: Outcome;
    try {
      out = await this.claim(req.key, req.payload);
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        return {
          passed: false,
          reason: "conflict",
          detail: `key "${req.key}" was already used with a different payload — refusing to guess which is right`,
        };
      }
      throw err;
    }
    if (!out.execute) {
      if (out.record.status === "failed") {
        // A hard failure (allowRetry=false) is permanent by the caller's own
        // choice — surfacing it as success would be a lie.
        throw new Error(out.record.error || `"${label}" previously failed permanently`);
      }
      return { passed: true, replay: true, result: out.record.result as T };
    }
    const token = out.record.fenceToken;

    // 3 · Budget — reserve BEFORE the effect; free the key if refused.
    let reservation: { settle: () => void; release: () => void } | undefined;
    if (this.budget && (req.amount ?? 0) > 0) {
      try {
        reservation = this.budget.reserve({ what: label, amount: req.amount! });
      } catch (err) {
        await this.once.fail(req.key, token, `over budget: ${label}`, true);
        if (err instanceof BudgetExceeded) {
          return { passed: false, reason: "over_budget", detail: err.message };
        }
        throw err;
      }
    }

    // 4 · The effect itself. Its failure is the caller's error, rethrown —
    //     but never before both the reservation and the key are freed.
    let result: T;
    try {
      result = await effect();
    } catch (err) {
      reservation?.release();
      await this.once.fail(
        req.key,
        token,
        err instanceof Error ? err.message : String(err),
        true,
      );
      throw err;
    }

    // 5 · Settle: spend committed, result recorded, replays served forever.
    reservation?.settle();
    try {
      await this.once.complete(req.key, token, result);
    } catch (err) {
      if (err instanceof ResultTooLarge) {
        await this.once.complete(req.key, token, {
          __door: "result_too_large_to_store",
        });
      } else {
        throw err;
      }
    }
    return { passed: true, replay: false, result };
  }
}
