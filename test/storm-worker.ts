/**
 * One racer process in the storm proof.
 *
 * Every worker blocks on an `Atomics.wait` barrier and is released in the same
 * instant, so the contention is forced rather than hoped for. Timing-based
 * "start them all quickly" tests pass on a fast machine and prove nothing;
 * this is the JavaScript equivalent of the Rust demo's `std::sync::Barrier`.
 */
import { workerData, parentPort } from "node:worker_threads";
import { Once } from "../src/kernel.ts";
import { SqliteStore } from "../src/stores/sqlite.ts";

const { dbPath, barrier, attempts, key } = workerData as {
  dbPath: string;
  barrier: SharedArrayBuffer;
  attempts: number;
  key: string;
};

const gate = new Int32Array(barrier);
const store = new SqliteStore({ path: dbPath });
const once = new Once({ store, defaultLeaseSec: 30 });

// Announce arrival, then block until the coordinator opens the gate.
Atomics.add(gate, 1, 1);
Atomics.notify(gate, 1);
while (Atomics.load(gate, 0) === 0) {
  Atomics.wait(gate, 0, 0, 50);
}

let executed = 0;
let errors = 0;

const results = await Promise.all(
  Array.from({ length: attempts }, async () => {
    try {
      return await once.run(
        key,
        { charge: "the-one-payment" },
        async () => {
          // The effect. Recorded in the SAME database, in its own table, so
          // the count is observed rather than reported by the code under test.
          executed++;
          store["db"].prepare("INSERT INTO executions (at) VALUES (?)").run(Date.now());
          return "charged";
        },
        { waitTimeoutMs: 20_000, pollMs: 5 },
      );
    } catch (e) {
      errors++;
      return `ERR:${(e as Error).name}`;
    }
  }),
);

store.close();
parentPort!.postMessage({ executed, errors, results });
