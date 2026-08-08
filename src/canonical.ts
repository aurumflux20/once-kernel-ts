/**
 * Payload canonicalization — RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * The Python kernel says it plainly: *"Cross-language ports MUST cite and
 * conform to the same RFC so payload_hash is stable across Python/Node/Go."*
 * A TypeScript port that hashes differently from the Python one is not a port,
 * it is a second, incompatible product — two services keyed the same way would
 * silently fail to deduplicate each other's work.
 *
 * JCS is unusually easy to satisfy in JavaScript, because the RFC was written
 * around ECMAScript's own serialization rules:
 *
 *   - Numbers   — JCS §3.2.2.3 defers to ECMAScript `Number::toString`, which
 *                 is exactly what `JSON.stringify` emits. No hand-rolled
 *                 float formatting, which is where other languages get this
 *                 wrong. `-0` is the one exception: JCS requires it serialize
 *                 as `0`.
 *   - Strings   — JCS §3.2.2.2 specifies the same minimal escaping that
 *                 `JSON.stringify` already performs.
 *   - Objects   — keys sorted by UTF-16 code unit. `Array.prototype.sort()`
 *                 with no comparator sorts by UTF-16 code units, which is the
 *                 required ordering. Applied recursively.
 *   - Arrays    — order is data; preserved.
 *
 * Non-finite numbers (NaN, ±Infinity) and undefined have no JSON
 * representation and are rejected rather than silently coerced to null —
 * a payload that cannot be canonicalized must never produce a hash.
 */

import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** Recursively sort object keys; validate anything JSON cannot represent. */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;

  const t = typeof value;

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(
        `non-finite number at ${path}: ${n}. JSON has no representation for ` +
          `NaN or Infinity, so this payload cannot be hashed.`,
      );
    }
    // LARGE INTEGERS — a deliberate decision, checked against Python, not guessed.
    //
    // Python's rfc8785 raises IntegerDomainError for an `int` beyond 2^53-1,
    // but happily encodes the `float` 1e21. JavaScript has one number type and
    // cannot tell those apart, so it cannot reproduce Python's branch.
    //
    // We allow every finite double, because that is what RFC 8785 specifies and
    // it is exactly compatible: for any payload the Python kernel *accepts*,
    // both implementations emit identical bytes. (Verified — `1e21` and `1e-7`
    // are in the cross-language vector suite.)
    //
    // Rejecting unsafe integers here would also be theatre: by the time this
    // function runs, `1234567890123456789` has already been rounded to
    // 1234567890123456800 by the JavaScript parser. The precision was lost
    // before the library was called, so there is nothing left to detect.
    //
    // The real hazard is therefore a DOCUMENTATION problem, not a hashing one:
    // pass large integer identifiers (order ids, account numbers, snowflake
    // ids) as strings. See README "Large integers".
    //
    // JCS: -0 serializes as 0. JSON.stringify(-0) already yields "0", but be
    // explicit so the intent survives refactoring.
    return Object.is(n, -0) ? 0 : n;
  }

  if (t === "string" || t === "boolean") return value;

  if (t === "undefined") {
    throw new CanonicalizationError(
      `undefined at ${path}. JSON.stringify drops undefined object members and ` +
        `turns undefined array items into null — either would make two ` +
        `different payloads hash the same. Use null explicitly.`,
    );
  }

  if (t === "bigint") {
    throw new CanonicalizationError(
      `BigInt at ${path}. JCS defers to ECMAScript number semantics; BigInt ` +
        `has no JSON form and would not round-trip to other languages.`,
    );
  }

  if (t === "function" || t === "symbol") {
    throw new CanonicalizationError(`${t} at ${path} cannot be serialized.`);
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalize(v, `${path}[${i}]`));
  }

  if (t === "object") {
    // Reject anything with a non-plain prototype (Date, Map, Set, class
    // instances). JSON.stringify would quietly call toJSON() or emit {} —
    // both make distinct payloads collide.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as object).constructor?.name ?? "object";
      throw new CanonicalizationError(
        `${name} at ${path} is not a plain object. Convert it to plain JSON ` +
          `data first — JSON.stringify would either call its toJSON() or emit ` +
          `{}, and both let two different payloads produce one hash.`,
      );
    }
    const out: Record<string, unknown> = {};
    // Array.prototype.sort() with no comparator compares UTF-16 code units,
    // which is precisely the ordering JCS §3.2.3 requires.
    for (const k of Object.keys(value as object).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return out;
  }

  throw new CanonicalizationError(`unsupported type ${t} at ${path}`);
}

/** RFC 8785 JCS bytes for `payload`. */
export function canonicalBytes(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(payload, "$")), "utf8");
}

/**
 * H(payload) = hex(SHA-256(RFC8785(payload))).
 *
 * Same key + same hash ⇒ same operation. This value is compared against
 * hashes produced by the Python kernel, so it must not drift.
 */
export function payloadHashHex(payload: unknown): string {
  return createHash("sha256").update(canonicalBytes(payload)).digest("hex");
}

/** Composite id for logs and metrics — never a storage primary key on its own. */
export function fingerprint(key: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${key}\0${payloadHashHex(payload)}`, "utf8")
    .digest("hex");
}
