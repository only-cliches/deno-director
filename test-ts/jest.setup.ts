import { closeTrackedWorkers, registerTestWorker } from "./helpers.worker-harness";

jest.mock("../src/index", () => {
  const actual = jest.requireActual("../src/index");
  const OriginalDenoWorker = actual.DenoWorker as {
    new (...args: unknown[]): { isClosed: () => boolean; close: (options?: { force?: boolean }) => Promise<void> };
  };

  class TrackedDenoWorker extends OriginalDenoWorker {
    constructor(...args: unknown[]) {
      super(...args);
      registerTestWorker(this);
    }
  }

  return {
    ...actual,
    DenoWorker: TrackedDenoWorker,
    default: TrackedDenoWorker,
  };
});

afterEach(async () => {
  await closeTrackedWorkers(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
});
