import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: runtime-local env namespace", () => {
  const key = `TEST_ENV_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let workers: DenoWorker[] = [];

  afterEach(async () => {
    for (const dw of workers) {
      if (!dw.isClosed()) await dw.close();
    }
    workers = [];
  });

  test("startup env is isolated per worker", async () => {
    const dw1 = createTestWorker({
      env: { [key]: "from-worker-1" },
      permissions: { env: true },
    });
    const dw2 = createTestWorker({
      permissions: { env: true },
    });
    workers.push(dw1, dw2);

    await expect(dw1.eval(`Deno.env.get("${key}")`)).resolves.toBe("from-worker-1");
    await expect(dw2.eval(`Deno.env.get("${key}")`)).resolves.toBeUndefined();
  });

  test("Deno.env.set/delete are isolated across running workers", async () => {
    const dw1 = createTestWorker({ permissions: { env: true } });
    const dw2 = createTestWorker({ permissions: { env: true } });
    workers.push(dw1, dw2);

    await dw1.eval(`Deno.env.set("${key}", "v1")`);

    await expect(dw1.eval(`Deno.env.get("${key}")`)).resolves.toBe("v1");
    await expect(dw2.eval(`Deno.env.get("${key}")`)).resolves.toBeUndefined();

    await dw2.eval(`Deno.env.set("${key}", "v2")`);

    await expect(dw1.eval(`Deno.env.get("${key}")`)).resolves.toBe("v1");
    await expect(dw2.eval(`Deno.env.get("${key}")`)).resolves.toBe("v2");

    await dw1.eval(`Deno.env.delete("${key}")`);
    await expect(dw1.eval(`Deno.env.get("${key}")`)).resolves.toBeUndefined();
    await expect(dw2.eval(`Deno.env.get("${key}")`)).resolves.toBe("v2");
  });

  test("toObject reflects only the current worker namespace", async () => {
    const dw1 = createTestWorker({ permissions: { env: true } });
    const dw2 = createTestWorker({ permissions: { env: true } });
    workers.push(dw1, dw2);

    await dw1.eval(`Deno.env.set("${key}", "local")`);

    await expect(dw1.eval(`Deno.env.toObject()["${key}"]`)).resolves.toBe("local");
    await expect(dw2.eval(`Deno.env.toObject()["${key}"]`)).resolves.toBeUndefined();
  });

  test("restart discards runtime-local env mutations and reapplies startup env", async () => {
    const dw = createTestWorker({
      permissions: { env: true },
      env: { [key]: "boot" },
    });
    workers.push(dw);

    await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBe("boot");
    await dw.eval(`Deno.env.set("${key}", "mutated")`);
    await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBe("mutated");

    await dw.restart();
    await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBe("boot");
  });
});
