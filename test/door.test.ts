/**
 * One Door — the seven properties that make "one gate, three questions" true.
 *
 * The door refuses with values, not exceptions; a replay never consumes
 * budget; a refused or failed effect strands neither budget nor key; and
 * under a real concurrent storm exactly one caller executes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Once } from "../src/kernel.ts";
import { SpendLimiter } from "../src/budget.ts";
import { AllowAll, AllowList, OneDoor } from "../src/door.ts";

const KEY = (n: string) => `door:test:${n}`;

test("a clean pass executes exactly once and returns the result", async () => {
  const door = new OneDoor();
  let runs = 0;
  const out = await door.pass({ key: KEY("clean"), payload: { a: 1 } }, async () => {
    runs += 1;
    return "sent";
  });
  assert.equal(out.passed, true);
  if (out.passed) {
    assert.equal(out.replay, false);
    assert.equal(out.result, "sent");
  }
  assert.equal(runs, 1);
});

test("a second pass replays the stored result without re-running or spending", async () => {
  const budget = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  const door = new OneDoor({ budget });
  let runs = 0;
  const req = { key: KEY("replay"), payload: { id: 7 }, amount: 40 };

  const first = await door.pass(req, async () => {
    runs += 1;
    return { charged: 40 };
  });
  const second = await door.pass(req, async () => {
    runs += 1;
    return { charged: 40 };
  });

  assert.equal(runs, 1, "effect ran twice through the door");
  assert.equal(first.passed && !first.replay, true);
  assert.equal(second.passed && second.replay, true);
  // the replay consumed NO budget: only the first 40 is committed
  assert.equal(budget.spent(), 40);
});

test("over budget refuses as a value AND frees the key for later", async () => {
  const budget = new SpendLimiter({ limit: 50, windowMs: 50 });
  const door = new OneDoor({ budget });
  let runs = 0;

  const refused = await door.pass(
    { key: KEY("budget"), payload: { x: 1 }, amount: 80, what: "big send" },
    async () => {
      runs += 1;
      return "no";
    },
  );
  assert.equal(refused.passed, false);
  if (!refused.passed) assert.equal(refused.reason, "over_budget");
  assert.equal(runs, 0, "effect ran despite budget refusal");

  // window expires → same key must be usable again (refusal freed the lease)
  await new Promise((r) => setTimeout(r, 60));
  const ok = await door.pass(
    { key: KEY("budget"), payload: { x: 1 }, amount: 40, what: "smaller send" },
    async () => {
      runs += 1;
      return "yes";
    },
  );
  assert.equal(ok.passed, true);
  assert.equal(runs, 1);
});

test("an uncleared tool is refused before it consumes budget or key", async () => {
  const budget = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  const door = new OneDoor({
    budget,
    policy: new AllowList(["send_email"]),
  });
  let runs = 0;

  const refused = await door.pass(
    { key: KEY("clearance"), payload: {}, amount: 10, tool: "wire_money" },
    async () => {
      runs += 1;
      return "no";
    },
  );
  assert.equal(refused.passed, false);
  if (!refused.passed) {
    assert.equal(refused.reason, "not_cleared");
    assert.match(refused.detail, /wire_money/);
  }
  assert.equal(runs, 0);
  assert.equal(budget.spent(), 0, "refused action consumed budget");

  // the SAME key is untouched — a cleared tool can still claim it
  const ok = await door.pass(
    { key: KEY("clearance"), payload: {}, amount: 10, tool: "send_email" },
    async () => {
      runs += 1;
      return "yes";
    },
  );
  assert.equal(ok.passed, true);
  assert.equal(runs, 1);
});

test("same key with a different payload refuses as a conflict", async () => {
  const door = new OneDoor();
  await door.pass({ key: KEY("conflict"), payload: { to: "a@x.com" } }, async () => "one");
  const out = await door.pass(
    { key: KEY("conflict"), payload: { to: "b@x.com" } },
    async () => "two",
  );
  assert.equal(out.passed, false);
  if (!out.passed) assert.equal(out.reason, "conflict");
});

test("a failing effect releases budget and frees the key for retry", async () => {
  const budget = new SpendLimiter({ limit: 50, windowMs: 60_000 });
  const door = new OneDoor({ budget });
  const req = { key: KEY("fail"), payload: { n: 1 }, amount: 30 };

  await assert.rejects(
    door.pass(req, async () => {
      throw new Error("SMTP 421, try again later");
    }),
    /SMTP 421/,
  );
  assert.equal(budget.spent(), 0, "failed effect kept its reservation");

  const retry = await door.pass(req, async () => "delivered");
  assert.equal(retry.passed, true);
  if (retry.passed) assert.equal(retry.replay, false);
  assert.equal(budget.spent(), 30);
});

test("storm: 50 concurrent passes -> exactly one execution, budget spent once", async () => {
  const budget = new SpendLimiter({ limit: 100, windowMs: 60_000 });
  const door = new OneDoor({ once: new Once({ defaultLeaseSec: 30 }), budget });
  let runs = 0;

  const req = { key: KEY("storm"), payload: { batch: 9 }, amount: 25 };
  const outcomes = await Promise.all(
    Array.from({ length: 50 }, () =>
      door.pass(req, async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 20)); // hold the race open
        return "fired";
      }),
    ),
  );

  assert.equal(runs, 1, `storm produced ${runs} executions`);
  const executed = outcomes.filter((o) => o.passed && !o.replay);
  const replays = outcomes.filter((o) => o.passed && o.replay);
  assert.equal(executed.length, 1);
  assert.equal(replays.length, 49);
  for (const o of replays) {
    if (o.passed) assert.equal(o.result, "fired");
  }
  assert.equal(budget.spent(), 25, "budget charged more than once in the storm");
});

test("AllowAll is the default and clears unnamed tools", async () => {
  const door = new OneDoor({ policy: new AllowAll() });
  const out = await door.pass({ key: KEY("default"), payload: null }, async () => 1);
  assert.equal(out.passed, true);
});
