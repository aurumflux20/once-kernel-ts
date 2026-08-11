/**
 * Notarised receipts — evidence an outsider can check.
 *
 * `receipt()` answers "did this run once?" from the operator's own records.
 * That is enough for the operator and worth nothing to anyone else: a log you
 * keep about yourself is a diary entry. An auditor, a regulator, or a customer
 * disputing a charge has no reason to believe a line you could have written
 * this morning.
 *
 * This module closes that gap with two properties:
 *
 *   1. **Append-only by construction.** Each entry carries the hash of the
 *      entry before it. Change, insert or delete anything and every hash after
 *      it stops matching — so tampering is detectable by arithmetic rather than
 *      by trust. This is the same idea as a certificate-transparency log.
 *
 *   2. **Verifiable without the writer.** `verifyChain()` needs only the
 *      entries. Not our servers, not the operator's database, not us. Hand the
 *      file to anyone; they can check it themselves.
 *
 * What this deliberately does NOT claim:
 *
 *   - **It is not a signature.** A hash chain proves *internal consistency* —
 *     that this sequence has not been edited since it was written. It does not
 *     prove *who* wrote it, and an operator who controls the whole file can
 *     rewrite the entire chain from scratch. Detached signatures (a key we hold
 *     and they do not) are what turns "self-consistent" into "third-party
 *     attested", and that is a later step, not this one. Claiming otherwise
 *     would be exactly the overclaim this project exists to refuse.
 *   - **It is not proof the effect happened in the world.** It records what the
 *     world adapter reported, and marks the difference plainly: `confirmed`
 *     means a provider was asked and said yes; `unconfirmed` means nobody asked
 *     or nobody answered. Those are not the same and must never be printed the
 *     same.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.ts";
import type { Receipt } from "./kernel.ts";

/** The empty-chain sentinel — the hash a first entry links to. */
export const GENESIS = "0".repeat(64);

export type WorldStatus = "confirmed" | "unconfirmed" | "not_applicable";

export interface LedgerEntry {
  /** Position in the chain, starting at 0. */
  seq: number;
  /** Idempotency key this entry is about. */
  key: string;
  /** Terminal state recorded for that key. */
  status: Receipt["status"];
  /** RFC 8785 hash of the payload — proves WHAT ran, not merely that it did. */
  payloadHash: string;
  /** >1 means a worker died mid-flight and another took over. */
  generation: number;
  /** Was the effect confirmed by the world, or only by us? Never conflated. */
  world: WorldStatus;
  /** Provider's own identifier for the effect, when there is one. */
  worldRef?: string;
  /** ISO-8601. Supplied by the caller: the clock is the operator's, not ours. */
  at: string;
  /** Hash of the previous entry, or GENESIS for the first. */
  prevHash: string;
  /** Hash over every field above. Changing anything changes this. */
  hash: string;
}

/** The fields that are hashed, in a fixed shape. RFC 8785 handles key order. */
function entryBody(e: Omit<LedgerEntry, "hash">) {
  return {
    seq: e.seq,
    key: e.key,
    status: e.status,
    payloadHash: e.payloadHash,
    generation: e.generation,
    world: e.world,
    worldRef: e.worldRef ?? "",
    at: e.at,
    prevHash: e.prevHash,
  };
}

function hashEntry(e: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonicalBytes(entryBody(e))).digest("hex");
}

export interface AppendInput {
  receipt: Receipt;
  /** Defaults to "unconfirmed" — the honest default when nobody asked. */
  world?: WorldStatus;
  worldRef?: string;
  /** ISO-8601 timestamp. Defaults to the receipt's own settledAt. */
  at?: string;
}

/**
 * A hash-chained, append-only receipt log.
 *
 * Storage is the caller's problem on purpose: `toJSON()` and `fromJSON()` are
 * the whole interface. A ledger that insisted on its own database would be one
 * more thing to run, and this has to be cheap enough that keeping it is never
 * the reason someone doesn't.
 */
export class ReceiptLedger {
  private entries: LedgerEntry[] = [];

