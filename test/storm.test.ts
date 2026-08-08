/**
 * THE STORM PROOF — the claim this package is named for.
 *
 * 1,000 attempts to run the same operation, spread across real OS threads,
 * all released at the same instant by an `Atomics.wait` barrier, against one
 * shared SQLite file. Exactly one execution must occur.
 *
 * Two rules this test exists to obey:
 *
 *   1. The count is OBSERVED, not reported. Each execution inserts a row into
 *      a separate `executions` table; the assertion reads that table. Code
 *      under test counting its own invocations proves nothing.
 *   2. Simultaneity is FORCED, not hoped for. Workers block on a barrier and
 *      are released together. Spawning them quickly and trusting the scheduler
 *      passes on a fast machine and is worthless as evidence.
 *
 * If this fails, the package does not ship. There is no version of "mostly
 * once" worth publishing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/stores/sqlite.ts";

const here = dirname(fileURLToPath(import.meta.url));

const TOTAL_ATTEMPTS = 1000;
const WORKERS = Math.max(4, Math.min(16, cpus().length));

test(
  `${TOTAL_ATTEMPTS} racers across ${WORKERS} real threads elect exactly one execution`,
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "once-storm-"));
    const dbPath = join(dir, "storm.db");

    try {
      // Create the schema and the observation table up front, so no worker
      // races to create it.
      const setup = new SqliteStore({ path: dbPath });
      setup["db"].exec("CREATE TABLE IF NOT EXISTS executions (at INTEGER NOT NULL)");
      setup.close();

      // gate[0] = release flag, gate[1] = arrived count
      const barrier = new SharedArrayBuffer(8);
      const gate = new Int32Array(barrier);

      const perWorker = Math.floor(TOTAL_ATTEMPTS / WORKERS);
      const remainder = TOTAL_ATTEMPTS - perWorker * WORKERS;

      const workers = Array.from({ length: WORKERS }, (_, i) => {
        const attempts = perWorker + (i < remainder ? 1 : 0);
        const w = new Worker(join(here, "storm-worker.ts"), {
          workerData: { dbPath, barrier, attempts, key: "the-one-payment" },
          execArgv: ["--experimental-strip-types", "--no-warnings"],
        });
        return new Promise<{ executed: number; errors: number; results: string[] }>(
          (resolve, reject) => {
            w.once("message", resolve);
            w.once("error", reject);
            w.once("exit", (code) => {
              if (code !== 0) reject(new Error(`worker exited with ${code}`));
            });
          },
        );
      });

      // Wait for every worker to reach the barrier, then release them together.
      const deadline = Date.now() + 30_000;
      while (Atomics.load(gate, 1) < WORKERS) {
        if (Date.now() > deadline) throw new Error("workers never reached the barrier");
        await new Promise((r) => setTimeout(r, 10));
      }
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);

      const reports = await Promise.all(workers);

      // THE ASSERTION: read the observation table, not the workers' self-reports.
      const db = new DatabaseSync(dbPath);
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM executions").get() as { n: number };
      db.close();

      const attempted = reports.reduce((a, r) => a + r.results.length, 0);
      const selfReported = reports.reduce((a, r) => a + r.executed, 0);
      const errored = reports.reduce((a, r) => a + r.errors, 0);
      const charged = reports.reduce(
        (a, r) => a + r.results.filter((x) => x === "charged").length,
        0,
      );

      assert.equal(attempted, TOTAL_ATTEMPTS, "every attempt should be accounted for");
      assert.equal(errored, 0, "no caller should have been left with an error");
      assert.equal(
        n,
        1,
        `the effect ran ${n} times across ${TOTAL_ATTEMPTS} racers — anything but 1 means this library does not work`,
      );
      assert.equal(selfReported, 1, "workers' own count must agree with the observed table");
      assert.equal(
        charged,
        TOTAL_ATTEMPTS,
        "every caller must receive the winner's result, not an error",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
