# Provider Truth Atlas

**What actually happens when you retry a request to a real provider.**

Everyone assumes. "Stripe dedupes on idempotency keys." "Gmail collapses duplicate Message-IDs." "Resend probably handles it." These beliefs get built into retry logic and are almost never checked.

This file exists to replace assumption with measurement. Every row is marked with how we know:

| Mark | Meaning |
|---|---|
| **MEASURED** | We sent the requests and recorded what happened. Method and date given. |
| **DOCUMENTED** | The provider states it. We have not verified it ourselves. |
| **UNKNOWN** | Nobody has checked, including us. Said plainly rather than guessed. |

A DOCUMENTED row is not a MEASURED row. Vendors describe intent; systems have behaviour. Where they disagree, the measurement wins and we will say so.

---

## Why this matters

A retry is only safe if you know two things about the provider:

1. **Does a duplicate request create a duplicate effect?** (dedup on write)
2. **Can you ask afterwards whether the effect exists?** (confirmation on read)

A provider that offers neither means the guard must be entirely client-side, before the call. A provider that offers both can rescue an ambiguous timeout. Most sit in between, and the details — key lifetime, what counts as "the same request", what a 200 with a failure status means — decide whether real code is correct or merely lucky.

---

## Resend (transactional email)

| Property | Answer | How we know |
|---|---|---|
| Lookup a sent message by id | **Yes** — `GET /emails/{id}` | **MEASURED** 2026-07-11. Built after our own mailer reported 16 emails as sent when none had verifiably left; the lookup is what exposed it. Works on a sending-scoped key (unlike `/domains`, which 403s — different permission scope). |
| Dedup on repeated identical send | **UNKNOWN** | Not measured. Do not assume. |
| Idempotency key on send | **DOCUMENTED** (`Idempotency-Key` header) | Not yet measured by us: key lifetime and what counts as the same request are unverified. |
| Status meaning | `last_event` is a lifecycle, not a boolean | **MEASURED**. `bounced` means **the send happened** and delivery failed downstream — the effect exists. Treating a bounce as "never sent" and re-sending is a duplicate. |

**Implication for the adapter:** confirmation is reliable; prevention is not established. Guard client-side, confirm after.

## Stripe (payments)

| Property | Answer | How we know |
|---|---|---|
| Lookup by id | **Yes** — `GET /v1/payment_intents/{id}` | **DOCUMENTED** |
| Idempotency keys on create | **DOCUMENTED**, 24h retention | Not measured by us. The 24h window is the part most code gets wrong — a retry after expiry is a fresh charge. |
| `canceled` status | Effect **exists**, was cancelled | **DOCUMENTED**. Not the same as absent; our adapter reports it as confirmed. |

## Everything else

**UNKNOWN.** Twilio, SendGrid, Slack, GitHub, Postmark, SES and the rest have not been measured by us. They are absent from this file on purpose rather than filled in from documentation, because a table of vendor claims dressed as measurements would be worse than no table.

---

## Method (so anyone can repeat or refute this)

For each provider:

1. Send an identical request twice with the same idempotency key → count the effects created.
2. Send an identical request twice with **no** key → count the effects created.
3. Send once, then look the effect up by id → does confirmation work at all?
4. Look up an id that does not exist → is the answer distinguishable from an error? (If a provider returns the same shape for "no such thing" and "I'm broken", confirmation is unusable and we say so.)
5. Where a key exists, retry after the documented window → does dedup still hold?

Every measurement records the date, because provider behaviour changes and a stale measurement asserted as current is the same failure this whole project is about.

**Live measurement sends real requests from real accounts and costs real money.** Rows move from UNKNOWN/DOCUMENTED to MEASURED only after an authorised run, never from reading docs.

---

*Adapters implementing this: [`once-kernel/confirm`](../src/confirm.ts). The three-state result (`confirmed` / `absent` / `unknown`) exists because of row 4 above — "I could not find out" is a distinct answer from "it did not happen", and collapsing them is the bug this library exists to prevent.*
