import type { DenoWorkerOptions } from "../src/ts/types";
import type { DenoWorker } from "../src/index";

type WorkerLike = {
  isClosed: () => boolean;
  close: (options?: { force?: boolean }) => Promise<void>;
};

const trackedWorkers = new Set<WorkerLike>();

export function registerTestWorker<T extends WorkerLike>(worker: T): T {
  if (!worker) return worker;
  trackedWorkers.add(worker);

  const originalClose = worker.close.bind(worker);
  worker.close = (async (options?: { force?: boolean }) => {
    try {
      return await originalClose(options);
    } finally {
      trackedWorkers.delete(worker);
    }
  }) as WorkerLike["close"];

  return worker;
}

export function createTestWorker(options?: DenoWorkerOptions): DenoWorker {
  const runtimeIndex = require("../src/index");
  const DenoWorkerCtor = runtimeIndex.DenoWorker as { new (options?: DenoWorkerOptions): DenoWorker };
  return registerTestWorker(new DenoWorkerCtor(options));
}

export async function closeTrackedWorkers(force = true): Promise<void> {
  const workers = Array.from(trackedWorkers);
  trackedWorkers.clear();

  for (const worker of workers) {
    try {
      if (!worker.isClosed()) {
        await worker.close(force ? { force: true } : undefined);
      }
    } catch {
      // Best-effort cleanup for test teardown.
    }
  }
}
