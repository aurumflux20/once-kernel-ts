/**
 * The four capabilities that make this more than "run a function once":
 * answering whether something already happened, proving it, finding duplicates
 * that already occurred, and bounding what may be spent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Once } from "../src/kernel.ts";
import { SqliteStore } from "../src/stores/sqlite.ts";
import { findDuplicates, formatAuditReport, type EffectRecord } from "../src/audit.ts";
import { SpendLimiter, BudgetExceeded } from "../src/budget.ts";

// ---------------------------------------------------------------- status()

test("status answers without running the operation", async () => {
  const once = new Once();
  let ran = 0;

  assert.equal((await once.status("refund:4471")).state, "unknown");
  assert.equal(ran, 0, "asking must not cause the effect");

  await once.run("refund:4471", { amount: 100 }, async () => (ran++, "refunded"));

  const after = await once.status("refund:4471");
  assert.equal(after.state, "completed");
  assert.equal(ran, 1, "asking again must still not re-run it");
});

test("'unknown' is distinct from 'did not happen'", async () => {
  // A record can expire, or predate the fence. Reporting "no" would be a lie,
  // and someone would refund a customer twice on the strength of it.
  const once = new Once({ defaultTtlSec: 0.05 });
  await once.run("k", { x: 1 }, async () => "done");
  assert.equal((await once.status("k")).state, "completed");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await once.status("k")).state, "unknown", "expired must read as unknown");
});

// --------------------------------------------------------------- receipt()

test("a receipt proves what ran, not just that something did", async () => {
  const once = new Once({ store: new SqliteStore() });
  await once.run("charge:9", { amount: 4900, currency: "usd" }, async () => ({ id: "ch_9" }));

  const r = await once.receipt("charge:9");
  assert.ok(r, "a completed operation must have a receipt");
  assert.equal(r!.status, "completed");
  assert.equal(r!.generation, 1);
  assert.deepEqual(r!.result, { id: "ch_9" });
  assert.match(r!.payloadHash, /^[0-9a-f]{64}$/, "content-addressed by payload");
  assert.ok(!Number.isNaN(Date.parse(r!.settledAt)));
});

test("the receipt's hash identifies the payload, so a different one is provably different", async () => {
  const once = new Once();
  await once.run("a", { amount: 100 }, async () => 1);
  await once.run("b", { amount: 200 }, async () => 1);
  const ra = await once.receipt("a");
  const rb = await once.receipt("b");
  assert.notEqual(ra!.payloadHash, rb!.payloadHash);
});

test("a receipt shows when a worker died and another took over", async () => {
  const once = new Once({ defaultLeaseSec: 0.05 });
  await once.begin("k", { x: 1 }); // claimed, then "crashes"
  await new Promise((r) => setTimeout(r, 80));
  const takeover = await once.begin("k", { x: 1 });
  await once.complete("k", takeover.record.fenceToken, "done");

  const r = await once.receipt("k");
  assert.ok(r!.generation > 1, "generation > 1 is the visible trace of the crash");
});

test("no receipt for an operation never seen", async () => {
  assert.equal(await new Once().receipt("never"), null);
});

// ------------------------------------------------------- findDuplicates()

const rec = (id: string, at: string, subject: object, amount?: number, key?: string) =>
  ({ id, at, subject, amount, key }) as EffectRecord;

test("an explicit key appearing twice is a high-confidence duplicate", () => {
  const r = findDuplicates([
    rec("1", "2026-03-01T10:00:00Z", { order: "A" }, 49, "idem_1"),
    rec("2", "2026-03-01T10:00:30Z", { order: "A" }, 49, "idem_1"),
  ]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0]!.confidence, "high");
  assert.equal(r.groups[0]!.duplicateCount, 1);
  assert.equal(r.totalDuplicateAmount, 49);
});

test("identical subjects close together are flagged, at medium confidence", () => {
  const r = findDuplicates([
    rec("1", "2026-03-01T10:00:00Z", { to: "a@b.c", body: "hi" }),
    rec("2", "2026-03-01T10:00:05Z", { to: "a@b.c", body: "hi" }),
  ]);
  assert.equal(r.groups[0]!.confidence, "medium");
  assert.equal(r.groups[0]!.reason, "identical-subject-within-window");
});

test("a monthly recurring charge is NOT reported as a cluster", () => {
  // The judgement call this module lives or dies on. A subscription looks
  // exactly like a duplicate; calling it one would waste somebody's week.
  const r = findDuplicates([
    rec("1", "2026-01-01T00:00:00Z", { plan: "pro" }, 20),
    rec("2", "2026-02-01T00:00:00Z", { plan: "pro" }, 20),
    rec("3", "2026-03-01T00:00:00Z", { plan: "pro" }, 20),
  ]);
  assert.ok(
    r.groups.every((g) => g.confidence === "low"),
    "spread-out repeats must not be high or medium confidence",
  );
  assert.match(r.groups[0]!.note, /recurring charge/);
});

test("different subjects are never grouped", () => {
  const r = findDuplicates([
    rec("1", "2026-03-01T10:00:00Z", { to: "a@b.c" }),
    rec("2", "2026-03-01T10:00:01Z", { to: "d@e.f" }),
  ]);
  assert.equal(r.groups.length, 0);
  assert.equal(r.totalDuplicates, 0);
});

test("key order in the subject does not hide a duplicate", () => {
  const r = findDuplicates([
    rec("1", "2026-03-01T10:00:00Z", { a: 1, b: 2 }),
    rec("2", "2026-03-01T10:00:02Z", { b: 2, a: 1 }),
  ]);
  assert.equal(r.totalDuplicates, 1, "canonical hashing must see through field order");
});

test("the report totals the money and states its own limits", () => {
  const r = findDuplicates([
    rec("1", "2026-03-01T10:00:00Z", { o: 1 }, 100, "k1"),
    rec("2", "2026-03-01T10:00:10Z", { o: 1 }, 100, "k1"),
    rec("3", "2026-03-02T10:00:00Z", { o: 2 }, 250, "k2"),
    rec("4", "2026-03-02T10:00:20Z", { o: 2 }, 250, "k2"),
  ]);
  assert.equal(r.totalDuplicates, 2);
  assert.equal(r.totalDuplicateAmount, 350);
  assert.ok(r.caveats.length >= 3, "the report must carry its own caveats");

  const text = formatAuditReport(r);
  assert.match(text, /350/);
  assert.match(text, /Before acting:/);
});

test("finding nothing is reported as finding nothing, not as safety", () => {
  const text = formatAuditReport(findDuplicates([rec("1", "2026-03-01T10:00:00Z", { a: 1 })]));
  assert.match(text, /No duplicate effects found/);
  assert.match(text, /not proof the system is safe/);
});

// ----------------------------------------------------------- SpendLimiter

test("spending is allowed up to the ceiling and refused past it", async () => {
  const b = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  await b.run({ what: "pay", amount: 60 }, async () => "ok");
  await b.run({ what: "pay", amount: 40 }, async () => "ok");
  assert.equal(b.remaining(), 0);
  await assert.rejects(() => b.run({ what: "pay", amount: 1 }, async () => "ok"), BudgetExceeded);
});

test("the refusal says what it refused and when it frees up", async () => {
  const b = new SpendLimiter({ limit: 10, windowMs: 60_000 });
  await b.run({ what: "charge card", amount: 10 }, async () => "ok");
  try {
    await b.run({ what: "charge card", amount: 5 }, async () => "ok");
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(e instanceof BudgetExceeded);
    assert.match(e.message, /charge card/);
    assert.match(e.message, /ceiling of 10/);
    assert.match(e.message, /frees up in/);
  }
});

test("reserving BEFORE the call stops concurrent spend racing past the ceiling", async () => {
  // Checking a total afterwards is a time-of-check-to-time-of-use race: ten
  // concurrent calls each see room and all ten proceed. This is the whole
  // reason reserve/settle exists rather than a running total.
  const b = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  let allowed = 0;
  const attempts = Array.from({ length: 10 }, () =>
    b
      .run({ what: "pay", amount: 30 }, async () => {
        allowed++;
        await new Promise((r) => setTimeout(r, 20));
        return "ok";
      })
      .catch(() => null),
  );
  await Promise.all(attempts);
  assert.equal(allowed, 3, `ceiling 100 at 30 each allows exactly 3, got ${allowed}`);
});

test("a failed call does not consume budget it never spent", async () => {
  const b = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  await assert.rejects(() =>
    b.run({ what: "pay", amount: 90 }, async () => {
      throw new Error("provider down");
    }),
  );
  assert.equal(b.spent(), 0, "a failure must release its reservation");
  await b.run({ what: "pay", amount: 90 }, async () => "ok");
});

test("the window rolls, so spend frees up over time", async () => {
  const b = new SpendLimiter({ limit: 10, windowMs: 60 });
  await b.run({ what: "pay", amount: 10 }, async () => "ok");
  await assert.rejects(() => b.run({ what: "pay", amount: 1 }, async () => "ok"), BudgetExceeded);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(b.remaining(), 10, "the window should have rolled clear");
});

test("a nonsensical budget is rejected at construction", () => {
  assert.throws(() => new SpendLimiter({ limit: 0, windowMs: 1000 }));
  assert.throws(() => new SpendLimiter({ limit: 10, windowMs: 0 }));
});
