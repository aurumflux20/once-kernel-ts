/**
 * The README's examples must actually work.
 *
 * Documentation that doesn't run is worse than none: it costs a reader their
 * trust at the exact moment they were willing to try the thing. These are the
 * snippets from README.md, executed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { Once } from "../src/kernel.ts";
import { SqliteStore } from "../src/stores/sqlite.ts";
import { findDuplicates, formatAuditReport } from "../src/audit.ts";
import { SpendLimiter } from "../src/budget.ts";
import { guardEffect, resetGuardWarnings } from "../src/guard.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "once-readme-"));

test("README §1 — run something exactly once", async () => {
  const dir = tmp();
  try {
    const once = new Once({ store: new SqliteStore({ path: join(dir, "once.db") }) });
    const orderId = "4471";
    let charges = 0;

    const stripe = { charges: { create: async (o: object) => (charges++, { id: "ch_1", ...o }) } };

    const receipt = await once.run(
      `charge:${orderId}`,
      { amount: 4900, currency: "usd" },
      () => stripe.charges.create({ amount: 4900, currency: "usd" }),
    );

    assert.equal((receipt as { id: string }).id, "ch_1");
    // "Fifty racing callers, one charge."
    await Promise.all(
      Array.from({ length: 50 }, () =>
        once.run(`charge:${orderId}`, { amount: 4900, currency: "usd" }, () =>
          stripe.charges.create({ amount: 4900, currency: "usd" }),
        ),
      ),
    );
    assert.equal(charges, 1, "the README promises one charge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README §2 — status without doing it", async () => {
  const once = new Once();
  const orderId = "4471";
  const { state } = await once.status(`refund:${orderId}`);
  assert.equal(state, "unknown");
  assert.ok(["completed", "failed", "in_progress", "unknown"].includes(state));
});

test("README §3 — receipt fields are exactly as documented", async () => {
  const once = new Once();
  await once.run("charge:4471", { amount: 4900 }, async () => ({ id: "ch_1" }));
  const r = await once.receipt("charge:4471");
  // The README lists these by name; if one is renamed, this fails.
  for (const f of ["status", "payloadHash", "generation", "firstSeenAt", "settledAt", "result"]) {
    assert.ok(f in r!, `README documents "${f}" — it must exist`);
  }
});

test("README §4 — the audit example runs and formats", () => {
  const rows = [
    { id: "ch_4471", created_at: "2026-03-01T10:00:00Z", customer_id: "c1", amount: 49, idempotency_key: "idem_88f2" },
    { id: "ch_4472", created_at: "2026-03-01T10:00:12Z", customer_id: "c1", amount: 49, idempotency_key: "idem_88f2" },
  ];

  const report = findDuplicates(
    rows.map((r) => ({
      id: r.id,
      at: r.created_at,
      subject: { customer: r.customer_id, amount: r.amount },
      amount: r.amount,
      key: r.idempotency_key,
    })),
  );

  const text = formatAuditReport(report);
  // The README shows this exact shape of output.
  assert.match(text, /Examined 2 records/);
  assert.match(text, /\[high\]/);
  assert.match(text, /same-key/);
  assert.match(text, /ch_4471, ch_4472/);
});

test("README §4b — the CLI example runs, from the shell, no imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "once-readme-cli-"));
  try {
    const file = join(dir, "payments.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "ch_4471", created_at: "2026-03-01T10:00:00Z", customer: "c1", plan: "pro", amount: 49, idem_key: "idem_88f2" },
        { id: "ch_4472", created_at: "2026-03-01T10:00:12Z", customer: "c1", plan: "pro", amount: 49, idem_key: "idem_88f2" },
      ]),
    );
    const bin = fileURLToPath(new URL("../bin/once-audit.js", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [bin, file, "--at=created_at", "--subject=customer,plan", "--amount=amount", "--key=idem_key"],
      { encoding: "utf8" },
    );
    assert.match(out, /Examined 2 records/);
    assert.match(out, /\[high\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README — the guard example runs", () => {
  resetGuardWarnings();
  const seen: string[] = [];
  const w = guardEffect(
    {
      what: "charge card",
      reversibility: "irreversible",
      idempotencyKey: undefined,
      endpointDeduplicates: "unknown",
    },
    { onWarn: (x) => seen.push(x.message) },
  );
  assert.ok(w, "the README says undefined key is the case that warns");
  assert.equal(seen.length, 1);
});

test("README — the budget example runs", async () => {
  const budget = new SpendLimiter({ limit: 500, windowMs: 24 * 60 * 60 * 1000 });
  const pay = async (n: number) => `paid ${n}`;
  const out = await budget.run({ what: "pay supplier", amount: 49 }, () => pay(49));
  assert.equal(out, "paid 49");
  assert.equal(budget.remaining(), 451);
});

test("README — every documented entry point resolves", async () => {
  // The README's table promises five import paths. A broken one is a broken
  // first impression, and package `exports` are easy to get wrong.
  await Promise.all([
    import("../src/kernel.ts"),
    import("../src/stores/sqlite.ts"),
    import("../src/audit.ts"),
    import("../src/budget.ts"),
    import("../src/guard.ts"),
  ]);
});

test("README — documented error names exist and are exported", async () => {
  const k = await import("../src/kernel.ts");
  const b = await import("../src/budget.ts");
  for (const n of [
    "IdempotencyConflict",
    "InProgressError",
    "WaitTimeout",
    "ResultTooLarge",
    "CanonicalizationError",
  ]) {
    assert.ok(n in k, `README documents ${n}`);
  }
  assert.ok("BudgetExceeded" in b, "README documents BudgetExceeded");
});
