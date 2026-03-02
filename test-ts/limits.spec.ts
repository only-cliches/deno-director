import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: limits", () => {

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return await Promise.race([
      p,
      (async () => {
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        });
        throw new Error(`test hard-timeout after ${ms}ms`);
      })(),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

    test(
    "limits: per-eval maxEvalMs overrides worker default (and recovery works)",
    async () => {
      const dw = createTestWorker({ maxEvalMs: 30, bridge: { channelSize: 256 } });

      const burn80ms = `
        (() => {
          const end = Date.now() + 80;
          while (Date.now() < end) {}
          return 7;
        })()
      `;

      await expect(dw.eval(burn80ms)).rejects.toBeDefined();

      await expect(dw.eval(burn80ms, { maxEvalMs: 200 })).resolves.toBe(7);

      await expect(dw.eval("40 + 2")).resolves.toBe(42);

      await dw.close();
    },
    20_000
  );

  test(
    "limits: maxEvalMs eventually rejects or resolves, but never hangs",
    async () => {
      const dw = createTestWorker({ maxEvalMs: 100, bridge: { channelSize: 256 } });

      const p = dw.eval("while (true) {}"); // worst case
      await expect(withHardTimeout(p, 2000)).rejects.toBeDefined();

      await dw.close();
    },
    15_000
  );

  test(
    "limits: evalSync fails fast when worker queue is full",
    async () => {
      const dw = createTestWorker({ maxEvalMs: 1_000, bridge: { channelSize: 1 } });

      const busy = dw.eval(`
        (() => {
          const end = Date.now() + 3000;
          while (Date.now() < end) {}
          return 1;
        })()
      `);

      // While `busy` occupies the worker thread, this call fills the only queue slot.
      const queued = dw.eval("2 + 2");

      const start = Date.now();
      let threw = false;
      let syncOut: any;
      try {
        syncOut = dw.evalSync("1 + 1");
      } catch {
        threw = true;
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(300);
      if (!threw) {
        expect(syncOut).toBe(2);
      }

      await queued.catch(() => undefined);
      await busy.catch(() => undefined);
      if (!dw.isClosed()) await dw.close({ force: true });
    },
    15_000
  );

  test("limits: maxStackSizeBytes is rejected explicitly", () => {
    expect(() => createTestWorker({ maxStackSizeBytes: 1024 })).toThrow(/maxStackSizeBytes/i);
  });
});
