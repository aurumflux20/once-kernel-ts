/**
 * The warning has one job: fire at the moment someone is about to cause an
 * irreversible effect they cannot safely retry — and stay quiet otherwise.
 *
 * Staying quiet matters as much as firing. A warning that cries wolf gets
 * switched off, and then it protects nobody. Half these tests are about
 * silence.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  guardEffect,
  withGuard,
  resetGuardWarnings,
  UnguardedEffectError,
  type EffectWarning,
} from "../src/guard.ts";

const collect = () => {
  const seen: EffectWarning[] = [];
  return { seen, onWarn: (w: EffectWarning) => seen.push(w) };
};

beforeEach(() => resetGuardWarnings());

test("warns when an irreversible effect has no key and no disclosure", () => {
  const { seen, onWarn } = collect();
  const w = guardEffect(
    { what: "charge card", reversibility: "irreversible", endpointDeduplicates: "unknown" },
    { onWarn },
  );
  assert.equal(w?.reason, "no-key-no-disclosure");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.message, /may happen twice/);
});

test("the message says WHY, not just that something is wrong", () => {
  const { seen, onWarn } = collect();
  guardEffect(
    { what: "send SMS", reversibility: "irreversible", context: { to: "+4478…" } },
    { onWarn },
  );
  const m = seen[0]!.message;
  assert.match(m, /no idempotency key/, "should name the missing key");
  assert.match(m, /has not stated whether it deduplicates/, "should name the unknown endpoint");
  assert.match(m, /to: \+4478…/, "should surface the caller's context");
});

test("silent when the caller supplied a key AND the endpoint declares dedup", () => {
  const { seen, onWarn } = collect();
  const w = guardEffect(
    {
      what: "charge card",
      reversibility: "irreversible",
      idempotencyKey: "pay_abc123",
      endpointDeduplicates: "declared",
    },
    { onWarn },
  );
  assert.equal(w, null);
  assert.equal(seen.length, 0);
});

test("silent when the caller has a key and the endpoint is merely unknown", () => {
  // The normal, reasonable case. Warning here would make this noise, and noisy
  // warnings get turned off — after which they protect nobody.
  const { seen, onWarn } = collect();
  assert.equal(
    guardEffect(
      { what: "charge card", reversibility: "irreversible", idempotencyKey: "pay_1" },
      { onWarn },
    ),
    null,
  );
  assert.equal(seen.length, 0);
});

test("silent for a reversible effect", () => {
  const { seen, onWarn } = collect();
  assert.equal(guardEffect({ what: "update a draft", reversibility: "reversible" }, { onWarn }), null);
  assert.equal(seen.length, 0);
});

test("unknown reversibility is treated as irreversible", () => {
  // Erring the other way would make the default useless: the people this is
  // for are exactly the ones who never thought about it.
  const { seen, onWarn } = collect();
  assert.ok(guardEffect({ what: "do a thing" }, { onWarn }));
  assert.equal(seen.length, 1);
});

test("an endpoint that declares it does NOT dedupe warns even with a key", () => {
  const { seen, onWarn } = collect();
  const w = guardEffect(
    {
      what: "pay invoice",
      reversibility: "irreversible",
      idempotencyKey: "k".repeat(20),
      endpointDeduplicates: "declared-absent",
    },
    { onWarn },
  );
  assert.equal(w?.reason, "no-disclosure");
  assert.match(seen[0]!.message, /does NOT deduplicate/);
});

test("repeat warnings are deduped by default", () => {
  const { seen, onWarn } = collect();
  for (let i = 0; i < 5; i++) guardEffect({ what: "charge card" }, { onWarn });
  assert.equal(seen.length, 1, "a loop must not produce five identical warnings");
});

test("strict mode throws instead of warning", () => {
  assert.throws(
    () => guardEffect({ what: "charge card" }, { strict: true }),
    UnguardedEffectError,
  );
});

test("withGuard checks before running and still returns the result", () => {
  const { seen, onWarn } = collect();
  let ran = 0;
  const charge = withGuard({ what: "charge card" }, (amount: number) => {
    ran++;
    return `charged ${amount}`;
  }, { onWarn });

  const out = charge(4900);
  assert.equal(out, "charged 4900", "the wrapped function must still work");
  assert.equal(ran, 1, "the effect must NOT be blocked — warning is not prevention");
  assert.equal(seen.length, 1);
});
