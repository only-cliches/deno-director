import { createTestWorker } from "./helpers.worker-harness";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-runtime-events-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}


describe("DenoWorker runtime events", () => {
  test("emits eval begin/end with args and no source text", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.eval(`(a, b) => a + b`, { args: [2, 3] })).resolves.toBe(5);

      const begin = events.find((e) => e.kind === "eval.begin");
      const end = events.find((e) => e.kind === "eval.end");
      expect(begin).toBeTruthy();
      expect(end).toBeTruthy();
      expect(begin.args).toEqual([2, 3]);
      expect(JSON.stringify(begin)).not.toContain("a + b");
    } finally {
      await dw.close();
    }
  });

  test("emits import requested/resolved for named registered modules", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await dw.module.register("named:math", "export const n = 9;");
      await expect(dw.module.import("named:math")).resolves.toMatchObject({ n: 9 });

      const requested = events.find((e) => e.kind === "import.requested");
      const resolved = events.find((e) => e.kind === "import.resolved");
      expect(requested).toBeTruthy();
      expect(resolved).toBeTruthy();
      expect(Boolean(resolved.cacheHit)).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("emits import.classified with parser-backed CJS decision", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "websocket-ts.js"),
        `export class WebsocketBuilder { static kind = "ok"; }\n`,
        "utf8",
      );

      const dw = createTestWorker({
        imports: true,
        cwd: dir,
        nodeJs: { modules: true, runtime: true, cjsInterop: true },
      });
      const events: any[] = [];
      dw.on("runtime", (e) => events.push(e));

      try {
        await expect(
          dw.module.eval(`
            import { WebsocketBuilder } from "./websocket-ts.js";
            export const out = typeof WebsocketBuilder;
          `),
        ).resolves.toMatchObject({ out: "function" });

        const classified = events.find(
          (e) =>
            e.kind === "import.classified" &&
            (
              /websocket-ts/.test(String(e.specifier ?? "")) ||
              /websocket-ts/.test(String(e.resolvedSpecifier ?? ""))
            ),
        );
        expect(classified).toBeTruthy();
        expect(typeof classified.cjs).toBe("boolean");
        expect(typeof classified.esm).toBe("boolean");
        expect(classified.parser).toBe("deno_ast");
        expect(typeof classified.cacheHit).toBe("boolean");
        expect(classified.wrappedAsCjs).toBe(false);
      } finally {
        await dw.close();
      }
    });
  });

  test("emits handle create/call/dispose runtime events", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      const h = await dw.handle.eval(`(x) => x + 1`);
      await expect(h.call([7])).resolves.toBe(8);
      await h.dispose();

      expect(events.some((e) => e.kind === "handle.create")).toBe(true);
      expect(events.some((e) => e.kind === "handle.call.begin")).toBe(true);
      expect(events.some((e) => e.kind === "handle.call.end")).toBe(true);
      expect(events.some((e) => e.kind === "handle.dispose")).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("emits stream.connect runtime event with negotiated mode metadata", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      const key = "runtime-event-stream-connect";
      const duplex = await dw.stream.connect(key, { unsafeSharedMemory: true });
      await dw.eval(`
        (async () => {
          const s = hostStreams.create(${JSON.stringify(`${key}::w2h`)});
          await s.write(new TextEncoder().encode("ok"));
          await s.close();
        })()
      `);
      const chunks: Uint8Array[] = [];
      for await (const chunk of duplex) chunks.push(chunk);
      const text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c))));
      expect(text).toBe("ok");

      const evt = events.find((e) => e.kind === "stream.connect" && e.key === key);
      expect(evt).toBeTruthy();
      expect(evt.requestedUnsafeSharedMemory).toBe(true);
      expect(evt.mode).toBe("copy");
      expect(evt.negotiatedUnsafeSharedMemory).toBe(false);
    } finally {
      await dw.close({ force: true });
    }
  });

  test("emits error.thrown for user-visible thrown eval errors", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.eval(`throw new Error(\"boom\")`)).rejects.toBeTruthy();
      const thrown = events.find((e) => e.kind === "error.thrown");
      expect(thrown).toBeTruthy();
      expect(thrown.surface).toBe("eval");
    } finally {
      await dw.close();
    }
  });

  test("emits module.eval begin/end and error.thrown for module eval errors", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.module.eval(`export const x = ;`)).rejects.toBeTruthy();
      const begin = events.find((e) => e.kind === "module.eval.begin");
      const end = events.find((e) => e.kind === "module.eval.end");
      const thrown = events.find((e) => e.kind === "error.thrown" && e.surface === "module.eval");
      expect(begin).toBeTruthy();
      expect(end).toBeTruthy();
      expect(end?.ok).toBe(false);
      expect(thrown).toBeTruthy();
      const msg = String(thrown?.error?.message ?? "");
      expect(/Code context \(|SyntaxError/i.test(msg)).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("module.import surfaces code context for registry module syntax errors", async () => {
    const dw = createTestWorker();

    try {
      await dw.module.register("named:broken", "export const bad = ;");
      await expect(dw.module.import("named:broken")).rejects.toThrow(/Code context \(/);
    } finally {
      await dw.close();
    }
  });

  test("module.import errors include code context for multiple stack frames", async () => {
    const dw = createTestWorker();

    try {
      expect.assertions(4);
      await dw.module.register(
        "named:stacked-error",
        `
          function a() { b(); }
          function b() { c(); }
          function c() { throw new Error("boom"); }
          a();
          export const ok = true;
        `,
      );
      try {
        await dw.module.import("named:stacked-error");
      } catch (e) {
        const err = e as {
          message?: unknown;
          codeContext?: { srcFileName?: unknown; srcDenoRef?: unknown };
        };
        const msg = String(err?.message ?? "");
        expect(msg).toMatch(/Code context \(/);
        const count = (msg.match(/Code context \(/g) || []).length;
        expect(count).toBeGreaterThanOrEqual(2);
        expect(String(err?.codeContext?.srcFileName ?? "")).toBe("stacked-error.js");
        expect(String(err?.codeContext?.srcDenoRef ?? "")).toContain("denojs-worker://virtual/__named_");
      }
    } finally {
      await dw.close();
    }
  });
});
