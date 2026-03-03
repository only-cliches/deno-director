import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

function collectToText(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

describe("deno_worker: streams bridge", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  test("Node -> worker byte stream roundtrip", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__streamNodeToWorker = (async () => {
        const s = await hostStreams.accept("upload");
        const chunks = [];
        for await (const chunk of s) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        globalThis.__streamNodeToWorkerOut = new TextDecoder().decode(merged);
      })();
      0;
    `);

    const w = dw.stream.create("upload");
    expect(w.getKey()).toBe("upload");
    await w.write(new TextEncoder().encode("hello "));
    await w.write(new TextEncoder().encode("world"));
    await w.close();

    await expect(
      dw.eval("(__streamNodeToWorker.then(() => __streamNodeToWorkerOut))"),
    ).resolves.toBe("hello world");
  });

  test("worker -> Node byte stream roundtrip", async () => {
    dw = createTestWorker();

    const readerPromise = dw.stream.accept("download");
    await dw.eval(`
      (async () => {
        const s = hostStreams.create("download");
        await s.write(new TextEncoder().encode("foo"));
        await s.write(new TextEncoder().encode("bar"));
        await s.close();
      })()
    `);

    const reader = await readerPromise;
    const chunks: Uint8Array[] = [];
    for await (const chunk of reader) {
      chunks.push(chunk);
    }

    expect(collectToText(chunks)).toBe("foobar");
  });

  test("Node writer supports ready() and writeMany()", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__streamBatchNodeToWorker = (async () => {
        const s = await hostStreams.accept("upload-batch");
        const chunks = [];
        for await (const chunk of s) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        globalThis.__streamBatchNodeToWorkerOut = new TextDecoder().decode(merged);
      })();
      0;
    `);

    const w = dw.stream.create("upload-batch");
    await w.ready(1);
    const n = await w.writeMany([
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("batch "),
      new TextEncoder().encode("world"),
    ]);
    expect(n).toBe(3);
    await w.close();

    await expect(
      dw.eval("(__streamBatchNodeToWorker.then(() => __streamBatchNodeToWorkerOut))"),
    ).resolves.toBe("hello batch world");
  });

  test("worker writer supports ready() and writeMany()", async () => {
    dw = createTestWorker();

    const readerPromise = dw.stream.accept("download-batch");
    const n = await dw.eval(`
      (async () => {
        const s = hostStreams.create("download-batch");
        await s.ready(1);
        const n = await s.writeMany([
          new TextEncoder().encode("foo"),
          new TextEncoder().encode("-"),
          new TextEncoder().encode("bar"),
        ]);
        await s.close();
        return n;
      })()
    `);
    expect(Number(n)).toBe(3);

    const reader = await readerPromise;
    const chunks: Uint8Array[] = [];
    for await (const chunk of reader) chunks.push(chunk);
    expect(collectToText(chunks)).toBe("foo-bar");
  });

  test("worker stream error propagates to Node reader", async () => {
    dw = createTestWorker();

    const readerPromise = dw.stream.accept("err-stream");
    await dw.eval(`
      (async () => {
        const s = hostStreams.create("err-stream");
        await s.error("boom");
      })()
    `);

    const reader = await readerPromise;
    await expect(
      (async () => {
        for await (const _chunk of reader) {
          // no-op
        }
      })(),
    ).rejects.toThrow(/boom/i);
  });

  test("Node cancel propagates to worker reader", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__nodeCancelSeen = "";
      globalThis.__nodeCancelTask = (async () => {
        try {
          const s = await hostStreams.accept("cancel-me");
          for await (const _chunk of s) {
            // consume
          }
        } catch (e) {
          globalThis.__nodeCancelSeen = String(e && e.message ? e.message : e);
        }
      })();
      0;
    `);

    const w = dw.stream.create("cancel-me");
    await w.write(new TextEncoder().encode("a"));
    await w.cancel("stop-now");

    const out = await dw.eval("(__nodeCancelTask.then(() => __nodeCancelSeen))");
    expect(String(out)).toMatch(/stop-now|cancel/i);
  });

  test("rejects duplicate stream.create key while active", async () => {
    dw = createTestWorker();

    const stream = dw.stream.create("dup-open");
    expect(() => dw.stream.create("dup-open")).toThrow(/already in use/i);

    await stream.close();
  });

  test("rejects duplicate pending stream.accept key", async () => {
    dw = createTestWorker();

    const pending = dw.stream.accept("dup-accept");
    await expect(dw.stream.accept("dup-accept")).rejects.toThrow(/already pending/i);

    await dw.eval(`
      (async () => {
        const s = hostStreams.create("dup-accept");
        await s.close();
      })()
    `);
    await pending;
  });

  test("allows stream key reuse after both sides discard", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__reuseKeyTask = (async () => {
        const s = await hostStreams.accept("reuse-key");
        for await (const _chunk of s) {
          // drain
        }
      })();
      0;
    `);

    const first = dw.stream.create("reuse-key");
    await first.write(new TextEncoder().encode("first"));
    await first.close();
    await dw.eval("(__reuseKeyTask)");

    let secondOpened = false;
    for (let i = 0; i < 25; i += 1) {
      try {
        const second = dw.stream.create("reuse-key");
        await second.write(new TextEncoder().encode("second"));
        await second.close();
        secondOpened = true;
        break;
      } catch (e) {
        if (!String(e).match(/already in use/i)) throw e;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!secondOpened) {
      throw new Error("stream key was not released");
    }
  });

  test("Node -> worker stream survives frames arriving before worker accepts", async () => {
    dw = createTestWorker();

    const w = dw.stream.create("late-accept");
    await w.write(new TextEncoder().encode("hello "));
    await w.write(new TextEncoder().encode("world"));
    await w.close();

    const consumed = await Promise.race([
      dw.eval(`
        (async () => {
          // Ensure this starts after Node has already sent open/chunk/close.
          await new Promise((resolve) => setTimeout(resolve, 10));
          const s = await hostStreams.accept("late-accept");
          const chunks = [];
          for await (const chunk of s) chunks.push(chunk);
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          return new TextDecoder().decode(merged);
        })()
      `),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for late-accept stream consumption")), 1500),
      ),
    ]);

    expect(consumed).toBe("hello world");
  });

  test("stream.create without key generates a secure key", async () => {
    dw = createTestWorker();
    const writer = dw.stream.create();
    const key = writer.getKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    await writer.close();
  });
});
