/**
 * World confirmation — asking the provider whether the effect actually exists.
 *
 * Everything else in this library reasons about our own records. That is the
 * cheap half of the problem. The expensive half is the question an operator
 * asks at 3am: *the call timed out — did it land?* Our database cannot answer
 * that. It only knows what we did, not what arrived.
 *
 * A confirmer asks the system of record. Three outcomes, and the difference
 * between them is the whole point:
 *
 *   - `confirmed`   — the provider has it. Replay; never re-run.
 *   - `absent`      — the provider does not have it, asked properly. Safe to run.
 *   - `unknown`     — we could not find out (network down, no permission, the
 *                     provider has no way to look it up). **This is not
 *                     `absent`.** Treating "I don't know" as "it didn't happen"
 *                     is precisely how a retry becomes a double charge, and it
 *                     is the most common mistake in code that tries to do this.
 *
 * Everything here is built to make that third case impossible to lose by
 * accident: it is a distinct value, it carries a reason, and nothing collapses
 * it into a boolean.
 */

/** What the world says about one effect. */
export type WorldState = "confirmed" | "absent" | "unknown";

export interface Confirmation {
  state: WorldState;
  /** Provider's own id for the effect, when it has one. */
  ref?: string;
  /** Provider-specific status string, verbatim — never interpreted here. */
  providerStatus?: string;
  /** Why we could not tell. Present only when state is "unknown". */
  reason?: string;
}

/**
 * A provider-specific confirmer.
 *
 * `lookup` receives whatever handle the caller stored at execution time (a
 * message id, a payment intent id, an idempotency key) and reports what the
 * provider says about it.
 */
export interface Confirmer {
  /** Provider name, for receipts and the atlas. */
  readonly provider: string;
  lookup(ref: string): Promise<Confirmation>;
}

export interface HttpConfirmerOptions {
  provider: string;
  /** Build the lookup URL for a given ref. */
  url: (ref: string) => string;
  headers?: Record<string, string>;
  /** Milliseconds before we give up and answer "unknown". */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Decide what a 200 body means. Return `undefined` to accept the default:
   * a 200 means confirmed. Providers that return 200 with a "deleted" or
   * "failed" status need this hook.
   */
  interpret?: (body: unknown) => Confirmation | undefined;
}

/**
 * The general shape: GET the resource, and map the response honestly.
 *
 * 404 is the only status treated as `absent`, and only because it is the one
 * status that means "this identifier is not known here". A 401, 403, 429 or
 * 500 tells us about our access or their health, nothing about the effect —
 * those are `unknown`, loudly.
 */
export function httpConfirmer(opts: HttpConfirmerOptions): Confirmer {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    provider: opts.provider,
    async lookup(ref: string): Promise<Confirmation> {
      if (!ref) {
        return { state: "unknown", reason: "no reference to look up — nothing was recorded at execution time" };
      }
      let res: Response;
      try {
        res = await doFetch(opts.url(ref), {
          method: "GET",
          headers: opts.headers ?? {},
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A failed lookup is not a zero. We genuinely do not know.
        const msg = err instanceof Error ? err.message : String(err);
        return { state: "unknown", reason: `lookup failed: ${msg}` };
      }

      if (res.status === 404) {
        return { state: "absent", providerStatus: "404" };
      }
      if (!res.ok) {
        return {
          state: "unknown",
          providerStatus: String(res.status),
          reason: `provider answered ${res.status} — this says nothing about whether the effect exists`,
        };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        // A 200 we cannot parse still tells us the id resolved.
        return { state: "confirmed", ref, providerStatus: "200" };
      }

      const custom = opts.interpret?.(body);
      if (custom) return custom;
      return { state: "confirmed", ref, providerStatus: "200" };
    },
  };
}

/**
 * Resend — the first adapter, because it is the path we run in production and
 * the one that burned us: our own mailer once reported 16 emails as sent when
 * none had verifiably left, because it trusted its own status field.
 *
 * `GET /emails/{id}` is a read, permitted on a sending-scoped key (unlike
 * /domains, which 403s — a different permission scope, learned the hard way).
 *
 * MEASURED BEHAVIOUR: see docs/PROVIDER-ATLAS.md. Anything not measured is
 * marked as claimed-not-measured there rather than asserted here.
 */
export function resendConfirmer(apiKey: string, fetchImpl?: typeof fetch): Confirmer {
  return httpConfirmer({
    provider: "resend",
    url: (id) => `https://api.resend.com/emails/${encodeURIComponent(id)}`,
    headers: { Authorization: `Bearer ${apiKey}` },
    fetchImpl,
    interpret: (body) => {
      const b = body as Record<string, unknown> | null;
      const status = (b?.last_event ?? b?.status) as string | undefined;
      if (!status) return undefined;
      // Resend reports a lifecycle, not a boolean. "bounced" still means the
      // send HAPPENED — the effect exists, it simply failed downstream. That
      // distinction matters: re-sending a bounced message is a decision for a
      // human, not something a retry should do silently.
      return { state: "confirmed", ref: String(b?.id ?? ""), providerStatus: status };
    },
  });
}

/**
 * Stripe — payment intents, looked up by id.
 *
 * Stripe additionally supports idempotency keys on creation, which is a
 * different mechanism from confirmation: the key prevents a duplicate, the
 * lookup tells you whether one exists. We use both, and never assume the first
 * makes the second unnecessary.
 */
export function stripeConfirmer(apiKey: string, fetchImpl?: typeof fetch): Confirmer {
  return httpConfirmer({
    provider: "stripe",
    url: (id) => `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}`,
    headers: { Authorization: `Bearer ${apiKey}` },
    fetchImpl,
    interpret: (body) => {
      const b = body as Record<string, unknown> | null;
      const status = b?.status as string | undefined;
      if (!status) return undefined;
      // canceled means the intent EXISTS and was cancelled — still confirmed.
      return { state: "confirmed", ref: String(b?.id ?? ""), providerStatus: status };
    },
  });
}

export interface ResolveOptions {
  confirmer: Confirmer;
  /** Provider handle recorded when the effect was executed. */
  ref: string;
}

export type Resolution =
  | { action: "replay"; confirmation: Confirmation }
  | { action: "execute"; confirmation: Confirmation }
  | { action: "escalate"; confirmation: Confirmation; why: string };

/**
 * The timeout resolver: given a handle, say what to do next.
 *
 * This is deliberately three-valued. Most implementations of this idea return
 * a boolean and quietly turn `unknown` into `execute`, which is the double-fire
 * bug wearing a helpful face. Here, not knowing escalates to a human — the only
 * honest answer when the effect is irreversible.
 */
export async function resolveAfterTimeout(opts: ResolveOptions): Promise<Resolution> {
  const c = await opts.confirmer.lookup(opts.ref);
  if (c.state === "confirmed") return { action: "replay", confirmation: c };
  if (c.state === "absent") return { action: "execute", confirmation: c };
  // The reason explains why we cannot tell; the consequence explains what is
  // at stake. A human deciding at 3am needs both, so both are always present.
  const cause = c.reason ?? "the provider could not tell us whether this effect exists";
  return {
    action: "escalate",
    confirmation: c,
    why: `${cause} — re-running may duplicate it, so this needs a human decision`,
  };
}
