/**
 * `guardEffect` — shout at the moment an irreversible effect is about to run
 * without a dedup key.
 *
 * The idea came from a maintainer reviewing one of our findings, and it is the
 * sharpest thing anyone has said about this problem: a caller-addressable
 * idempotency key only protects you if the *other side* honours it, and today a
 * caller has no way to know whether it does. So the safe default for any client
 * is to assume retries are unsafe — and almost nobody does, because nothing
 * tells them.
 *
 * Every other part of this library helps someone who already knows they have
 * the problem. This part is for the far larger group who do not. It is the
 * difference between a tool you reach for and a tool that reaches you.
 *
 * It deliberately does NOT prevent the call. A library that silently blocked
 * effects would be worse than the bug: teams would rip it out. It raises a
 * flag at exactly the moment a supervisor wants one, and gets out of the way.
 */

export type Reversibility = "irreversible" | "reversible" | "unknown";

export interface EffectDescriptor {
  /** What this does, in the caller's words. Used in the warning. */
  what: string;
  /** Whether undoing it is possible. Money and messages are irreversible. */
  reversibility?: Reversibility;
  /** The dedup key, if the caller has one. Its ABSENCE is the whole point. */
  idempotencyKey?: string;
  /**
   * Whether the endpoint has *stated* that it deduplicates.
   *
   * Not whether you believe it does — whether it said so. An x402 challenge
   * carrying an `idempotency` block, a documented `Idempotency-Key` header, a
   * provider that publishes the semantics. If you are guessing, this is
   * `"unknown"`, and that is the case worth warning about.
   */
  endpointDeduplicates?: "declared" | "declared-absent" | "unknown";
  /** Free-form, surfaced in the warning: endpoint, amount, recipient. */
  context?: Record<string, string | number>;
}

export interface GuardOptions {
  /** Where warnings go. Defaults to console.warn. */
  onWarn?: (warning: EffectWarning) => void;
  /**
   * Throw instead of warning. Off by default and it should stay off in most
   * systems — see the note at the top about libraries that block effects.
   */
  strict?: boolean;
  /** Warn at most once per distinct reason+what. Default true. */
  dedupeWarnings?: boolean;
}

export interface EffectWarning {
  reason: "no-key-no-disclosure" | "no-key" | "no-disclosure";
  what: string;
  message: string;
  context?: Record<string, string | number>;
}

export class UnguardedEffectError extends Error {
  readonly warning: EffectWarning;
  constructor(w: EffectWarning) {
    super(w.message);
    this.name = "UnguardedEffectError";
    this.warning = w;
  }
}

const seen = new Set<string>();

function build(d: EffectDescriptor): EffectWarning | null {
  const irreversible = (d.reversibility ?? "unknown") !== "reversible";
  if (!irreversible) return null;

  const hasKey = typeof d.idempotencyKey === "string" && d.idempotencyKey.length > 0;
  const disclosure = d.endpointDeduplicates ?? "unknown";
  const endpointSaysYes = disclosure === "declared";

  // Both present: the caller controls dedup and the endpoint honours it.
  if (hasKey && endpointSaysYes) return null;
  // Nothing to say if the caller has a key AND we simply don't know about the
  // endpoint — that is the normal, reasonable case and warning on it would
  // make this noise, which is how warnings get switched off.
  if (hasKey && disclosure === "unknown") return null;

  const reason: EffectWarning["reason"] =
    !hasKey && !endpointSaysYes ? "no-key-no-disclosure" : !hasKey ? "no-key" : "no-disclosure";

  const lines: string[] = [
    `About to run an irreversible effect without a dedup guarantee: ${d.what}`,
  ];
  if (!hasKey) {
    lines.push(
      `  · no idempotency key was supplied, so a retry cannot be recognised as the same operation`,
    );
  }
  if (disclosure === "declared-absent") {
    lines.push(`  · the endpoint has stated that it does NOT deduplicate`);
  } else if (!endpointSaysYes) {
    lines.push(
      `  · the endpoint has not stated whether it deduplicates, so assume it does not`,
    );
  }
  lines.push(
    `  If this call is retried after a timeout, the effect may happen twice and look like one success.`,
  );
  if (d.context) {
    for (const [k, v] of Object.entries(d.context)) lines.push(`  ${k}: ${v}`);
  }

  return { reason, what: d.what, message: lines.join("\n"), context: d.context };
}

/**
 * Check an effect before running it. Returns the warning it raised, or null.
 *
 * ```ts
 * guardEffect({
 *   what: "charge card",
 *   reversibility: "irreversible",
 *   idempotencyKey: paymentId,          // undefined is the case that warns
 *   endpointDeduplicates: "unknown",
 *   context: { amount: "49.00", to: "acct_123" },
 * });
 * ```
 */
export function guardEffect(
  d: EffectDescriptor,
  opts: GuardOptions = {},
): EffectWarning | null {
  const w = build(d);
  if (!w) return null;

  if (opts.dedupeWarnings !== false) {
    const k = `${w.reason}:${w.what}`;
    if (seen.has(k)) return w;
    seen.add(k);
  }

  if (opts.strict) throw new UnguardedEffectError(w);
  (opts.onWarn ?? ((x: EffectWarning) => console.warn(`[once] ${x.message}`)))(w);
  return w;
}

/** Wrap a function so the check runs immediately before it. */
export function withGuard<A extends unknown[], R>(
  d: EffectDescriptor,
  fn: (...args: A) => R,
  opts?: GuardOptions,
): (...args: A) => R {
  return (...args: A) => {
    guardEffect(d, opts);
    return fn(...args);
  };
}

/** Test-only: forget which warnings have already been shown. */
export function resetGuardWarnings(): void {
  seen.clear();
}
