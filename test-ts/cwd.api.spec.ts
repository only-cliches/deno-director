import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createTestWorker } from "./helpers.worker-harness";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

describe("deno_worker: cwd api", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkTempDir("denojs-worker-cwd-a-");
    dirB = await mkTempDir("denojs-worker-cwd-b-");
    await writeFile(path.join(dirA, "a.js"), `export const v = "from-a";\n`);
    await writeFile(path.join(dirB, "b.js"), `export const v = "from-b";\n`);
  });

  afterEach(async () => {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  });

  test("cwd.get returns runtime cwd", async () => {
    const dw = createTestWorker({ cwd: dirA, imports: true });
    try {
      const got = await dw.cwd.get();
      expect(path.resolve(got)).toBe(path.resolve(dirA));
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("omitted cwd uses internal sandbox path (not host process cwd)", async () => {
    const dw = createTestWorker({ imports: true });
    try {
      const got = await dw.cwd.get();
      expect(path.resolve(got)).not.toBe(path.resolve(process.cwd()));
      expect(got).toContain(`${path.sep}deno-director${path.sep}sandbox`);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("cwd.set updates cwd and restarts runtime for new module base", async () => {
    const dw = createTestWorker({ cwd: dirA, imports: true });
    try {
      await expect(
        dw.module.eval(`
          import { v } from "./a.js";
          export const out = v;
        `)
      ).resolves.toMatchObject({ out: "from-a" });

      const next = await dw.cwd.set(dirB);
      expect(path.resolve(next)).toBe(path.resolve(dirB));

      await expect(
        dw.module.eval(`
          import { v } from "./b.js";
          export const out = v;
        `)
      ).resolves.toMatchObject({ out: "from-b" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("cwd.set on closed worker updates config for next restart", async () => {
    const dw = createTestWorker({ cwd: dirA, imports: true });
    await dw.close();
    const next = await dw.cwd.set(dirB);
    expect(path.resolve(next)).toBe(path.resolve(dirB));
    await dw.restart();
    try {
      await expect(
        dw.module.eval(`
          import { v } from "./b.js";
          export const out = v;
        `)
      ).resolves.toMatchObject({ out: "from-b" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("explicit cwd must exist", async () => {
    const missing = path.join(os.tmpdir(), `denojs-worker-cwd-missing-${Date.now()}`);
    expect(() => createTestWorker({ cwd: missing, imports: true })).toThrow(/configured cwd does not exist/i);
  });
});
