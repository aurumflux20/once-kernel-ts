#!/usr/bin/env node
/**
 * once-audit — find duplicate effects in records you already have.
 *
 *   npx once-kernel-audit records.json --at=created_at --subject=customer,amount --amount=amount --key=idempotency_key
 *
 * No code, no adoption, no store to install. Reads a JSON array (or JSONL) of
 * records exported from wherever you already keep them — a payments table, a
 * send log — and reports which look like the same operation happening more
 * than once.
 *
 * JSON only, deliberately. A CSV parser has quoting and encoding edge cases
 * that are easy to get subtly wrong, and a silent misparse here is the worst
 * possible failure mode: a tool whose whole job is finding money that moved
 * twice must not itself introduce an error nobody notices. Export to JSON
 * first (a spreadsheet's "Export as JSON," or `jq -s .` on JSONL) rather than
 * trust an unaudited CSV reader with financial records.
 *
 * Field mapping is EXPLICIT, never guessed. Auto-detecting which columns
 * mean "the same operation" would be guessing at the one judgment call this
 * whole library exists to get right — get it wrong and you either miss real
 * duplicates or flag legitimate repeats (a recurring subscription looks
 * exactly like a duplicate). You choose the fields; the tool does the
 * comparison honestly once you have.
 */
import { readFileSync } from "node:fs";
import { findDuplicates, formatAuditReport } from "../dist/audit.js";

function parseArgs(argv) {
  const out = { _: [], windowMs: undefined, minAmount: undefined, json: false };
  const fields = { id: undefined, at: undefined, subject: undefined, amount: undefined, key: undefined };
  for (const a of argv) {
    if (a === "--json") { out.json = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) { out._.push(a); continue; }
    const [, k, v] = m;
    if (k === "id") fields.id = v;
    else if (k === "at") fields.at = v;
    else if (k === "subject") fields.subject = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "amount") fields.amount = v;
    else if (k === "key") fields.key = v;
    else if (k === "window-hours") out.windowMs = Number(v) * 3600_000;
    else if (k === "min-amount") out.minAmount = Number(v);
    else out._.push(a);
  }
  return { out, fields };
}

const HELP = `once-audit — find duplicate effects in records you already have.

Usage:
  npx once-kernel-audit <file.json> --at=<field> --subject=<field1,field2,...> [options]

Required:
  --at=FIELD             which field holds the timestamp
  --subject=FIELDS       comma-separated fields that define WHAT was done
                         (e.g. --subject=customer_id,amount). Leave out
                         anything that varies between retries of the SAME
                         operation (timestamps, trace ids, retry counters) --
                         leave IN anything that makes two operations
                         genuinely different (payee, currency, plan).

Optional:
  --id=FIELD             a human-readable row identifier (default: row index)
  --amount=FIELD         numeric field, used to total duplicate exposure
  --key=FIELD            an existing idempotency key column, if you have one
                         (checked before --subject, and reported at high
                         confidence when it matches)
  --window-hours=N       treat repeats further apart than this as probably
                         legitimate (default 24). A subscription charged
                         monthly must not be reported as a duplicate.
  --min-amount=N         ignore duplicate groups worth less than this
  --json                 machine-readable output

Input file: a JSON array of objects, or JSONL (one object per line).

Example:
  npx once-kernel-audit payments.json --at=created_at --subject=customer,plan --amount=amount --key=idem_key
`;

function loadRecords(path) {
  const raw = readFileSync(path, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${path} is empty`);
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error(`${path} does not contain a JSON array`);
    return parsed;
  }
  // JSONL: one JSON object per non-empty line.
  return trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${path}:${i + 1} is not valid JSON (${e.message})`);
      }
    });
}

function main() {
  const { out, fields } = parseArgs(process.argv.slice(2));

  if (out.help || out._.length === 0) {
    console.log(HELP);
    process.exit(out.help ? 0 : 2);
  }

  const path = out._[0];
  if (!fields.at || !fields.subject) {
    console.error(
      "once-audit: --at and --subject are required -- guessing which fields identify " +
        "\"the same operation\" is exactly the judgment call this tool exists to get right, " +
        "so it will not auto-detect them.\n\nRun with --help for the field reference.",
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = loadRecords(path);
  } catch (e) {
    console.error(`once-audit: ${e.message}`);
    process.exit(2);
  }

  const missing = [];
  const records = raw.map((row, i) => {
    if (!(fields.at in row)) missing.push(`row ${i}: missing "${fields.at}"`);
    const subject = {};
    for (const f of fields.subject) {
      if (!(f in row)) missing.push(`row ${i}: missing subject field "${f}"`);
      subject[f] = row[f];
    }
    return {
      id: fields.id && row[fields.id] !== undefined ? String(row[fields.id]) : String(i),
      at: row[fields.at],
      subject,
      amount: fields.amount ? Number(row[fields.amount]) : undefined,
      key: fields.key ? row[fields.key] : undefined,
    };
  });

  if (missing.length) {
    console.error(
      `once-audit: ${missing.length} row(s) are missing a mapped field -- refusing to guess ` +
        `a value and silently under- or over-count duplicates.\n` +
        missing.slice(0, 10).join("\n") +
        (missing.length > 10 ? `\n...and ${missing.length - 10} more` : ""),
    );
    process.exit(2);
  }

  const report = findDuplicates(records, {
    windowMs: out.windowMs,
    minAmount: out.minAmount,
  });

  if (out.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatAuditReport(report));
  }

  process.exit(0);
}

main();
