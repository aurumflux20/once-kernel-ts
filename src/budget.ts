/**
 * A spending ceiling at the same choke point as the fence.
 *
 * If you are already intercepting every money-moving call in order to
 * deduplicate it, you are one line away from bounding what it may spend. The
 * insertion point is identical; only the question differs. That matters
 * commercially as much as technically: it is a second reason to install, aimed
 * at exactly the people who care about the first.
 *
 * The failure this prevents is not a duplicate. It is an agent doing something
 * individually reasonable, repeatedly, until the money is gone. No single call
 * looks wrong — the ceiling is the only thing that sees the pattern.
 *
 * Two decisions worth stating outright:
 *
 *   1. **It refuses rather than warns.** The fence's guard warns because
 *      blocking an effect you cannot prove is unsafe would be worse than the
 *      bug. A ceiling is different: the caller set the number, so enforcing it
 *      is doing what they asked.
 *
 *   2. **It reserves before the call and settles after.** Checking a total
 *      afterwards is a time-of-check-to-time-of-use race — ten concurrent calls
 *      each see room and every one proceeds. Reserve first, and the tenth is
 *      refused while the ninth is still in flight.
 */

export interface BudgetWindow {
  /** Ceiling for this window, in whatever unit you spend in. */
  limit: number;
  /** Window length in ms. Rolling, not calendar-aligned. */
  windowMs: number;
}

export interface SpendAttempt {
  /** What is being spent on. Surfaced in the refusal. */
  what: string;
  amount: number;
  context?: Record<string, string | number>;
}

export class BudgetExceeded extends Error {
  readonly limit: number;
  readonly spent: number;
  readonly attempted: number;
  readonly windowMs: number;
  readonly resetsInMs: number;

  constructor(a: {
    what: string;
    limit: number;
    spent: number;
    attempted: number;
    windowMs: number;
    resetsInMs: number;
  }) {
    super(
      `refusing "${a.what}": ${a.attempted} would take spending to ` +
        `${a.spent + a.attempted} against a ceiling of ${a.limit} per ` +
        `${Math.round(a.windowMs / 60000)} minutes. ` +
        `${a.spent} already committed; the window frees up in ` +
        `${Math.round(a.resetsInMs / 1000)}s.`,
    );
    this.name = "BudgetExceeded";
    this.limit = a.limit;
    this.spent = a.spent;
    this.attempted = a.attempted;
    this.windowMs = a.windowMs;
    this.resetsInMs = a.resetsInMs;
  }
}

interface Entry {
  at: number;
  amount: number;
  settled: boolean;
}

export class SpendLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private entries: Entry[] = [];

  constructor(w: BudgetWindow) {
    if (!(w.limit > 0)) throw new Error("budget limit must be positive");
    if (!(w.windowMs > 0)) throw new Error("budget window must be positive");
    this.limit = w.limit;
    this.windowMs = w.windowMs;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter((e) => e.at > cutoff);
  }

  /** Committed spend in the current window — reservations included. */
  spent(now = Date.now()): number {
    this.prune(now);
    return this.entries.reduce((n, e) => n + e.amount, 0);
  }

  remaining(now = Date.now()): number {
    return Math.max(0, this.limit - this.spent(now));
  }

  /**
   * Reserve headroom BEFORE the call. Throws if it would breach the ceiling.
   *
   * Returns a handle: `settle()` if it went through, `release()` if it did not.
   * A reservation that is never resolved simply expires with the window, so a
   * crash costs you conservatism rather than a stuck ceiling.
   */
  reserve(a: SpendAttempt): { settle: () => void; release: () => void } {
    if (!(a.amount >= 0)) throw new Error("spend amount must be >= 0");
    const now = Date.now();
    const spent = this.spent(now);

    if (spent + a.amount > this.limit) {
      const oldest = this.entries[0]?.at ?? now;
      throw new BudgetExceeded({
        what: a.what,
        limit: this.limit,
        spent,
        attempted: a.amount,
        windowMs: this.windowMs,
        resetsInMs: Math.max(0, oldest + this.windowMs - now),
      });
    }

    const entry: Entry = { at: now, amount: a.amount, settled: false };
    this.entries.push(entry);

    return {
      settle: () => {
        entry.settled = true;
      },
      release: () => {
        const i = this.entries.indexOf(entry);
        if (i >= 0 && !entry.settled) this.entries.splice(i, 1);
      },
    };
  }

  /**
   * Run `fn` only if it fits under the ceiling. Releases the reservation if it
   * throws, so a failed call does not consume budget it never spent.
   */
  async run<T>(a: SpendAttempt, fn: () => T | Promise<T>): Promise<T> {
    const h = this.reserve(a);
    try {
      const out = await fn();
      h.settle();
      return out;
    } catch (e) {
      h.release();
      throw e;
    }
  }

  /** Test-only: forget all spend. */
  reset(): void {
    this.entries = [];
  }
}
