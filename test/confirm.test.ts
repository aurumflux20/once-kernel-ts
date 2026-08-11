/**
 * World confirmation — and above all, the third answer.
 *
 * Most of these tests exist to prove one thing: "I could not find out" never
 * decays into "it didn't happen". That collapse is the double-charge bug, and
 * it is the reason this module has three states instead of a boolean.
 *
 * Every test mocks fetch. Nothing here touches a real provider, sends a real
 * email, or spends a real cent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  httpConfirmer,
  resendConfirmer,
  resolveAfterTimeout,
  stripeConfirmer,
  type Confirmer,
} from "../src/confirm.ts";

/** A fetch stand-in that answers with a fixed status/body. */
function fakeFetch(status: number, body?: unknown, opts: { throws?: Error } = {}) {
  return (async () => {
    if (opts.throws) throw opts.throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error("not json");
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const generic = (f: typeof fetch): Confirmer =>
  httpConfirmer({ provider: "test", url: (r) => `https://x.test/${r}`, fetchImpl: f });

test("200 means the effect exists", async () => {
  const c = await generic(fakeFetch(200, { id: "abc" })).lookup("abc");
  assert.equal(c.state, "confirmed");
});

test("404 is the ONLY status that means absent", async () => {
  const c = await generic(fakeFetch(404)).lookup("abc");
  assert.equal(c.state, "absent");
});

test("401 is unknown, not absent — it describes our access, not the effect", async () => {
  const c = await generic(fakeFetch(401, { error: "bad key" })).lookup("abc");
  assert.equal(c.state, "unknown");
  assert.match(c.reason ?? "", /says nothing about whether the effect exists/);
});

test("500 is unknown, not absent — the provider is unwell, the charge may exist", async () => {
  const c = await generic(fakeFetch(500)).lookup("abc");
  assert.equal(c.state, "unknown");
});

test("429 is unknown — being rate limited tells us nothing about the effect", async () => {
  const c = await generic(fakeFetch(429)).lookup("abc");
  assert.equal(c.state, "unknown");
});

test("a network failure is unknown, never absent", async () => {
  const c = await generic(fakeFetch(0, undefined, { throws: new Error("ECONNRESET") })).lookup("abc");
  assert.equal(c.state, "unknown");
  assert.match(c.reason ?? "", /ECONNRESET/);
});

test("a timeout is unknown — the exact case that starts the whole problem", async () => {
  const err = new Error("The operation was aborted due to timeout");
  const c = await generic(fakeFetch(0, undefined, { throws: err })).lookup("abc");
  assert.equal(c.state, "unknown");
});

test("an empty reference is unknown, not absent", async () => {
  // Nothing was recorded at execution time. We cannot conclude the effect
  // never happened — only that we failed to write down its handle.
  const c = await generic(fakeFetch(404)).lookup("");
  assert.equal(c.state, "unknown");
  assert.match(c.reason ?? "", /nothing was recorded/);
});

test("a 200 body we cannot parse is still confirmation — the id resolved", async () => {
  const c = await generic(fakeFetch(200)).lookup("abc");
  assert.equal(c.state, "confirmed");
});

// ── provider adapters ───────────────────────────────────────────────────────

test("resend: a bounced email is CONFIRMED — the send happened, delivery failed", async () => {
  // This distinction is load-bearing. "bounced" is not "never sent"; silently
  // re-sending a bounce is a decision for a human, not a retry.
  const c = await resendConfirmer("k", fakeFetch(200, { id: "re_1", last_event: "bounced" })).lookup("re_1");
  assert.equal(c.state, "confirmed");
  assert.equal(c.providerStatus, "bounced");
});

test("resend: a delivered email is confirmed with its provider status", async () => {
  const c = await resendConfirmer("k", fakeFetch(200, { id: "re_2", last_event: "delivered" })).lookup("re_2");
  assert.equal(c.state, "confirmed");
  assert.equal(c.ref, "re_2");
});

test("resend: an unknown id is absent", async () => {
  const c = await resendConfirmer("k", fakeFetch(404)).lookup("re_missing");
  assert.equal(c.state, "absent");
});

test("stripe: a canceled intent is CONFIRMED — it exists, it was cancelled", async () => {
  const c = await stripeConfirmer("sk", fakeFetch(200, { id: "pi_1", status: "canceled" })).lookup("pi_1");
  assert.equal(c.state, "confirmed");
  assert.equal(c.providerStatus, "canceled");
});

test("stripe: a succeeded intent is confirmed", async () => {
  const c = await stripeConfirmer("sk", fakeFetch(200, { id: "pi_2", status: "succeeded" })).lookup("pi_2");
  assert.equal(c.state, "confirmed");
});

// ── the resolver: what to DO about it ───────────────────────────────────────

test("confirmed → replay, never re-run", async () => {
  const r = await resolveAfterTimeout({ confirmer: generic(fakeFetch(200, { id: "a" })), ref: "a" });
  assert.equal(r.action, "replay");
});

test("absent → safe to execute", async () => {
  const r = await resolveAfterTimeout({ confirmer: generic(fakeFetch(404)), ref: "a" });
  assert.equal(r.action, "execute");
});

test("unknown → ESCALATE, and never quietly execute", async () => {
  // The single most important assertion in this file. A boolean API would
  // return false here and duplicate the charge.
  const r = await resolveAfterTimeout({ confirmer: generic(fakeFetch(503)), ref: "a" });
  assert.equal(r.action, "escalate");
  assert.notEqual(r.action, "execute");
  if (r.action === "escalate") assert.match(r.why, /may duplicate/);
});

test("unknown from a network error also escalates", async () => {
  const r = await resolveAfterTimeout({
    confirmer: generic(fakeFetch(0, undefined, { throws: new Error("dns") })),
    ref: "a",
  });
  assert.equal(r.action, "escalate");
});
