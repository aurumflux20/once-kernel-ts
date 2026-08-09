/**
 * once-audit CLI: the audit feature (`findDuplicates`) with no code required.
 *
 * The failure paths matter as much as the happy path here. A tool whose job
 * is finding money that moved twice must never guess a field mapping and
 * silently produce a wrong report -- every ambiguous input has to refuse and
 * say why, not fall back to a best-effort answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "once-audit.js");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function fixtureFile(records: unknown, filename = "records.json"): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "once-audit-cli-"));
  const path = join(dir, filename);
  writeFileSync(path, typeof records === "string" ? records : JSON.stringify(records));
  return { dir, path };
}

test("finds a same-key duplicate at high confidence", () => {
  const { dir, path } = fixtureFile([
    { id: "1", at: "2026-03-01T10:00:00Z", customer: "c1", amount: 49, k: "idem_1" },
    { id: "2", at: "2026-03-01T10:00:12Z", customer: "c1", amount: 49, k: "idem_1" },
  ]);
  try {
    const r = run([path, "--at=at", "--subject=customer", "--amount=amount", "--key=k"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[high\]/);
    assert.match(r.stdout, /same-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a monthly recurring charge is reported low-confidence, not as a duplicate", () => {
  const { dir, path } = fixtureFile([
    { id: "1", at: "2026-01-01T00:00:00Z", customer: "c1", plan: "pro" },
    { id: "2", at: "2026-02-01T00:00:00Z", customer: "c1", plan: "pro" },
    { id: "3", at: "2026-03-01T00:00:00Z", customer: "c1", plan: "pro" },
  ]);
  try {
    const r = run([path, "--at=at", "--subject=customer,plan"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[low\]/);
    assert.doesNotMatch(r.stdout, /\[high\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSONL input works the same as a JSON array", () => {
  const dir = mkdtempSync(join(tmpdir(), "once-audit-cli-"));
  const path = join(dir, "records.jsonl");
  writeFileSync(
    path,
    ['{"id":"1","at":"2026-01-01","x":1}', '{"id":"2","at":"2026-01-01","x":1}'].join("\n"),
  );
  try {
    const r = run([path, "--at=at", "--subject=x"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Examined 2 records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json emits parseable JSON matching the library's own shape", () => {
  const { dir, path } = fixtureFile([
    { id: "1", at: "2026-01-01", x: 1 },
    { id: "2", at: "2026-01-01", x: 1 },
  ]);
  try {
    const r = run([path, "--at=at", "--subject=x", "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.recordsExamined, 2);
    assert.ok(Array.isArray(parsed.groups));
    assert.ok(Array.isArray(parsed.caveats));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to run without --at and --subject rather than guessing", () => {
  const { dir, path } = fixtureFile([{ id: "1", at: "2026-01-01", x: 1 }]);
  try {
    const r = run([path]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /will not auto-detect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing file fails clearly, not silently as zero records", () => {
  const r = run(["/does/not/exist.json", "--at=at", "--subject=x"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no such file/i);
});

test("malformed JSON is rejected, not silently treated as empty", () => {
  const { dir, path } = fixtureFile("{not valid json", "bad.json");
  try {
    const r = run([path, "--at=at", "--subject=x"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mapped field missing from the data fails loudly, not with a wrong report", () => {
  // The dangerous failure mode: silently treating a missing field as undefined
  // would make every row look like it has the same (empty) subject, and
  // report unrelated records as one giant duplicate group.
  const { dir, path } = fixtureFile([{ id: "1", at: "2026-01-01", x: 1 }]);
  try {
    const r = run([path, "--at=at", "--subject=field_that_does_not_exist"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing subject field/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty array is handled, not an error", () => {
  const { dir, path } = fixtureFile([]);
  try {
    const r = run([path, "--at=at", "--subject=x"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Examined 0 records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--window-hours and --min-amount are honoured", () => {
  const { dir, path } = fixtureFile([
    { id: "1", at: "2026-01-01T00:00:00Z", x: 1, amt: 5 },
    { id: "2", at: "2026-01-01T00:00:30Z", x: 1, amt: 5 },
  ]);
  try {
    const strict = run([path, "--at=at", "--subject=x", "--amount=amt", "--min-amount=100"]);
    assert.equal(strict.code, 0);
    assert.match(strict.stdout, /No duplicate effects found/);

    const lenient = run([path, "--at=at", "--subject=x", "--amount=amt", "--min-amount=1"]);
    assert.match(lenient.stdout, /Found 1 duplicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help exits 0 and documents every flag used above", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  for (const flag of ["--at", "--subject", "--id", "--amount", "--key", "--window-hours", "--json"]) {
    assert.ok(r.stdout.includes(flag), `--help should document ${flag}`);
  }
});
