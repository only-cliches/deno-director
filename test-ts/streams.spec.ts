import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

const H2W = "::h2w";
const W2H = "::w2h";

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

async function readDuplexText(duplex: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of duplex) chunks.push(chunk);
  return collectToText(chunks);
}

describe("deno_worker: streams bridge", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  test("Node -> worker byte stream roundtrip via stream.connect", async () => {
    dw = createTestWorker();
    const key = "upload";

    await dw.eval(`
      globalThis.__streamNodeToWorker = (async () => {
        const s = await hostStreams.accept(${JSON.stringify(key + H2W)});
        const chunks = [];
        for await (const chunk of s) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        globalThis.__streamNodeToWorkerOut = new TextDecoder().decode(merged);
        const out = hostStreams.create(${JSON.stringify(key + W2H)});
        await out.write(new TextEncoder().encode("ok"));
        await out.close();
      })();
      0;
    `);

    const duplex = await dw.stream.connect(key);
    duplex.write(Buffer.from("hello "));
    duplex.end(Buffer.from("world"));
    await expect(readDuplexText(duplex)).resolves.toBe("ok");

    await expect(dw.eval("(__streamNodeToWorker.then(() => __streamNodeToWorkerOut))")).resolves.toBe("hello world");
  }, 30_000);

  test("worker -> Node byte stream roundtrip via stream.connect", async () => {
    dw = createTestWorker();
    const key = "download";

    const duplex = await dw.stream.connect(key);
    await dw.eval(`
      (async () => {
        const s = hostStreams.create(${JSON.stringify(key + W2H)});
        await s.write(new TextEncoder().encode("foo"));
        await s.write(new TextEncoder().encode("bar"));
        await s.close();
      })()
    `);

    await expect(readDuplexText(duplex)).resolves.toBe("foobar");
  });

  test("bidirectional duplex bridge with worker echo", async () => {
    dw = createTestWorker();
    const key = "duplex-echo";

    await dw.eval(`
      globalThis.__duplexEchoTask = (async () => {
        const incoming = await hostStreams.accept(${JSON.stringify(key + H2W)});
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        const text = new TextDecoder().decode(merged);
        const out = hostStreams.create(${JSON.stringify(key + W2H)});
        await out.write(new TextEncoder().encode(text.toUpperCase()));
        await out.close();
        return text;
      })();
      0;
    `);

    const duplex = await dw.stream.connect(key);
    duplex.write(Buffer.from("hello "));
    duplex.end(Buffer.from("duplex"));

    await expect(readDuplexText(duplex)).resolves.toBe("HELLO DUPLEX");
    await expect(dw.eval("__duplexEchoTask")).resolves.toBe("hello duplex");
  });

  test("worker error propagates to Node duplex reader", async () => {
    dw = createTestWorker();
    const key = "err-stream";

    const duplex = await dw.stream.connect(key);
    duplex.on("error", () => {
      // consumed by async iterator assertion below
    });
    await dw.eval(`
      (async () => {
        const s = hostStreams.create(${JSON.stringify(key + W2H)});
        await s.error("boom");
      })()
    `);

    await expect(
      (async () => {
        for await (const _chunk of duplex) {
          // no-op
        }
      })(),
    ).rejects.toThrow(/boom/i);
  });

  test("Node destroy propagates cancellation to worker reader", async () => {
    dw = createTestWorker();
    const key = "cancel-me";

    await dw.eval(`
      globalThis.__nodeCancelSeen = "";
      globalThis.__nodeCancelTask = (async () => {
        try {
          const s = await hostStreams.accept(${JSON.stringify(key + H2W)});
          for await (const _chunk of s) {
            // consume
          }
        } catch (e) {
          globalThis.__nodeCancelSeen = String(e && e.message ? e.message : e);
        }
      })();
      0;
    `);

    const duplex = await dw.stream.connect(key);
    duplex.write(Buffer.from("a"));
    duplex.destroy();

    const out = await dw.eval("(__nodeCancelTask.then(() => __nodeCancelSeen))");
    expect(String(out)).toMatch(/cancel|duplex destroyed/i);
  });

  test("rejects duplicate stream.connect key while active", async () => {
    dw = createTestWorker();

    const first = await dw.stream.connect("dup-open");
    await expect(dw.stream.connect("dup-open")).rejects.toThrow(/already in use|pending/i);
    first.destroy();
  });

});