  static fromJSON(json: string | LedgerEntry[]): ReceiptLedger {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (!Array.isArray(parsed)) throw new Error("ledger: expected an array of entries");
    const l = new ReceiptLedger();
    l.entries = parsed as LedgerEntry[];
    return l;
  }

  get length(): number {
    return this.entries.length;
  }

  /** The hash a next entry would link to. */
  head(): string {
    return this.entries.length ? this.entries[this.entries.length - 1]!.hash : GENESIS;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Every entry recorded for one key — the "prove this ran once" query. */
  forKey(key: string): LedgerEntry[] {
    return this.entries.filter((e) => e.key === key);
  }

  append(input: AppendInput): LedgerEntry {
    const r = input.receipt;
    const body: Omit<LedgerEntry, "hash"> = {
      seq: this.entries.length,
      key: r.key,
      status: r.status,
      payloadHash: r.payloadHash,
      generation: r.generation,
      world: input.world ?? "unconfirmed",
      worldRef: input.worldRef,
      at: input.at ?? r.settledAt,
      prevHash: this.head(),
    };
    const entry: LedgerEntry = { ...body, hash: hashEntry(body) };
    this.entries.push(entry);
    return entry;
  }

  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

export type VerifyResult =
  | { ok: true; entries: number }
  | { ok: false; entries: number; failedAt: number; reason: string };

/**
 * Check a chain end to end. Needs nothing but the entries themselves — no
 * network, no database, no us. That independence is the entire point.
 *
 * Reports the FIRST break and stops: after a broken link every later hash is
 * suspect anyway, and a list of forty consequent failures buries the one that
 * matters.
 */
export function verifyChain(entries: readonly LedgerEntry[]): VerifyResult {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) {
      return { ok: false, entries: entries.length, failedAt: i, reason: `entry ${i} claims seq ${e.seq} — an entry was inserted or removed` };
    }
    if (e.prevHash !== prev) {
      return { ok: false, entries: entries.length, failedAt: i, reason: `entry ${i} does not link to the entry before it — the chain was cut or reordered` };
    }
    const { hash, ...body } = e;
    if (hashEntry(body) !== hash) {
      return { ok: false, entries: entries.length, failedAt: i, reason: `entry ${i} has been altered since it was written` };
    }
    prev = e.hash;
  }
  return { ok: true, entries: entries.length };
}

/**
 * A plain-English audit answer for one key.
 *
 * Written for the person asking "prove this refund went out exactly once",
 * who is usually not the person who wrote the code.
 */
export function auditKey(entries: readonly LedgerEntry[], key: string): string {
  const chain = verifyChain(entries);
  if (!chain.ok) {
    return `CHAIN BROKEN at entry ${chain.failedAt}: ${chain.reason}\nNo claim about "${key}" can be trusted from this file.`;
  }
  const mine = entries.filter((e) => e.key === key);
  if (mine.length === 0) return `No record of "${key}" in ${entries.length} verified entries.`;

  const completed = mine.filter((e) => e.status === "completed");
  const confirmed = completed.filter((e) => e.world === "confirmed");
  const lines = [
    `Chain verified: ${chain.entries} entries, unbroken.`,
    `"${key}": ${mine.length} record(s), ${completed.length} completed.`,
  ];
  if (completed.length > 1) {
    lines.push(`⚠ ${completed.length} completions for one key — this is the duplicate you are looking for.`);
  } else if (completed.length === 1) {
    const c = completed[0]!;
    lines.push(`Executed once, at ${c.at}. Payload hash ${c.payloadHash.slice(0, 16)}…`);
    if (c.generation > 1) lines.push(`Generation ${c.generation}: a worker died mid-flight and another finished the work.`);
    lines.push(
      c.world === "confirmed"
        ? `Confirmed by the provider${c.worldRef ? ` (${c.worldRef})` : ""}.`
        : `NOT confirmed by any provider — this records what we did, not what the world received.`,
    );
  }
  if (confirmed.length === 0 && completed.length > 0) {
    lines.push(`Note: no world confirmation on record. Absence of confirmation is not evidence of failure — it means nobody asked.`);
  }
  return lines.join("\n");
}
