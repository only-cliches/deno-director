import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Worker as NodeWorker } from "node:worker_threads";
import { DenoWorker } from "../../src/index";
import type { RenderResult, RenderTask, ScenarioDef } from "./types";
import {
    chunk,
    computeTask,
    decodeFrames,
    decodeResultBatch,
    denoBootstrapScript,
    encodeTaskBatch,
    groupTasksByWorker,
    mergeChecksums,
    packTask,
    UINT32,
} from "./workload";

const nodeWorkerScript = `
const { parentPort } = require("node:worker_threads");
const computeTask = ${computeTask.toString()};
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "render") return;
  try {
    const result = computeTask(msg.task);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, ok: false, error: error && error.message ? String(error.message) : String(error) });
  }
});
`;

function denoPostMessageScript(): string {
    return `
${denoBootstrapScript()}
on("message", (msg) => {
    if (!msg || msg.type !== "render") return;
    const result = globalThis.__computeTask(msg.task);
    hostPostMessage({ id: msg.id, result });
});
`;
}

function denoStreamPersistentScript(): string {
    return `
${denoBootstrapScript()}
const UINT32 = 4;
const TASK_WORDS = 7;
const RESULT_WORDS = 3;
function decodeTaskBatch(frame) {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let off = 0;
    const count = dv.getUint32(off, true); off += UINT32;
    const out = [];
    for (let i = 0; i < count; i += 1) {
        out.push({
            id: dv.getUint32(off, true),
            x0: dv.getUint32(off + UINT32, true),
            y0: dv.getUint32(off + UINT32 * 2, true),
            width: dv.getUint32(off + UINT32 * 3, true),
            height: dv.getUint32(off + UINT32 * 4, true),
            imageWidth: dv.getUint32(off + UINT32 * 5, true),
            imageHeight: dv.getUint32(off + UINT32 * 6, true),
        });
        off += TASK_WORDS * UINT32;
    }
    return out;
}
function encodeResultBatch(results) {
    const bodyBytes = (1 + results.length * RESULT_WORDS) * UINT32;
    const frameBytes = UINT32 + bodyBytes;
    const out = new Uint8Array(frameBytes);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let off = 0;
    dv.setUint32(off, bodyBytes, true); off += UINT32;
    dv.setUint32(off, results.length, true); off += UINT32;
    for (const r of results) {
        dv.setUint32(off, r.id >>> 0, true); off += UINT32;
        dv.setUint32(off, r.checksum >>> 0, true); off += UINT32;
        dv.setUint32(off, r.pixels >>> 0, true); off += UINT32;
    }
    return out;
}
async function* decodeFrames(chunks) {
    let buffer = new Uint8Array(0);
    for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
        const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
        merged.set(buffer, 0);
        merged.set(chunk, buffer.byteLength);
        buffer = merged;
        let offset = 0;
        while (buffer.byteLength - offset >= UINT32) {
            const bodyBytes = new DataView(buffer.buffer, buffer.byteOffset + offset, UINT32).getUint32(0, true);
            const full = UINT32 + bodyBytes;
            if (buffer.byteLength - offset < full) break;
            yield buffer.subarray(offset + UINT32, offset + full);
            offset += full;
        }
        buffer = offset === 0 ? buffer : buffer.subarray(offset);
    }
    if (buffer.byteLength !== 0) throw new Error("Dangling partial stream frame");
}
globalThis.__serveStreamRender = async (requestKey, responseKey) => {
    const inStream = await hostStreams.accept(requestKey);
    const outStream = hostStreams.create(responseKey);
    try {
        for await (const frame of decodeFrames(inStream)) {
            const tasks = decodeTaskBatch(frame);
            const results = tasks.map((t) => globalThis.__computeTask(t));
            await outStream.write(encodeResultBatch(results));
        }
    } finally {
        await outStream.close();
    }
};
globalThis.__streamRenderOnce = async (requestKey, responseKey) => {
    const inStream = await hostStreams.accept(requestKey);
    const outStream = hostStreams.create(responseKey);
    try {
        for await (const frame of decodeFrames(inStream)) {
            const tasks = decodeTaskBatch(frame);
            const results = tasks.map((t) => globalThis.__computeTask(t));
            await outStream.write(encodeResultBatch(results));
        }
    } finally {
        await outStream.close();
    }
};
`;
}

