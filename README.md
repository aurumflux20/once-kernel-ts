# once-kernel

**Stop side effects happening twice — and find the ones that already did.**

```bash
npm install once-kernel
```

Zero runtime dependencies. No build step. Node 22.5+.

---

## The problem

An agent retries a call after a timeout. It doesn't know whether the first
attempt landed — the request reached the server, the work happened, the response
never came back.

Nothing failed loudly. It succeeded twice.

That's the easy half. The hard half is the worker that dies **between** reserving
a key and finishing the effect. An in-memory `Set` leaves that key claimed
forever and the effect never runs at all. Restart the process and the `Set` is
empty, so it runs twice.

---

## Four things this does

### 1. Run something exactly once

```ts
import { Once } from "once-kernel";
import { SqliteStore } from "once-kernel/sqlite";

const once = new Once({ store: new SqliteStore({ path: "./once.db" }) });

const receipt = await once.run(
  `charge:${orderId}`,                  // the key
  { amount: 4900, currency: "usd" },    // the payload is part of the identity
  () => stripe.charges.create({ amount: 4900, currency: "usd" }),
);
```

Fifty racing callers, one charge. Every caller gets the same `receipt`.

### 2. Ask whether something already happened — without doing it

```ts
const { state } = await once.status(`refund:${orderId}`);
// "completed" | "failed" | "in_progress" | "unknown"
```

"Did we already refund order 4471?" is a question ops asks daily. Until now the
only way to answer it was to attempt the refund.

`"unknown"` means *no record*, which is **not** the same as "it didn't happen" —
records expire, and operations can predate the fence. Saying "no" there would be
a lie somebody refunds a customer twice on.

### 3. Prove what ran

```ts
const r = await once.receipt(`charge:${orderId}`);
// { status, payloadHash, generation, firstSeenAt, settledAt, result }
```

`payloadHash` is a SHA-256 of the canonical payload, so a receipt proves **what**
ran, not merely that something did. `generation > 1` means a worker died
mid-flight and another took over — the visible trace of a crash you'd otherwise
never see.

For regulated or payments work, evidence is usually worth more than prevention.

### 4. Find duplicates that already happened

No adoption required. Point it at records you already have.

```ts
import { findDuplicates, formatAuditReport } from "once-kernel/audit";

const report = findDuplicates(
  rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    subject: { customer: r.customer_id, amount: r.amount },  // what was DONE
    amount: r.amount,
    key: r.idempotency_key,   // if the system had one
  })),
);

console.log(formatAuditReport(report));
```

```
Examined 12,480 records.
Found 3 duplicate occurrence(s) across 2 group(s), worth 348 in repeated effects.

[high] 1 extra  (49) — same-key
  The system's own idempotency key "idem_88f2" appears on 2 separate effects.
  ids: ch_4471, ch_4472
```

**`subject` is the whole game.** It should contain what makes two operations
*different* and nothing that varies between attempts of the same one — no
timestamps, no trace ids, no retry counters. Leave something out and unrelated
operations look identical; leave something varying in and real duplicates hide.

**No code at all, if you'd rather not write any:**

```bash
npx once-kernel-audit payments.json --at=created_at --subject=customer,plan --amount=amount --key=idem_key
```

Same function, run against a JSON export straight from your terminal — a
payments table dumped to JSON, a send log, anything with records in it.
JSON and JSONL only, deliberately: a CSV parser has quoting and encoding
edge cases that are easy to get subtly wrong, and a silent misparse here is
the worst possible failure mode for a tool whose whole job is finding money
that moved twice. Export to JSON first.

`--at` and `--subject` are required and never guessed — auto-detecting which
fields mean "the same operation" would be guessing at the one judgment call
this tool exists to get right. Run `npx once-kernel-audit --help` for the
full flag reference, or see `bin/once-audit.js`.

Results carry a confidence and the reason they were flagged. A monthly
subscription looks exactly like a duplicate, so spread-out repeats are reported
at **low** confidence and clearly labelled, rather than sent to someone as a
finding.

---

## Also included

### One Door — three checks, one atomic gate

Every irreversible action passes a single gate that answers three questions
before anything fires: **did this already happen? is there budget left? may
it run without a human?** A rate limiter can't deduplicate, an idempotency
layer can't budget, a policy engine can't do either atomically — One Door
composes all three at the same choke point, and a replay never consumes
budget.

