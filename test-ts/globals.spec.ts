// test-ts/globals.spec.ts
import { DenoWorker } from "../src/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("deno_worker: globals", () => {
  let dw: DenoWorker | undefined;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
    dw = undefined;
  });

  it("sets primitive globals", async () => {
    dw = new DenoWorker();
    await dw.setGlobal("myVar", 123);
    await expect(dw.eval("myVar")).resolves.toBe(123);
  });

  it("sets structured globals", async () => {
    dw = new DenoWorker();
    await dw.setGlobal("config", { limits: { max: 100 } });
    await expect(dw.eval("config.limits.max")).resolves.toBe(100);
  });

  it("setGlobal overwrites existing globals", async () => {
    dw = new DenoWorker();

    await dw.setGlobal("x", 1);
    await expect(dw.eval("x")).resolves.toBe(1);

    await dw.setGlobal("x", 2);
    await expect(dw.eval("x")).resolves.toBe(2);
  });

  it("setGlobal(undefined) becomes null inside the worker (wire format limitation)", async () => {
    dw = new DenoWorker();

    await dw.setGlobal("u", undefined);
    await expect(dw.eval("u === null")).resolves.toBe(true);
  });

  it("injects sync functions and can call them", async () => {
    dw = new DenoWorker();

    const double = jest.fn((x: number) => x * 2);
    await dw.setGlobal("double", double);

    await expect(dw.eval("double(5)")).resolves.toBe(10);
    expect(double).toHaveBeenCalledWith(5);
  });

  it("sync host functions that return Promises still work via async fallback", async () => {
    dw = new DenoWorker();

    const plusOneLater = jest.fn((x: number) => Promise.resolve(x + 1));
    await dw.setGlobal("plusOneLater", plusOneLater);

    await expect(dw.eval("plusOneLater(41)")).resolves.toBe(42);
    expect(plusOneLater).toHaveBeenCalledWith(41);
  });

  it("host function exceptions are propagated as rejections", async () => {
    dw = new DenoWorker();

    const boom = jest.fn(() => {
      throw new Error("boom");
    });

    await dw.setGlobal("boom", boom);

    await expect(dw.eval("boom()")).rejects.toThrow("boom");
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("injects async functions and can await them", async () => {
    dw = new DenoWorker();

    const addAsync = jest.fn(async (x: number) => {
      await sleep(25);
      return x + 1;
    });

    await dw.setGlobal("addAsync", addAsync);

    await expect(dw.eval("addAsync(10)")).resolves.toBe(11);
    expect(addAsync).toHaveBeenCalledWith(10);
  });
});