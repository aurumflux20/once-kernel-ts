/**
 * Kernel behaviour. The storm proof (1,000 racers across real worker threads)
 * lives separately in test/storm.test.ts — these are the semantics tests that
 * have to hold before parallelism is even worth measuring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Once,
  MemoryStore,
  IdempotencyConflict,
  InProgressError,
  ResultTooLarge,
  WaitTimeout,
} from "../src/kernel.ts";

test("the effect runs once no matter how many callers ask", async () => {
  const once = new Once();
  let runs = 0;
  const effect = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return "sent";
  };

  const results = await Promise.all(
    Array.from({ length: 50 }, () => once.run("order-1", { to: "a@b.c" }, effect)),
  );

  assert.equal(runs, 1, "the side effect must execute exactly once");
  assert.deepEqual(new Set(results), new Set(["sent"]), "every caller gets the same result");
  assert.equal(results.length, 50);
});

test("a retry after completion returns the stored result and does not re-run", async () => {
  const once = new Once();
  let runs = 0;
  const fn = async () => (runs++, { id: 7 });

  const a = await once.run("k", { x: 1 }, fn);
  const b = await once.run("k", { x: 1 }, fn);

  assert.equal(runs, 1);
  assert.deepEqual(a, b);
});

test("same key with a different payload is a conflict, never a dedupe", async () => {
  const once = new Once();
  await once.run("k", { amount: 10 }, async () => "ok");
  await assert.rejects(
    () => once.run("k", { amount: 99 }, async () => "ok"),
    IdempotencyConflict,
    "guessing which body wins is how money moves twice",
  );
});

test("key order in the payload does not create a second execution", async () => {
  const once = new Once();
  let runs = 0;
  const fn = async () => (runs++, "ok");
  await once.run("k", { a: 1, b: 2 }, fn);
  await once.run("k", { b: 2, a: 1 }, fn);
  assert.equal(runs, 1, "an LLM reformatting its JSON between retries must still hit the same key");
});

test("a failed effect frees the key so the same payload can be retried", async () => {
  const once = new Once();
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error("network blip");
    return "ok";
  };

  await assert.rejects(() => once.run("k", { x: 1 }, flaky), /network blip/);
  const result = await once.run("k", { x: 1 }, flaky);

  assert.equal(result, "ok");
  assert.equal(attempts, 2, "a transient failure must not become permanent");
});

test("the real error surfaces, not an idempotency error", async () => {
  const once = new Once();
  await assert.rejects(
    () => once.run("k", {}, async () => {
      throw new TypeError("the actual bug");
    }),
    TypeError,
  );
});

test("a dead lease is reclaimed so a crashed worker cannot strand the key", async () => {
  // This is the failure an in-memory "seen set" gets wrong: the worker dies
  // between reserving and finishing, the key stays claimed, and the effect
  // never runs at all.
  const store = new MemoryStore();
  const once = new Once({ store, defaultLeaseSec: 0.05 });

  const claimed = await once.begin("k", { x: 1 });
  assert.equal(claimed.execute, true);

  // ...worker dies here, never calling complete() or fail().
  await new Promise((r) => setTimeout(r, 80));

  const takeover = await once.begin("k", { x: 1 });
  assert.equal(takeover.execute, true, "the lease expired, so the work must proceed");
  assert.ok(
    takeover.record.generation > claimed.record.generation,
    "generation must advance so downstream systems can fence the stale worker",
  );
});

test("a stale worker cannot commit over the one that replaced it", async () => {
  const store = new MemoryStore();
  const once = new Once({ store, defaultLeaseSec: 0.05 });

  const stale = await once.begin("k", { x: 1 });
  await new Promise((r) => setTimeout(r, 80));
  const live = await once.begin("k", { x: 1 });

  const staleWon = await once.complete("k", stale.record.fenceToken, "stale result");
  assert.equal(staleWon, false, "the fence token must reject the stalled worker");

  const liveWon = await once.complete("k", live.record.fenceToken, "live result");
  assert.equal(liveWon, true);

  const seen = await store.get("k");
  assert.equal(seen?.result, "live result");
});

test("a second caller waiting on an in-flight call times out rather than hanging forever", async () => {
  const once = new Once({ defaultLeaseSec: 60 });
  await once.begin("k", { x: 1 }); // claimed and never settled
  await assert.rejects(
    () => once.run("k", { x: 1 }, async () => "never", { waitTimeoutMs: 120, pollMs: 20 }),
    WaitTimeout,
  );
});

test("an oversized result is refused rather than silently stored", async () => {
  const once = new Once({ maxResultBytes: 100 });
  await assert.rejects(
    () => once.run("k", {}, async () => "x".repeat(500)),
    ResultTooLarge,
  );
});

test("a result that cannot be stored must not let the effect run twice", async () => {
  // The commit leg failed AFTER the effect fired. Refusing the result is
  // correct; freeing the key afterwards is not — the next caller then fires a
  // side effect that ALREADY HAPPENED. Exactly-once has to survive its own
  // commit failing.
  const once = new Once({ maxResultBytes: 100 });
  let calls = 0;
  const effect = async () => {
    calls++;
    return "x".repeat(500);
  };

  await assert.rejects(
    () => once.run("commit:oversized", { amount: 49 }, effect),
    ResultTooLarge,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    () => once.run("commit:oversized", { amount: 49 }, effect),
    /could not be stored/,
  );
  assert.equal(
    calls,
    1,
    `side effect ran ${calls}× after a failed commit — duplicate execution`,
  );
});

test("keys are validated", async () => {
  const once = new Once();
  await assert.rejects(() => once.run("   ", {}, async () => 1), /non-empty/);
  await assert.rejects(() => once.run("k".repeat(257), {}, async () => 1), /max length/);
});

test("InProgressError is thrown by begin() when a live call holds the key", async () => {
  const once = new Once({ defaultLeaseSec: 60 });
  await once.begin("k", { x: 1 });
  await assert.rejects(() => once.begin("k", { x: 1 }), InProgressError);
});
