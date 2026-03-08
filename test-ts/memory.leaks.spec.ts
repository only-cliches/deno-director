import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";
import { sleep } from "./helpers.time";

async function evalArgsLeakKeyCount(dw: DenoWorker): Promise<number> {
  return await dw.eval<number>(
    `
      Object.keys(globalThis)
        .filter((k) => k.startsWith("__denojs_worker_eval_args_"))
        .length
    `,
  );
}

async function usedHeap(dw: DenoWorker): Promise<number> {
  const mem = await dw.stats.memory();
  return Number(mem.heapStatistics.usedHeapSize ?? 0);
}

describe("deno_worker: memory leaks", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = createTestWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("eval/module.eval with $args cleanup leaves no temp global keys behind", async () => {
    expect(await evalArgsLeakKeyCount(dw)).toBe(0);

    for (let i = 0; i < 60; i += 1) {
      const out = await dw.eval(
        `
          (() => Number($args[0]?.n ?? -1))()
        `,
        { args: [{ n: i, token: `ev-${i}` }] },
      );
      expect(out).toBe(i);
    }

    for (let i = 0; i < 60; i += 1) {
      const ns = await dw.module.eval(
        `
          export const out = Number($args[0]?.n ?? -1);
        `,
        { args: [{ n: i, token: `mod-${i}` }] },
      );
      expect(ns.out).toBe(i);
    }

    expect(await evalArgsLeakKeyCount(dw)).toBe(0);
  });

  test(
    "repeated $args calls across eval/module/handle stay within bounded heap growth",
    async () => {
      const before = await usedHeap(dw);
      const handle = await dw.handle.eval(
        `
          (x) => ({
            sum: Number(x) + Number($args[0] ?? 0),
            marker: String($args[1]?.marker ?? "")
          })
        `,
      );

      try {
        for (let i = 0; i < 180; i += 1) {
          const payload = { marker: `m-${i}`, data: "x".repeat(2048) };

          const evalOut = await dw.eval(
            `
              (() => Number($args[0]) + Number($args[1]?.extra ?? 0))()
            `,
            { args: [i, { extra: 1, payload }] },
          );
          expect(evalOut).toBe(i + 1);

          const modOut = await dw.module.eval(
            `
              export const out = Number($args[0] ?? -1);
            `,
            { args: [i] },
          );
          expect(modOut.out).toBe(i);

          const handleOut = await handle.call([i, payload]);
          expect(handleOut).toMatchObject({ sum: i + i, marker: payload.marker });
        }
      } finally {
        await handle.dispose();
      }

      await sleep(50);

      const after = await usedHeap(dw);
      const growth = after - before;

      expect(await evalArgsLeakKeyCount(dw)).toBe(0);

      // Heuristic bound to catch unbounded growth regressions while tolerating
      // allocator and GC variance across environments.
      expect(growth).toBeLessThan(64 * 1024 * 1024);
    },
    45_000,
  );

  test(
    "handle.apply and construct churn remain within bounded heap growth",
    async () => {
      const before = await usedHeap(dw);
      const obj = await dw.handle.eval(`
        ({
          add(a, b) {
            return {
              sum: Number(a) + Number(b),
              fromDollar: Number($args[0] ?? 0) + Number($args[1] ?? 0),
            };
          }
        })
      `);
      const ctor = await dw.handle.eval(`
        (function Item(a, b) {
          this.sum = Number(a) + Number(b);
          this.fromDollar = Number($args[0] ?? 0) + Number($args[1] ?? 0);
          this.tag = String($args[2]?.tag ?? "");
        })
      `);

      try {
        for (let i = 0; i < 160; i += 1) {
          const a = i;
          const b = i + 1;
          const tag = { tag: `t-${i}` };

          const applied = await obj.apply([{ op: "call", path: "add", args: [a, b] }]);
          expect(applied).toEqual([{ sum: a + b, fromDollar: a + b }]);

          const built = await ctor.construct([a, b, tag]);
          expect(built).toMatchObject({ sum: a + b, fromDollar: a + b, tag: tag.tag });
        }
      } finally {
        await obj.dispose();
        await ctor.dispose();
      }

      await sleep(50);

      const after = await usedHeap(dw);
      const growth = after - before;
      expect(growth).toBeLessThan(64 * 1024 * 1024);
    },
    45_000,
  );

  test(
    "module register/import/clear churn does not show unbounded growth",
    async () => {
      const before = await usedHeap(dw);

      for (let i = 0; i < 140; i += 1) {
        const name = `named:leak-${i}`;
        const payload = "x".repeat(2048);
        await dw.module.register(
          name,
          `
            export const out = ${i};
            export const payload = ${JSON.stringify(payload)};
          `,
        );
        const mod = await dw.module.import<{ out: number }>(name);
        expect(mod.out).toBe(i);
        await expect(dw.module.clear(name)).resolves.toBe(true);
      }

      await sleep(50);

      const after = await usedHeap(dw);
      const growth = after - before;
      expect(growth).toBeLessThan(96 * 1024 * 1024);
    },
    45_000,
  );

  test(
    "forced restart cycles with eval/module/handle activity remain bounded",
    async () => {
      const before = await usedHeap(dw);

      for (let i = 0; i < 18; i += 1) {
        await dw.eval(
          `
            globalThis.__restart_bag = Array.from({ length: 2000 }, (_x, k) => String(k) + "-" + String($args[0]));
            __restart_bag.length;
          `,
          { args: [i] },
        );

        const ns = await dw.module.eval(
          `
            export const out = Number($args[0] ?? -1);
          `,
          { args: [i] },
        );
        expect(ns.out).toBe(i);

        const h = await dw.handle.eval(`(x) => Number(x) + Number($args[0] ?? 0)`);
        try {
          await expect(h.call([i])).resolves.toBe(i + i);
        } finally {
          await h.dispose();
        }

        await dw.restart({ force: true });
      }

      await sleep(100);

      const after = await usedHeap(dw);
      const growth = after - before;
      expect(await evalArgsLeakKeyCount(dw)).toBe(0);
      expect(growth).toBeLessThan(128 * 1024 * 1024);
    },
    70_000,
  );
});
