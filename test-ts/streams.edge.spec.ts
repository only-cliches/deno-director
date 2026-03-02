import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

describe("deno_worker: streams edge cases", () => {
  let dw: DenoWorker;
  jest.setTimeout(30_000);

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close({ force: true });
  });

  test("pending writer backpressure is rejected when worker force-closes", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeHoldStream = (async () => {
        await hostStreams.accept("edge-force-close");
        await new Promise(() => {});
      })();
      0;
    `);

    const writer = dw.stream.create("edge-force-close");
    const pending = writer.write(makeBytes(24 * 1024 * 1024));
    await sleep(40);
    await dw.close({ force: true });

    await expect(pending).rejects.toThrow(/force-closed|closed|released/i);
  });

  test("backpressure recovers while reader drains payload larger than stream window", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeDrainTask = (async () => {
        const s = await hostStreams.accept("edge-large-transfer");
        let total = 0;
        for await (const chunk of s) {
          total += chunk.byteLength;
          if ((total % (1024 * 1024)) === 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
        }
        globalThis.__edgeDrainTotal = total;
      })();
      0;
    `);

    const writer = dw.stream.create("edge-large-transfer");
    const chunk = makeBytes(512 * 1024);
    const chunkCount = 12; // 6 MiB total, exceeds default 4 MiB window
    const chunks = Array.from({ length: chunkCount }, () => chunk);

    await expect(writer.writeMany(chunks)).resolves.toBe(chunkCount);
    await writer.close();
    await dw.eval("(__edgeDrainTask)");
    await expect(dw.eval("__edgeDrainTotal")).resolves.toBe(chunk.byteLength * chunkCount);
  });

  test("writeMany handles empty input without side effects", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeEmptyTask = (async () => {
        const s = await hostStreams.accept("edge-empty-writeMany");
        let count = 0;
        for await (const _chunk of s) count++;
        globalThis.__edgeEmptyCount = count;
      })();
      0;
    `);

    const writer = dw.stream.create("edge-empty-writeMany");
    await expect(writer.writeMany([])).resolves.toBe(0);
    await writer.close();
    await dw.eval("(__edgeEmptyTask)");
    await expect(dw.eval("__edgeEmptyCount")).resolves.toBe(0);
  });

  test("pending ready() is rejected when writer is cancelled", async () => {
    dw = createTestWorker();

    await dw.eval(`
      globalThis.__edgeReadyCancelTask = (async () => {
        const s = await hostStreams.accept("edge-ready-cancel");
        await new Promise(() => {});
      })();
      0;
    `);

    const writer = dw.stream.create("edge-ready-cancel");
    const pending = writer.ready(32 * 1024 * 1024);
    await sleep(25);
    await writer.cancel("cancel-for-edge-test");
    await expect(pending).rejects.toThrow(/cancel|released/i);
  });

  test("many concurrent worker->Node streams drain without starvation", async () => {
    dw = createTestWorker({ bridge: { channelSize: 4096 } });

    const streamCount = 6;
    const chunkSize = 16 * 1024;
    const batchSize = 8;
    const rounds = 6;
    const expectedPerStream = chunkSize * batchSize * rounds;
    const keys = Array.from({ length: streamCount }, (_, i) => `edge-concurrent-down-${i}`);

    const readerTasks = keys.map(async (key) => {
      const reader = await dw.stream.accept(key);
      let total = 0;
      for await (const chunk of reader) {
        total += chunk.byteLength;
      }
      return total;
    });

    await dw.eval(`
      globalThis.__edgeWriteMany = async (keys, chunkSize, batchSize, rounds) => {
        const payload = new Uint8Array(chunkSize >>> 0);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        await Promise.all(keys.map(async (key) => {
          const s = hostStreams.create(key);
          await s.ready(1);
          for (let r = 0; r < rounds; r++) {
            const chunks = new Array(batchSize).fill(payload);
            await s.writeMany(chunks);
          }
          await s.close();
        }));
        return "ok";
      };
      0;
    `);

    await expect(
      dw.eval("(__edgeWriteMany)", { args: [keys, chunkSize, batchSize, rounds] }),
    ).resolves.toBe("ok");

    const totals = await Promise.all(readerTasks);
    expect(totals).toHaveLength(streamCount);
    for (const total of totals) expect(total).toBe(expectedPerStream);
  });
});
