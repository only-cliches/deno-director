import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: nodeJs.runtime env parity", () => {
  const key = `TEST_ENV_NODE_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let workers: DenoWorker[] = [];

  afterEach(async () => {
    for (const dw of workers) {
      if (!dw.isClosed()) await dw.close();
    }
    workers = [];
  });

  test("process.env and Deno.env share the same runtime-local namespace", async () => {
    const dw = createTestWorker({
      nodeJs: { runtime: true },
      permissions: { env: true },
    });
    workers.push(dw);

    await dw.eval(`Deno.env.set("${key}", "from-deno")`);
    await expect(dw.eval(`process.env["${key}"]`)).resolves.toBe("from-deno");

    await dw.eval(`process.env["${key}"] = "from-process"`);
    await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBe("from-process");

    await dw.eval(`delete process.env["${key}"]`);
    await expect(dw.eval(`Deno.env.get("${key}")`)).resolves.toBeUndefined();
  });

  test("process.env is isolated across workers", async () => {
    const dw1 = createTestWorker({ nodeJs: { runtime: true }, permissions: { env: true } });
    const dw2 = createTestWorker({ nodeJs: { runtime: true }, permissions: { env: true } });
    workers.push(dw1, dw2);

    await dw1.eval(`process.env["${key}"] = "worker-1"`);

    await expect(dw1.eval(`process.env["${key}"]`)).resolves.toBe("worker-1");
    await expect(dw2.eval(`process.env["${key}"]`)).resolves.toBeUndefined();
  });

  test("permissions env allow-list is enforced for process.env and Deno.env", async () => {
    const allowed = `${key}_ALLOWED`;
    const denied = `${key}_DENIED`;

    const dw = createTestWorker({
      nodeJs: { runtime: true },
      permissions: { env: [allowed] },
    });
    workers.push(dw);

    await expect(dw.eval(`Deno.env.set("${allowed}", "ok")`)).resolves.toBeUndefined();
    await expect(dw.eval(`process.env["${allowed}"]`)).resolves.toBe("ok");

    await expect(dw.eval(`Deno.env.get("${denied}")`)).rejects.toBeTruthy();
    await expect(dw.eval(`process.env["${denied}"]`)).rejects.toBeTruthy();
    await expect(dw.eval(`process.env["${denied}"] = "x"`)).rejects.toBeTruthy();
  });

  test("nodeJs:true shorthand enables runtime process.env parity", async () => {
    const dw = createTestWorker({
      nodeJs: true,
      permissions: { env: true },
    });
    workers.push(dw);

    await dw.eval(`Deno.env.set("${key}", "from-deno-shorthand")`);
    await expect(dw.eval(`process.env["${key}"]`)).resolves.toBe("from-deno-shorthand");
  });
});