async function runNodeFn(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => ({ render: computeTask }));
    const out: RenderResult[] = [];
    for (let i = 0; i < tasks.length; i += 1) out.push(workers[i % workerCount].render(tasks[i]));
    return mergeChecksums(out);
}

async function runNodeAsyncFn(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => ({
        render: async (task: RenderTask) => computeTask(task),
    }));
    const promises = tasks.map((task, i) => workers[i % workerCount].render(task));
    return mergeChecksums(await Promise.all(promises));
}

async function runNodePostMessage(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new NodeWorker(nodeWorkerScript, { eval: true }));
    const pending = new Map<number, { resolve: (r: RenderResult) => void; reject: (e: unknown) => void }>();
    let nextId = 1;

    for (const w of workers) {
        w.on("message", (msg: any) => {
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            if (msg.ok) entry.resolve(msg.result as RenderResult);
            else entry.reject(new Error(msg.error || "Node worker error"));
        });
    }

    try {
        const promises = tasks.map((task, i) => {
            const w = workers[i % workerCount];
            const id = nextId++;
            return new Promise<RenderResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                w.postMessage({ type: "render", id, task });
            });
        });
        const out = await Promise.all(promises);
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.terminate()));
    }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", String(data.length));
    res.end(data);
}

async function runNodeHttp(tasks: RenderTask[], workerCount: number): Promise<number> {
    const servers = await Promise.all(
        Array.from({ length: workerCount }, async () => {
            const server = createServer(async (req, res) => {
                try {
                    if (req.method !== "POST" || req.url !== "/render") {
                        writeJson(res, 404, { error: "not found" });
                        return;
                    }
                    const body = await readBody(req);
                    const task = JSON.parse(body) as RenderTask;
                    writeJson(res, 200, computeTask(task));
                } catch (error) {
                    writeJson(res, 500, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Failed to bind HTTP server");
            return { server, port: address.port };
        }),
    );

    try {
        const promises = tasks.map(async (task, i) => {
            const port = servers[i % workerCount].port;
            const resp = await fetch(`http://127.0.0.1:${port}/render`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(task),
            });
            if (!resp.ok) throw new Error(`HTTP render failed (${resp.status})`);
            return (await resp.json()) as RenderResult;
        });

        return mergeChecksums(await Promise.all(promises));
    } finally {
        await Promise.all(
            servers.map(
                ({ server }) =>
                    new Promise<void>((resolve, reject) => {
                        server.close((err) => (err ? reject(err) : resolve()));
                    }),
            ),
        );
    }
}

async function runDenoPostMessage(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());
    const pending = new Map<number, { resolve: (r: RenderResult) => void; reject: (e: unknown) => void }>();
    let nextId = 1;

    try {
        await Promise.all(workers.map((w) => w.eval(denoPostMessageScript())));

        workers.forEach((w) => {
            w.on("message", (msg: any) => {
                if (!msg || typeof msg.id !== "number") return;
                const entry = pending.get(msg.id);
                if (!entry) return;
                pending.delete(msg.id);
                entry.resolve(msg.result as RenderResult);
            });
        });

        const promises = tasks.map((task, i) => {
            const w = workers[i % workerCount];
            const id = nextId++;
            return new Promise<RenderResult>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                w.postMessage({ type: "render", id, task });
                setTimeout(() => {
                    if (pending.delete(id)) reject(new Error(`Deno postMessage timeout for task ${task.id}`));
                }, 30_000).unref();
            });
        });

        return mergeChecksums(await Promise.all(promises));
    } finally {
        pending.clear();
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoEval(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());

    try {
        await Promise.all(workers.map((w) => w.eval(denoBootstrapScript())));

        const promises = tasks.map((task, i) =>
            workers[i % workerCount].eval("(task) => globalThis.__computeTask(task)", { args: [task] }) as Promise<RenderResult>,
        );
        return mergeChecksums(await Promise.all(promises));
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoEvalSync(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());

    try {
        await Promise.all(workers.map((w) => w.eval(denoBootstrapScript())));

        const out: RenderResult[] = [];
        for (let i = 0; i < tasks.length; i += 1) {
            const w = workers[i % workerCount];
            out.push(w.evalSync("(task) => globalThis.__computeTask(task)", { args: [tasks[i]] }) as RenderResult);
        }
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoHandle(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());

    try {
        await Promise.all(workers.map((w) => w.eval(denoBootstrapScript())));
        const handles = await Promise.all(workers.map((w) => w.handle.eval("(task) => globalThis.__computeTask(task)")));

        const promises = tasks.map((task, i) => handles[i % workerCount].call([task]) as Promise<RenderResult>);
        const out = await Promise.all(promises);

        await Promise.all(handles.map((h) => h.dispose()));
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoStreamPersistent(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());
    const responses = new Map<number, RenderResult>();
    const byWorker = groupTasksByWorker(tasks, workerCount);
    const active = byWorker
        .map((workerTasks, idx) => ({ workerTasks, idx }))
        .filter((x) => x.workerTasks.length > 0);

    try {
        await Promise.all(workers.map((w) => w.eval(denoStreamPersistentScript())));
        const requestWriters = active.map(({ idx }) =>
            workers[idx].stream.create(`rb:req:${idx}:${Date.now()}:${Math.random()}`),
        );
        const responseKeys = active.map(({ idx }) => `rb:res:${idx}:${Date.now()}:${Math.random()}`);
        const responseReaderPromises = active.map(({ idx }, i) => workers[idx].stream.accept(responseKeys[i]));
        const servePromises = active.map(({ idx }, i) =>
            workers[idx].eval("__serveStreamRender", { args: [requestWriters[i].getKey(), responseKeys[i]] }),
        );
        const readerPromises = responseReaderPromises.map(async (readerPromise) => {
            const reader = await readerPromise;
            for await (const frame of decodeFrames(reader)) {
                for (const r of decodeResultBatch(frame)) responses.set(r.id, r);
            }
        });

        await Promise.all(
            active.map(async ({ workerTasks }, i) => {
                const writer = requestWriters[i];
                const batches = chunk(workerTasks, 4);
                for (const b of batches) await writer.write(encodeTaskBatch(b));
                await writer.close();
            }),
        );
        await Promise.all(readerPromises);
        await Promise.all(servePromises);

        const out = tasks.map((t) => {
            const r = responses.get(t.id);
            if (!r) throw new Error(`Missing stream result for task ${t.id}`);
            return r;
        });
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoStreamPerRequest(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());
    const results = new Map<number, RenderResult>();
    let keyCounter = 0;
    const nextKey = (prefix: string) => `${prefix}:${Date.now()}:${Math.random()}:${keyCounter++}`;

    try {
        await Promise.all(workers.map((w) => w.eval(denoStreamPersistentScript())));
        const byWorker = groupTasksByWorker(tasks, workerCount);

        await Promise.all(
            byWorker.map(async (workerTasks, workerIdx) => {
                const w = workers[workerIdx];
                for (const task of workerTasks) {
                    const reqKey = nextKey(`rb:req:${workerIdx}`);
                    const resKey = nextKey(`rb:res:${workerIdx}`);
                    const writer = w.stream.create(reqKey);
                    const readerPromise = w.stream.accept(resKey);
                    const workerPromise = w.eval("__streamRenderOnce", { args: [reqKey, resKey] });

                    await writer.write(encodeTaskBatch([task]));
                    await writer.close();

                    const reader = await readerPromise;
                    const chunks: Uint8Array[] = [];
                    for await (const c of reader) chunks.push(c);
                    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
                    let off = 0;
                    for (const c of chunks) {
                        merged.set(c, off);
                        off += c.byteLength;
                    }

                    const bodyBytes = new DataView(merged.buffer, merged.byteOffset, UINT32).getUint32(0, true);
                    const frame = merged.subarray(UINT32, UINT32 + bodyBytes);
                    const decoded = decodeResultBatch(frame);
                    if (decoded.length !== 1) throw new Error("Expected one result for per-request stream");
                    results.set(decoded[0].id, decoded[0]);
                    await workerPromise;
                }
            }),
        );

        const out = tasks.map((t) => {
            const r = results.get(t.id);
            if (!r) throw new Error(`Missing stream per-request result for task ${t.id}`);
            return r;
        });
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoPostMessageBatched(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());
    const pending = new Map<number, { resolve: (r: RenderResult[]) => void; reject: (e: unknown) => void }>();
    let nextBatchId = 1;

    try {
        await Promise.all(
            workers.map((w) =>
                w.eval(`
${denoBootstrapScript()}
on("message", (msg) => {
    if (!msg || msg.type !== "render-batch" || !Array.isArray(msg.tasks)) return;
    const results = msg.tasks.map((t) => globalThis.__computeTask(t));
    hostPostMessage({ batchId: msg.batchId, results });
});
`),
            ),
        );

        workers.forEach((w) => {
            w.on("message", (msg: any) => {
                if (!msg || typeof msg.batchId !== "number") return;
                const entry = pending.get(msg.batchId);
                if (!entry) return;
                pending.delete(msg.batchId);
                entry.resolve(msg.results as RenderResult[]);
            });
        });

        const byWorker = groupTasksByWorker(tasks, workerCount);
        const batchSize = 4;
        const allPromises: Promise<RenderResult[]>[] = [];
        for (let i = 0; i < workerCount; i += 1) {
            const worker = workers[i];
            const batches = chunk(byWorker[i], batchSize);
            const messages = batches.map((batch) => ({ type: "render-batch", batchId: nextBatchId++, tasks: batch }));
            const promises = messages.map(
                (m) =>
                    new Promise<RenderResult[]>((resolve, reject) => {
                        pending.set(m.batchId, { resolve, reject });
                        setTimeout(() => {
                            if (pending.delete(m.batchId)) reject(new Error(`Deno batch timeout ${m.batchId}`));
                        }, 30_000).unref();
                    }),
            );
            if (messages.length > 0) worker.postMessages(messages);
            allPromises.push(...promises);
        }

        const flat = (await Promise.all(allPromises)).flat();
        if (flat.length !== tasks.length) throw new Error(`Missing batched postMessage results (${flat.length}/${tasks.length})`);

        const byId = new Map<number, RenderResult>();
        for (const r of flat) byId.set(r.id, r);
        const out = tasks.map((t) => {
            const r = byId.get(t.id);
            if (!r) throw new Error(`Missing batched postMessage result for task ${t.id}`);
            return r;
        });
        return mergeChecksums(out);
    } finally {
        pending.clear();
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoHandleApply(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());

    try {
        await Promise.all(workers.map((w) => w.eval(denoBootstrapScript())));
        const handles = await Promise.all(
            workers.map((w) => w.handle.eval("(task) => globalThis.__computeTask(task)")),
        );
        const byWorker = groupTasksByWorker(tasks, workerCount);
        const batchSize = 4;
        const byId = new Map<number, RenderResult>();

        await Promise.all(
            byWorker.map(async (workerTasks, idx) => {
                const h = handles[idx];
                const batches = chunk(workerTasks, batchSize);
                for (const b of batches) {
                    const ops = b.map((task) => ({ op: "call", args: [task] }));
                    const res = (await h.apply(ops as any)) as RenderResult[];
                    for (const r of res) byId.set(r.id, r);
                }
            }),
        );

        await Promise.all(handles.map((h) => h.dispose()));
        const out = tasks.map((t) => {
            const r = byId.get(t.id);
            if (!r) throw new Error(`Missing handle.apply result for task ${t.id}`);
            return r;
        });
        return mergeChecksums(out);
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

async function runDenoEvalBinary(tasks: RenderTask[], workerCount: number): Promise<number> {
    const workers = Array.from({ length: workerCount }, () => new DenoWorker());

    try {
        await Promise.all(
            workers.map((w) =>
                w.eval(`
${denoBootstrapScript()}
globalThis.__computeTaskPacked = (packed) => {
    const task = {
        id: packed[0] >>> 0,
        x0: packed[1] >>> 0,
        y0: packed[2] >>> 0,
        width: packed[3] >>> 0,
        height: packed[4] >>> 0,
        imageWidth: packed[5] >>> 0,
        imageHeight: packed[6] >>> 0,
    };
    return globalThis.__computeTask(task);
};
`),
            ),
        );

        const promises = tasks.map((task, i) =>
            workers[i % workerCount].eval("(packed) => globalThis.__computeTaskPacked(packed)", { args: [packTask(task)] }) as Promise<RenderResult>,
        );
        return mergeChecksums(await Promise.all(promises));
    } finally {
        await Promise.all(workers.map((w) => w.close({ force: true })));
    }
}

export const allScenarios: ScenarioDef[] = [
    {
        key: "node-fn",
        label: "Node | Fn Call | Node",
        main: "Node",
        ipc: "Fn Call",
        worker: "Node",
        run: runNodeFn,
    },
    {
        key: "node-async-fn",
        label: "Node | Async Fn Call | Node",
        main: "Node",
        ipc: "Async Fn Call",
        worker: "Node",
        run: runNodeAsyncFn,
    },
    {
        key: "node-postmessage",
        label: "Node | postMessage | Node Worker",
        main: "Node",
        ipc: "postMessage",
        worker: "Node Worker",
        run: runNodePostMessage,
    },
    {
        key: "node-http",
        label: "Node | HTTP | Node",
        main: "Node",
        ipc: "HTTP",
        worker: "Node",
        run: runNodeHttp,
    },
    {
        key: "deno-postmessage",
        label: "Node | postMessage | Deno",
        main: "Node",
        ipc: "postMessage",
        worker: "Deno",
        run: runDenoPostMessage,
    },
    {
        key: "deno-eval",
        label: "Node | worker.eval | Deno",
        main: "Node",
        ipc: "worker.eval",
        worker: "Deno",
        run: runDenoEval,
    },
    {
        key: "deno-evalsync",
        label: "Node | worker.evalSync | Deno",
        main: "Node",
        ipc: "worker.evalSync",
        worker: "Deno",
        run: runDenoEvalSync,
    },
    {
        key: "deno-handle",
        label: "Node | worker.handle | Deno",
        main: "Node",
        ipc: "worker.handle",
        worker: "Deno",
        run: runDenoHandle,
    },
    {
        key: "deno-postmessage-batched",
        label: "Node | postMessages(batch) | Deno",
        main: "Node",
        ipc: "postMessages(batch)",
        worker: "Deno",
        run: runDenoPostMessageBatched,
    },
    {
        key: "deno-handle-apply",
        label: "Node | worker.handle.apply | Deno",
        main: "Node",
        ipc: "worker.handle.apply",
        worker: "Deno",
        run: runDenoHandleApply,
    },
    {
        key: "deno-eval-binary",
        label: "Node | worker.eval(binary) | Deno",
        main: "Node",
        ipc: "worker.eval(binary)",
        worker: "Deno",
        run: runDenoEvalBinary,
    },
];
