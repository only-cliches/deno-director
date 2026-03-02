import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DenoWorker } from "../src/index";

function isBindPermissionError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  return err?.code === "EPERM" || /EPERM/i.test(msg);
}

async function startServer(routes: Record<string, string>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    const body = routes[url];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/typescript");
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server address unavailable");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function makeTempCacheDir(prefix = "deno-director-remote-cache-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("moduleLoader.denoRemote MVP", () => {
  test("remote http import is blocked when denoRemote is disabled", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const Application = class {}`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = new DenoWorker({ imports: true });
    try {
      const src = `
        import { Application } from "${srv.base}/oak/mod.ts";
        moduleReturn(typeof Application);
      `;
      await expect(dw.evalModule(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
    }
  });

  test("remote ts import works with denoRemote+transpileTs", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `
          export class Application {
            static kind: string = "oak";
          }
        `,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = new DenoWorker({
      imports: true,
      moduleLoader: { denoRemote: true, transpileTs: true, cacheDir },
      permissions: { import: true, net: true },
    } as any);

    try {
      const src = `
        import { Application } from "${srv.base}/oak/mod.ts";
        moduleReturn(Application.kind);
      `;
      await expect(dw.evalModule(src)).resolves.toBe("oak");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("denoRemote implicitly enables imports when imports is not set", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const ok: string = "yes";`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = new DenoWorker({
      moduleLoader: { denoRemote: true, transpileTs: true, cacheDir },
      permissions: { import: true, net: true },
    } as any);

    try {
      const src = `
        import { ok } from "${srv.base}/oak/mod.ts";
        moduleReturn(ok);
      `;
      await expect(dw.evalModule(src)).resolves.toBe("yes");
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("remote ts import is rejected when transpileTs is false", async () => {
    let srv: { base: string; close: () => Promise<void> } | undefined;
    const cacheDir = await makeTempCacheDir();
    try {
      srv = await startServer({
        "/oak/mod.ts": `export const v: number = 7;`,
      });
    } catch (e: any) {
      if (isBindPermissionError(e)) return;
      throw e;
    }

    const dw = new DenoWorker({
      imports: true,
      moduleLoader: { denoRemote: true, transpileTs: false, cacheDir },
      permissions: { import: true, net: true },
    } as any);

    try {
      const src = `
        import { v } from "${srv.base}/oak/mod.ts";
        moduleReturn(v);
      `;
      await expect(dw.evalModule(src)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
      await srv.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
