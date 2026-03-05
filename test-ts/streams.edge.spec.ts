import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

const H2W = "::h2w";
const W2H = "::w2h";

function makeBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

async function writeChunk(duplex: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    duplex.write(chunk, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function readDuplexBytes(duplex: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of duplex) total += chunk.byteLength;
  return total;
}

describe("deno_worker: streams edge cases", () => {
  let dw: DenoWorker;
  jest.setTimeout(30_000);

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  test("large transfer drains correctly over stream.connect", async () => {
    dw = createTestWorker();
    const key = "edge-large-transfer";

    await dw.eval(`
      globalThis.__edgeDrainTask = (async () => {
        const s = await hostStreams.accept(${JSON.stringify(key + H2W)});
        let total = 0;
        for await (const chunk of s) {
          total += chunk.byteLength;
        }
        globalThis.__edgeDrainTotal = total;
      })();
      0;
    `);

    const duplex = await dw.stream.connect(key);
    const chunk = makeBytes(256 * 1024);
    const chunkCount = 4;
    for (let i = 0; i < chunkCount; i += 1) await writeChunk(duplex, chunk);
    duplex.end();

    await dw.eval("(__edgeDrainTask)");
    await expect(dw.eval("__edgeDrainTotal")).resolves.toBe(chunk.byteLength * chunkCount);
  });

  test("many concurrent worker->Node streams drain without starvation", async () => {
    dw = createTestWorker({ bridge: { channelSize: 4096 } });

    const streamCount = 6;
    const chunkSize = 16 * 1024;
    const batchSize = 8;
    const rounds = 6;
    const expectedPerStream = chunkSize * batchSize * rounds;
    const keys = Array.from({ length: streamCount }, (_, i) => `edge-concurrent-down-${i}`);

    const readers = await Promise.all(keys.map((key) => dw.stream.connect(key)));
    const readerTasks = readers.map(async (duplex) => await readDuplexBytes(duplex));

    await dw.eval(`
      globalThis.__edgeWriteMany = async (keys, chunkSize, batchSize, rounds) => {
        const payload = new Uint8Array(chunkSize >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        await Promise.all(keys.map(async (key) => {
          const s = hostStreams.create(String(key) + ${JSON.stringify(W2H)});
          for (let r = 0; r < rounds; r++) {
            for (let b = 0; b < batchSize; b++) {
              await s.write(payload);
            }
          }
          await s.close();
        }));
        return "ok";
      };
      0;
    `);

    await expect(dw.eval("(__edgeWriteMany)", { args: [keys, chunkSize, batchSize, rounds] })).resolves.toBe("ok");

    const totals = await Promise.all(readerTasks);
    expect(totals).toHaveLength(streamCount);
    for (const total of totals) expect(total).toBe(expectedPerStream);
  });

  test("Node destroy propagates cancellation to worker readable", async () => {
    dw = createTestWorker();
    const key = "edge-cancel";

    await dw.eval(`
      globalThis.__edgeCancelSeen = "";
      globalThis.__edgeCancelTask = (async () => {
        try {
          const s = await hostStreams.accept(${JSON.stringify(key + H2W)});
          for await (const _chunk of s) {
            // consume
          }
        } catch (e) {
          globalThis.__edgeCancelSeen = String(e && e.message ? e.message : e);
        }
      })();
      0;
    `);

    const duplex = await dw.stream.connect(key);
    duplex.write(Buffer.from("x"));
    duplex.destroy();

    const out = await dw.eval("(__edgeCancelTask.then(() => __edgeCancelSeen))");
    expect(String(out)).toMatch(/cancel|duplex destroyed/i);
  });

  test("force restart allows fresh stream.connect with same key", async () => {
    dw = createTestWorker();
    const key = "edge-restart-ready";

    const first = await dw.stream.connect(key);
    first.end();
    await dw.restart({ force: true });

    await dw.eval(`
      globalThis.__edgeRestartTask = (async () => {
        const s = await hostStreams.accept(${JSON.stringify(key + H2W)});
        const chunks = [];
        for await (const c of s) chunks.push(c);
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        globalThis.__edgeRestartText = new TextDecoder().decode(out);
      })();
      0;
    `);

    const second = await dw.stream.connect(key);
    second.end(Buffer.from("fresh"));
    await dw.eval("(__edgeRestartTask)");
    await expect(dw.eval("__edgeRestartText")).resolves.toBe("fresh");
  });

  test("worker stream error propagates through Node duplex", async () => {
    dw = createTestWorker();
    const key = "edge-worker-error";

    const duplex = await dw.stream.connect(key);
    await dw.eval(`
      (async () => {
        const s = hostStreams.create(${JSON.stringify(key + W2H)});
        await s.error("edge-boom");
      })();
      0;
    `);

    await expect((async () => {
      for await (const _chunk of duplex) {
        // no-op
      }
    })()).rejects.toThrow(/edge-boom/i);
  });
});