```ts
import { OneDoor, AllowList } from "once-kernel/door";
import { SpendLimiter } from "once-kernel/budget";

const door = new OneDoor({
  budget: new SpendLimiter({ limit: 50, windowMs: 86_400_000 }), // $50/day
  policy: new AllowList(["send_email", "create_invoice"]),
});

const out = await door.pass(
  { key: `invoice:${orderId}`, payload: order, amount: 12.5, tool: "create_invoice" },
  () => stripe.invoices.create(...),
);
// out.passed === true  → ran exactly once (or replayed with the same result)
// out.passed === false → out.reason: "not_cleared" | "over_budget" | "conflict"
```

Refusals are values, not exceptions — an agent reads the reason and chooses
its next move. Storm-tested: 50 concurrent passes, one execution, budget
charged once.

### Notarised receipts — evidence an outsider can check

`receipt()` answers "did this run once?" from your own records. That is worth
everything to you and nothing to an auditor: a log you keep about yourself is a
diary entry. `ReceiptLedger` hash-chains those receipts so that editing,
deleting or reordering any entry breaks every hash after it — tampering becomes
detectable by arithmetic instead of trust.

```ts
import { ReceiptLedger, verifyChain, auditKey } from "once-kernel/ledger";

const ledger = ReceiptLedger.fromJSON(await fs.readFile("receipts.json", "utf8"));
ledger.append({
  receipt: await once.receipt(`refund:${orderId}`),
  world: "confirmed",              // a provider was asked and said yes
  worldRef: paymentIntentId,
});

verifyChain(ledger.all());          // → { ok: true, entries: 1284 }
console.log(auditKey(ledger.all(), `refund:${orderId}`));
// Chain verified: 1284 entries, unbroken.
// "refund:4471": 1 record(s), 1 completed.
// Executed once, at 2026-08-11T04:12:09.884Z. Payload hash 9f2a…
// Confirmed by the provider (pi_3Qx…).
```

`verifyChain` needs only the entries — no network, no database, not us. Hand the
file to anyone and they can check it themselves.

**What it does not claim:** a hash chain proves the sequence has not been edited
since it was written. It does not prove *who* wrote it — an operator holding the
whole file can rewrite the chain from scratch. Detached signatures are what turn
self-consistent into third-party attested, and that is a later step. It also
never conflates `confirmed` (a provider said yes) with `unconfirmed` (nobody
asked); the audit output says which, every time.

### Warn before an unguarded effect

```ts
import { guardEffect } from "once-kernel/guard";

guardEffect({
  what: "charge card",
  reversibility: "irreversible",
  idempotencyKey: paymentId,          // undefined is the case that warns
  endpointDeduplicates: "unknown",    // has the endpoint SAID it dedupes?
});
```

Warns when you're about to cause something irreversible with no dedup key
against an endpoint that has never claimed to deduplicate. It **does not block
the call** — a library that silently blocked effects would get ripped out. It
raises a flag at the moment a supervisor wants one.

### Cap what can be spent

```ts
import { SpendLimiter } from "once-kernel/budget";

const budget = new SpendLimiter({ limit: 500, windowMs: 24 * 60 * 60 * 1000 });
await budget.run({ what: "pay supplier", amount: 49 }, () => pay(49));
```

The failure this catches isn't a duplicate — it's an agent doing something
individually reasonable, repeatedly, until the money is gone. Headroom is
**reserved before the call** and settled after, because checking a running total
afterwards is a race where ten concurrent calls all see room and all proceed.

---

## What it guarantees

- **Exactly one execution per key.** 1,000 racers across real OS threads,
  released simultaneously by an `Atomics` barrier, against one shared database.
  The count is read from a *separate table*, not self-reported. Ten cold runs,
  ten times one execution — and it runs on every commit in CI.
- **Every caller gets the winner's result.** Not an error, not `undefined`.
- **A crash cannot strand a key.** The lease expires, work proceeds, and
  `generation` advances so downstream systems can fence the dead worker.
- **Same key + different payload is a conflict, not a dedupe.** Guessing which
  body wins is how money moves twice.
