/**
 * Notarised receipts — the properties an outsider relies on.
 *
 * The point of the chain is that tampering is caught by arithmetic instead of
 * trust, so most of these tests are attacks: edit a field, drop an entry,
 * reorder two, forge a link. Each must be detected, and detected at the right
 * place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Once } from "../src/kernel.ts";
import {
  GENESIS,
  ReceiptLedger,
  auditKey,
  verifyChain,
  type LedgerEntry,
} from "../src/ledger.ts";

async function receiptFor(o: Once, key: string, payload: unknown, result: unknown) {
  const out = await o.begin(key, payload);
  await o.complete(key, out.record.fenceToken, result);
  const r = await o.receipt(key);
  assert.ok(r, "expected a receipt");
  return r!;
}

async function chainOf(n: number): Promise<ReceiptLedger> {
  const o = new Once();
  const l = new ReceiptLedger();
  for (let i = 0; i < n; i++) {
    const r = await receiptFor(o, `charge:${i}`, { order: i }, { id: `ch_${i}` });
    l.append({ receipt: r, world: "confirmed", worldRef: `pi_${i}` });
  }
  return l;
}

test("a fresh chain starts at genesis and links each entry to the last", async () => {
  const l = new ReceiptLedger();
  assert.equal(l.head(), GENESIS);

  const o = new Once();
  const first = l.append({ receipt: await receiptFor(o, "a", { n: 1 }, "ok") });
  assert.equal(first.prevHash, GENESIS);
  assert.equal(first.seq, 0);

  const second = l.append({ receipt: await receiptFor(o, "b", { n: 2 }, "ok") });
  assert.equal(second.prevHash, first.hash, "entry 2 must link to entry 1");
  assert.equal(l.head(), second.hash);
});

test("an untouched chain verifies", async () => {
  const l = await chainOf(5);
  const v = verifyChain(l.all());
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.entries, 5);
});

test("editing a value is caught, and named as alteration", async () => {
  const l = await chainOf(4);
  const entries = JSON.parse(l.toJSON()) as LedgerEntry[];
  entries[2]!.payloadHash = "f".repeat(64); // rewrite history

  const v = verifyChain(entries);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.failedAt, 2);
    assert.match(v.reason, /altered/);
  }
});

test("deleting an entry is caught — this is the audit-fraud case", async () => {
  const l = await chainOf(5);
  const entries = JSON.parse(l.toJSON()) as LedgerEntry[];
  entries.splice(2, 1); // quietly remove the inconvenient one

  const v = verifyChain(entries);
  assert.equal(v.ok, false, "a deleted entry must not pass verification");
  if (!v.ok) assert.equal(v.failedAt, 2);
});

test("reordering two entries is caught", async () => {
  const l = await chainOf(4);
  const entries = JSON.parse(l.toJSON()) as LedgerEntry[];
  const tmp = entries[1]!;
  entries[1] = entries[2]!;
  entries[2] = tmp;

  const v = verifyChain(entries);
  assert.equal(v.ok, false);
});

test("re-hashing an edited entry still fails, because the NEXT link breaks", async () => {
  // The naive forgery: change a field and recompute that entry's own hash.
  // It must still fail, because entry i+1 stores the old hash.
  const l = await chainOf(4);
  const entries = JSON.parse(l.toJSON()) as LedgerEntry[];
  const target = entries[1]!;
  target.status = "failed";
  // recompute exactly the way the ledger would
  const { createHash } = await import("node:crypto");
  const { canonicalBytes } = await import("../src/canonical.ts");
  const { hash: _drop, ...body } = target;
  target.hash = createHash("sha256")
    .update(canonicalBytes({
      seq: body.seq, key: body.key, status: body.status, payloadHash: body.payloadHash,
      generation: body.generation, world: body.world, worldRef: body.worldRef ?? "",
      at: body.at, prevHash: body.prevHash,
    }))
    .digest("hex");

  const v = verifyChain(entries);
  assert.equal(v.ok, false, "a locally-consistent forgery must still break the chain");
  if (!v.ok) assert.equal(v.failedAt, 2, "the break shows up at the following entry");
});

test("verification needs nothing but the entries — survives a JSON round trip", async () => {
  const l = await chainOf(3);
  const shipped = ReceiptLedger.fromJSON(l.toJSON()); // as if emailed to an auditor
  assert.equal(verifyChain(shipped.all()).ok, true);
});

test("world confirmation is recorded, never assumed", async () => {
  const o = new Once();
  const l = new ReceiptLedger();
  l.append({ receipt: await receiptFor(o, "sent:1", { to: "a@x.com" }, "ok") }); // no world arg
  l.append({ receipt: await receiptFor(o, "sent:2", { to: "b@x.com" }, "ok"), world: "confirmed", worldRef: "re_9" });

  assert.equal(l.all()[0]!.world, "unconfirmed", "default must be unconfirmed, not optimistic");
  assert.equal(l.all()[1]!.world, "confirmed");
  assert.equal(l.all()[1]!.worldRef, "re_9");
});

test("auditKey answers the question an auditor actually asks", async () => {
  const o = new Once();
  const l = new ReceiptLedger();
  l.append({ receipt: await receiptFor(o, "refund:4471", { amt: 20 }, "ok"), world: "confirmed", worldRef: "re_x" });

  const report = auditKey(l.all(), "refund:4471");
  assert.match(report, /Chain verified/);
  assert.match(report, /Executed once/);
  assert.match(report, /Confirmed by the provider/);

  const missing = auditKey(l.all(), "refund:nope");
  assert.match(missing, /No record/);
});

test("auditKey refuses to answer at all when the chain is broken", async () => {
  const l = await chainOf(3);
  const entries = JSON.parse(l.toJSON()) as LedgerEntry[];
  entries[1]!.at = "1999-01-01T00:00:00.000Z"; // backdate

  const report = auditKey(entries, "charge:2");
  assert.match(report, /CHAIN BROKEN/);
  assert.match(report, /No claim about .* can be trusted/i);
});

test("an unconfirmed completion says so plainly rather than implying success", async () => {
  const o = new Once();
  const l = new ReceiptLedger();
  l.append({ receipt: await receiptFor(o, "sent:9", { to: "c@x.com" }, "ok") });

  const report = auditKey(l.all(), "sent:9");
  assert.match(report, /NOT confirmed by any provider/);
  assert.match(report, /nobody asked/);
});

test("two completions for one key are surfaced as the duplicate they are", async () => {
  const o = new Once();
  const l = new ReceiptLedger();
  const r = await receiptFor(o, "charge:dup", { n: 1 }, "ok");
  l.append({ receipt: r, world: "confirmed" });
  l.append({ receipt: r, world: "confirmed" }); // the thing we exist to catch

  const report = auditKey(l.all(), "charge:dup");
  assert.match(report, /2 completions for one key/);
});
