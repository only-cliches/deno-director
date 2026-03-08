import { createTestWorker } from "./helpers.worker-harness";

describe("worker.env API", () => {
  jest.setTimeout(60_000);

  test("env.get/env.set work when env permission is enabled", async () => {
    const dw = createTestWorker({ permissions: { env: true } });
    try {
      await dw.env.set("DD_ENV_API_KEY", "v1");
      await expect(dw.env.get("DD_ENV_API_KEY")).resolves.toBe("v1");
      await expect(dw.eval(`Deno.env.get("DD_ENV_API_KEY")`)).resolves.toBe("v1");
    } finally {
      await dw.close();
    }
  });

  test("env:true enables worker.env bridge without explicit permissions.env", async () => {
    const dw = createTestWorker({ env: true });
    try {
      await dw.env.set("DD_ENV_API_TRUE", "yes");
      await expect(dw.env.get("DD_ENV_API_TRUE")).resolves.toBe("yes");
    } finally {
      await dw.close();
    }
  });

  test("env.set persists across restart by updating startup env map", async () => {
    const dw = createTestWorker({
      permissions: { env: true },
      env: { DD_ENV_API_PERSIST: "boot" },
    });
    try {
      await expect(dw.env.get("DD_ENV_API_PERSIST")).resolves.toBe("boot");
      await dw.env.set("DD_ENV_API_PERSIST", "updated");
      await expect(dw.env.get("DD_ENV_API_PERSIST")).resolves.toBe("updated");
      await dw.restart();
      await expect(dw.env.get("DD_ENV_API_PERSIST")).resolves.toBe("updated");
    } finally {
      await dw.close();
    }
  });

  test("env.set while closed updates next-start env", async () => {
    const dw = createTestWorker({ permissions: { env: true } });
    await dw.close();
    await dw.env.set("DD_ENV_API_CLOSED", "next");
    await dw.restart();
    try {
      await expect(dw.env.get("DD_ENV_API_CLOSED")).resolves.toBe("next");
    } finally {
      await dw.close();
    }
  });

  test("env API throws when permissions.env is false", async () => {
    const dw = createTestWorker({ permissions: { env: false } });
    try {
      await expect(dw.env.get("NOPE")).rejects.toThrow(/permissions\.env\s*===\s*false|permissions\.env is false/i);
      await expect(dw.env.set("NOPE", "x")).rejects.toThrow(/permissions\.env\s*===\s*false|permissions\.env is false/i);
    } finally {
      await dw.close();
    }
  });
});
