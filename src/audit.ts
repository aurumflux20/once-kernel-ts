/**
 * Find duplicate effects that ALREADY happened.
 *
 * Every other part of this library prevents a future loss, which means asking
 * someone who has never been burned to restructure their code against a bug
 * they cannot see. This module inverts that: point it at records you already
 * have — a payments table, a send log, a CSV export — and it tells you what
 * fired twice last month.
 *
 * It requires adopting nothing. There is no store to install and no call site
 * to change. That is deliberate: the answer is worth money before the fix is.
 *
 * The hard part is not finding equal rows. It is deciding what "the same
 * operation" means when nobody was tracking one — and being honest about the
 * cases where we are guessing. Every result carries the reason it was flagged
 * and a confidence, because a wrong duplicate accusation sends someone chasing
 * a refund that never happened.
 */

import { payloadHashHex } from "./canonical.ts";

export interface EffectRecord {
  /** Anything that identifies the row for a human: an id, a URL, a row number. */
  id: string;
  /** When it happened. Epoch ms, or anything Date can parse. */
  at: number | string | Date;
  /**
   * The fields that define WHAT was done. Two records with the same subject are
   * the same operation — so leave out timestamps, trace ids, retry counters and
   * anything else that differs between attempts of one operation.
   */
  subject: Record<string, unknown>;
  /** Optional: what it cost. Used to total the exposure. */
  amount?: number;
  /** Optional: an idempotency key, if the system had one. */
  key?: string;
}

export type DuplicateReason =
  | "same-key"
  | "identical-subject-within-window"
  | "identical-subject";

export interface DuplicateGroup {
  reason: DuplicateReason;
  /** How much to trust it. Explained in `note`. */
  confidence: "high" | "medium" | "low";
  note: string;
  subjectHash: string;
  records: EffectRecord[];
  /** Extra occurrences beyond the first — the ones that should not exist. */
  duplicateCount: number;
  /** Cost of those extra occurrences, if amounts were supplied. */
  duplicateAmount?: number;
  /** Milliseconds between first and last occurrence. */
  spanMs: number;
}

export interface AuditReport {
  recordsExamined: number;
  groups: DuplicateGroup[];
  totalDuplicates: number;
  totalDuplicateAmount?: number;
  /** Stated in the report itself so a reader cannot mistake it for certainty. */
  caveats: string[];
}

export interface AuditOptions {
  /**
   * Two identical subjects further apart than this are treated as a deliberate
   * repeat rather than a duplicate. Default 24h.
   *
   * This is the judgement call of the whole module. A subscription charged on
   * the 1st of each month is identical and legitimate; the same charge twice in
   * ten seconds is not. Outside the window we still report, at low confidence,
   * clearly labelled — because sometimes it IS a duplicate, and silently hiding
   * it would be the worse error.
   */
  windowMs?: number;
  /** Ignore groups whose duplicates are worth less than this. */
  minAmount?: number;
}

const ms = (v: number | string | Date): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);

/**
 * Group records by what they did, and report which groups happened more than
 * once. Pure — no I/O, no store, nothing to install.
 */
