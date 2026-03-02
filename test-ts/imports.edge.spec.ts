// test-ts/imports.edge.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { DenoWorker } from "../src/index";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

describe("DenoWorker imports callback edge cases", () => {
  test("callback returning undefined blocks", async () => {
    const dir = await mkTempDir("denojs-worker-imports-undef-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: () => undefined as any,
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 7;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback returning null blocks", async () => {
    const dir = await mkTempDir("denojs-worker-imports-null-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: () => null as any,
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 7;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback returning non-supported primitive blocks", async () => {
    const dir = await mkTempDir("denojs-worker-imports-prim-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: () => 123 as any,
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 7;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback Promise<boolean>: true allows disk resolution", async () => {
    const dir = await mkTempDir("denojs-worker-imports-allow-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: async () => true,
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 7;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 7 });
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback Promise<boolean>: false blocks", async () => {
    const dir = await mkTempDir("denojs-worker-imports-block-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: async () => false,
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 7;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback Promise<resolve>: can rewrite relative specifiers", async () => {
    const dir = await mkTempDir("denojs-worker-imports-rewrite-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: async (specifier: string) => {
        if (specifier === "./alias") return { resolve: "./a.js" };
        return true;
      },
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 123;\n");

      const code = `
        import a from "./alias";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 123 });
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("callback Promise<resolve>: empty resolve string blocks", async () => {
    const dir = await mkTempDir("denojs-worker-imports-rewrite-empty-");

    const dw = new DenoWorker({
      cwd: dir,
      imports: async () => ({ resolve: "   " }),
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 123;\n");

      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("imports callback remains active after restart without duplicate per-import invocation", async () => {
    const dir = await mkTempDir("denojs-worker-imports-restart-");
    let count = 0;

    const dw = new DenoWorker({
      cwd: dir,
      imports: async () => {
        count += 1;
        return true;
      },
    } as any);

    try {
      await writeFile(path.join(dir, "a.js"), "export default 9;\n");
      const code = `
        import a from "./a.js";
        export const out = a;
      `;

      await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 9 });
      const firstCount = count;
      expect(firstCount).toBeGreaterThan(0);

      await dw.restart();
      await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 9 });
      const secondDelta = count - firstCount;

      expect(secondDelta).toBe(firstCount);
    } finally {
      if (!dw.isClosed()) await dw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