- **Key order in your JSON is irrelevant.** `{a,b}` and `{b,a}` are one
  operation — which matters when an LLM reformats its arguments between retries.

## What it does not do

- It cannot make a non-idempotent remote API idempotent. It stops the second
  request being *sent*; it cannot un-charge one that was.
- Not exactly-once *delivery*. That's physically impossible and anyone claiming
  it is selling you something. This is exactly-once **execution**.
- The default `MemoryStore` is single-process and dies with your program — fine
  for tests, wrong for production. Use `SqliteStore`.
- Not a queue, a scheduler, or a retry library.

---

## API

```ts
const once = new Once({
  store,                 // default: MemoryStore
  defaultTtlSec,         // how long a completed record is remembered
  defaultLeaseSec = 30,  // before a crashed worker's key is reclaimed
  maxResultBytes = 65536,
});

await once.run(key, payload, fn, { ttlSec, leaseSec, waitTimeoutMs, pollMs });
await once.status(key);
await once.receipt(key);
```

Lower level, if you need the boundary yourself:

```ts
const { execute, record } = await once.begin(key, payload);
if (!execute) return record.result;          // someone else already did it
try {
  const result = await doTheThing();
  await once.complete(key, record.fenceToken, result);
} catch (e) {
  await once.fail(key, record.fenceToken, String(e), /* allowRetry */ true);
  throw e;
}
```

`complete` and `fail` are compare-and-swap on `record.fenceToken`. A stalled
worker that wakes up after losing its lease gets `false` and changes nothing.

### Errors

| Error | Meaning |
|---|---|
| `IdempotencyConflict` | Same key, different payload. A caller bug — don't retry blindly. |
| `InProgressError` | Another caller holds the key. `run()` waits for you. |
| `WaitTimeout` | Waited past `waitTimeoutMs` for an in-flight call to settle. |
| `ResultTooLarge` | Over `maxResultBytes`. Store it elsewhere, keep a reference. |
| `CanonicalizationError` | Payload holds something JSON can't represent (`NaN`, `undefined`, `Date`, `BigInt`). Rejected rather than coerced — coercion is how two payloads collide into one hash. |
| `BudgetExceeded` | The spend ceiling refused the call. Says what, how much, and when it frees up. |

### Entry points

| Import | For |
|---|---|
| `once-kernel` | `Once`, errors, `MemoryStore` |
| `once-kernel/sqlite` | `SqliteStore` — durable, use this in production |
| `once-kernel/audit` | `findDuplicates`, `formatAuditReport` |
| `once-kernel/budget` | `SpendLimiter` |
| `once-kernel/guard` | `guardEffect`, `withGuard` |

## Storage

`SqliteStore` uses Node's built-in `node:sqlite`. Every mutation is a single SQL
statement with its guard in the `WHERE` clause, so two processes racing the same
key resolve inside the database engine — reading then writing in JavaScript
would be the exact time-of-check-to-time-of-use race this library exists to
prevent.

For Postgres or Redis, implement `Store`: `get`, `createInProgress`,
`casComplete`, `casFail`, `reclaimIfLeaseDead`, `heartbeat`. Run
`test/store-conformance.test.ts` against it — that suite *is* the contract.

## Cross-language

A port of [`once-kernel` on PyPI](https://pypi.org/project/once-kernel/), hashing
payloads **identically** via RFC 8785. A Python service and a Node service can
key the same operation and agree about whether it already ran.

Tested, not hoped for: `test/vectors/python-jcs-vectors.json` is *generated by
the Python implementation* and asserted against on every commit. Hand-written
expectations would only prove this file agrees with itself.

**Large integers:** JavaScript has one number type, and by the time `once` sees
`1234567890123456789` the parser has already rounded it. Pass large identifiers
as strings.

## Related

[`fencescan`](https://www.npmjs.com/package/fencescan) — `npx fencescan` finds
tool calls in a codebase that could fire twice.
[`effectfence`](https://github.com/aurumflux20/effectfence) — the same guarantee
as an MCP server.

## Commercial support

Free and Apache-2.0, staying that way. If you want help applying it to a codebase
that already moves money, email **hello@aurumflux.co** —
[the Fence Audit](https://github.com/aurumflux20/effectfence/blob/main/SUPPORT.md).

## Licence

Apache-2.0