export function findDuplicates(
  records: EffectRecord[],
  opts: AuditOptions = {},
): AuditReport {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;

  // An explicit key, where one exists, beats any inference we could make.
  const byKey = new Map<string, EffectRecord[]>();
  const bySubject = new Map<string, EffectRecord[]>();

  for (const r of records) {
    if (r.key) {
      const g = byKey.get(r.key) ?? [];
      g.push(r);
      byKey.set(r.key, g);
    } else {
      const h = payloadHashHex(r.subject);
      const g = bySubject.get(h) ?? [];
      g.push(r);
      bySubject.set(h, g);
    }
  }

  const groups: DuplicateGroup[] = [];

  const make = (
    recs: EffectRecord[],
    reason: DuplicateReason,
    confidence: DuplicateGroup["confidence"],
    note: string,
    hash: string,
  ): DuplicateGroup => {
    const sorted = [...recs].sort((a, b) => ms(a.at) - ms(b.at));
    const extra = sorted.slice(1);
    const amounts = extra.map((r) => r.amount).filter((a): a is number => typeof a === "number");
    return {
      reason,
      confidence,
      note,
      subjectHash: hash,
      records: sorted,
      duplicateCount: extra.length,
      duplicateAmount: amounts.length ? amounts.reduce((a, b) => a + b, 0) : undefined,
      spanMs: ms(sorted[sorted.length - 1]!.at) - ms(sorted[0]!.at),
    };
  };

  for (const [key, recs] of byKey) {
    if (recs.length < 2) continue;
    groups.push(
      make(
        recs,
        "same-key",
        "high",
        `The system's own idempotency key ${JSON.stringify(key)} appears on ` +
          `${recs.length} separate effects. If the key means what it says, this is a duplicate.`,
        key,
      ),
    );
  }

  for (const [hash, recs] of bySubject) {
    if (recs.length < 2) continue;
    const sorted = [...recs].sort((a, b) => ms(a.at) - ms(b.at));
    // Split the group at gaps larger than the window, so a monthly charge
    // becomes twelve legitimate singles rather than one twelve-fold duplicate.
    let run: EffectRecord[] = [sorted[0]!];
    const runs: EffectRecord[][] = [];
    for (let i = 1; i < sorted.length; i++) {
      if (ms(sorted[i]!.at) - ms(sorted[i - 1]!.at) <= windowMs) run.push(sorted[i]!);
      else {
        runs.push(run);
        run = [sorted[i]!];
      }
    }
    runs.push(run);

    const clustered = runs.filter((r) => r.length >= 2);
    for (const r of clustered) {
      groups.push(
        make(
          r,
          "identical-subject-within-window",
          "medium",
          `${r.length} effects with an identical subject inside ${Math.round(windowMs / 3600000)}h. ` +
            `No idempotency key was recorded, so this is inferred from the payload — ` +
            `check that nothing distinguishing was left out of \`subject\`.`,
          hash,
        ),
      );
    }
    // Repeats spread beyond the window: reported, but flagged low, because a
    // recurring charge looks exactly like this and usually is not a bug.
    if (clustered.length === 0 && runs.length >= 2) {
      groups.push(
        make(
          sorted,
          "identical-subject",
          "low",
          `${sorted.length} identical effects spread over time. This is what a legitimate ` +
            `recurring charge looks like — reported so you can rule it out, not because it is wrong.`,
          hash,
        ),
      );
    }
  }

  const filtered =
    opts.minAmount === undefined
      ? groups
      : groups.filter((g) => (g.duplicateAmount ?? 0) >= opts.minAmount!);

  const rank = { high: 0, medium: 1, low: 2 } as const;
  filtered.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      (b.duplicateAmount ?? 0) - (a.duplicateAmount ?? 0) ||
      b.duplicateCount - a.duplicateCount,
  );

  const amounts = filtered
    .map((g) => g.duplicateAmount)
    .filter((a): a is number => typeof a === "number");

  return {
    recordsExamined: records.length,
    groups: filtered,
    totalDuplicates: filtered.reduce((n, g) => n + g.duplicateCount, 0),
    totalDuplicateAmount: amounts.length ? amounts.reduce((a, b) => a + b, 0) : undefined,
    caveats: [
      "A duplicate here means two records described the same operation — not that money definitely moved twice. Confirm against the provider before acting.",
      "Anything left out of `subject` makes two different operations look identical. Anything varying that was left IN hides real duplicates.",
      "Low-confidence groups are usually legitimate recurring activity. They are shown so you can rule them out.",
    ],
  };
}

/** Render a report for a human. Money first, uncertainty stated. */
export function formatAuditReport(r: AuditReport): string {
  const out: string[] = [];
  out.push(`Examined ${r.recordsExamined} records.`);
  if (r.groups.length === 0) {
    out.push("No duplicate effects found.");
    out.push("That is this check finding nothing — not proof the system is safe.");
    return out.join("\n");
  }
  out.push(
    `Found ${r.totalDuplicates} duplicate occurrence(s) across ${r.groups.length} group(s)` +
      (r.totalDuplicateAmount !== undefined
        ? `, worth ${r.totalDuplicateAmount} in repeated effects.`
        : "."),
  );
  out.push("");
  for (const g of r.groups.slice(0, 20)) {
    const amt = g.duplicateAmount !== undefined ? `  (${g.duplicateAmount})` : "";
    out.push(`[${g.confidence}] ${g.duplicateCount} extra${amt} — ${g.reason}`);
    out.push(`  ${g.note}`);
    out.push(`  ids: ${g.records.map((x) => x.id).join(", ")}`);
    out.push("");
  }
  out.push("Before acting:");
  for (const c of r.caveats) out.push(`  · ${c}`);
  return out.join("\n");
}
