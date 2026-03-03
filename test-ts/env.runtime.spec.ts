import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  test("env file paths are constrained to worker cwd sandbox", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-env-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-env-outside-"));
    try {
      await fs.writeFile(path.join(root, ".env"), "INSIDE_OK=1\n", "utf8");
      await fs.writeFile(path.join(outside, "outside.env"), "OUTSIDE_BAD=1\n", "utf8");

      const ok = createTestWorker({
        cwd: root,
        envFile: ".env",
        permissions: { env: true },
      });
      workers.push(ok);
      await expect(ok.eval(`Deno.env.get("INSIDE_OK")`)).resolves.toBe("1");

      expect(() =>
        createTestWorker({
          cwd: root,
          envFile: path.join(outside, "outside.env"),
          permissions: { env: true },
        }),
      ).toThrow(/cwd sandbox|within worker cwd/i);

      expect(() =>
        createTestWorker({
          cwd: root,
          env: path.join(outside, "outside.env"),
          permissions: { env: true },
        }),
      ).toThrow(/cwd sandbox|within worker cwd/i);

      expect(() =>
        createTestWorker({
          cwd: root,
          envFile: `file://${path.join(outside, "outside.env")}`,
          permissions: { env: true },
        }),
      ).toThrow(/cwd sandbox|within worker cwd/i);

      const insideAbs = createTestWorker({
        cwd: root,
        envFile: path.join(root, ".env"),
        permissions: { env: true },
      });
      workers.push(insideAbs);
      await expect(insideAbs.eval(`Deno.env.get("INSIDE_OK")`)).resolves.toBe("1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
