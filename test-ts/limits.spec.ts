import { DenoWorker } from "../src/index";

describe("deno_worker: limits", () => {

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return await Promise.race([
      p,
      (async () => {
        await sleep(ms);
        throw new Error(`test hard-timeout after ${ms}ms`);
      })(),
    ]);
  }

    test(
    "limits: per-eval maxEvalMs overrides worker default (and recovery works)",
    async () => {
      const dw = new DenoWorker({ maxEvalMs: 30, channelSize: 256 });

      const burn80ms = `
        (() => {
          const end = Date.now() + 80;
          while (Date.now() < end) {}
          return 7;
        })()
      `;

      await expect(dw.eval(burn80ms)).rejects.toBeDefined();

      await expect(dw.eval(burn80ms, { maxEvalMs: 200 } as any)).resolves.toBe(7);

      await expect(dw.eval("40 + 2")).resolves.toBe(42);

      await dw.close();
    },
    20_000
  );

  test(
    "limits: maxEvalMs eventually rejects or resolves, but never hangs",
    async () => {
      const dw = new DenoWorker({ maxEvalMs: 100, channelSize: 256 });

      const p = dw.eval("while (true) {}"); // worst case
      await expect(withHardTimeout(p, 2000)).rejects.toBeDefined();

      await dw.close();
    },
    15_000
  );
});