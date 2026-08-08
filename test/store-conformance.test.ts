/**
 * Store conformance: every store must satisfy the SAME contract.
 *
 * Written as one suite run against each implementation rather than two suites,
 * because the failure mode we care about is a durable store that quietly
 * behaves differently from the in-memory one people test against. A divergence
 * here is a production bug that never shows up in development.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Once, MemoryStore, IdempotencyConflict, type Store } from "../src/kernel.ts";
import { SqliteStore } from "../src/stores/sqlite.ts";

const stores: Array<[string, () => Store]> = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore(:memory:)", () => new SqliteStore()],
];

for (const [name, make] of stores) {
  test(`${name}: 50 concurrent callers produce exactly one execution`, async () => {
    const once = new Once({ store: make() });
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        once.run("order-1", { to: "a@b.c" }, async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 20));
          return "sent";
        }),
      ),
    );
    assert.equal(runs, 1);
    assert.equal(results.filter((r) => r === "sent").length, 50);
  });

  test(`${name}: a completed key returns its stored result without re-running`, async () => {
    const once = new Once({ store: make() });
    let runs = 0;
    const fn = async () => (runs++, { id: 7, nested: { ok: true } });
    const a = await once.run("k", { x: 1 }, fn);
    const b = await once.run("k", { x: 1 }, fn);
    assert.equal(runs, 1);
    assert.deepEqual(a, b, "the result must survive a round trip through the store");
  });

  test(`${name}: same key + different payload is a conflict`, async () => {
    const once = new Once({ store: make() });
    await once.run("k", { amount: 10 }, async () => "ok");
    await assert.rejects(
      () => once.run("k", { amount: 99 }, async () => "ok"),
      IdempotencyConflict,
    );
  });

  test(`${name}: a dead lease is reclaimed and the generation advances`, async () => {
    const once = new Once({ store: make(), defaultLeaseSec: 0.05 });
    const claimed = await once.begin("k", { x: 1 });
    await new Promise((r) => setTimeout(r, 80));
    const takeover = await once.begin("k", { x: 1 });
    assert.equal(takeover.execute, true);
    assert.ok(takeover.record.generation > claimed.record.generation);
  });

  test(`${name}: a stale fence token cannot commit`, async () => {
    const once = new Once({ store: make(), defaultLeaseSec: 0.05 });
    const stale = await once.begin("k", { x: 1 });
    await new Promise((r) => setTimeout(r, 80));
    const live = await once.begin("k", { x: 1 });
    assert.equal(await once.complete("k", stale.record.fenceToken, "stale"), false);
    assert.equal(await once.complete("k", live.record.fenceToken, "live"), true);
  });

  test(`${name}: a soft failure frees the key for the same payload`, async () => {
    const once = new Once({ store: make() });
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error("blip");
      return "ok";
    };
    await assert.rejects(() => once.run("k", { x: 1 }, flaky), /blip/);
    assert.equal(await once.run("k", { x: 1 }, flaky), "ok");
    assert.equal(attempts, 2);
  });

  test(`${name}: an expired record is treated as absent and can be reclaimed`, async () => {
    const once = new Once({ store: make(), defaultTtlSec: 0.05 });
    let runs = 0;
    const fn = async () => (runs++, "ok");
    await once.run("k", { x: 1 }, fn);
    await new Promise((r) => setTimeout(r, 80));
    await once.run("k", { x: 1 }, fn);
    assert.equal(runs, 2, "past its TTL the key is free again");
  });
}

test("SqliteStore: the record actually survives on disk, across connections", async () => {
  // The whole point of a durable store. A second connection standing in for a
  // restarted process must see the completed record and skip the effect —
  // this is the case the in-memory store cannot pass by construction.
  const dir = mkdtempSync(join(tmpdir(), "once-"));
  const path = join(dir, "once.db");
  try {
    const first = new SqliteStore({ path });
    let runs = 0;
    await new Once({ store: first }).run("payment-42", { amount: 500 }, async () => {
      runs++;
      return { charged: true };
    });
    first.close();

    const second = new SqliteStore({ path });
    const result = await new Once({ store: second }).run(
      "payment-42",
      { amount: 500 },
      async () => {
        runs++;
        return { charged: true };
      },
    );
    second.close();

    assert.equal(runs, 1, "a restarted process must not charge the card twice");
    assert.deepEqual(result, { charged: true }, "and it must still return the original result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SqliteStore: an in-flight claim survives a restart and is reclaimed, not stranded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "once-"));
  const path = join(dir, "once.db");
  try {
    const first = new SqliteStore({ path });
    // Claim it, then "crash" without completing.
    await new Once({ store: first, defaultLeaseSec: 0.05 }).begin("k", { x: 1 });
    first.close();

    await new Promise((r) => setTimeout(r, 80));

    const second = new SqliteStore({ path });
    let ran = false;
    const result = await new Once({ store: second, defaultLeaseSec: 30 }).run(
      "k",
      { x: 1 },
      async () => {
        ran = true;
        return "done";
      },
    );
    second.close();

    assert.equal(ran, true, "the dead process must not hold the key forever");
    assert.equal(result, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
