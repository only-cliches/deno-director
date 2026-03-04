import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Worker as NodeWorker } from "node:worker_threads";
import type { RenderResult, RenderTask, ScenarioDef } from "../types";
import { computeTask, mergeChecksums } from "../workload";

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

async function setupNodePostMessage(workerCount: number): Promise<any> {
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

    return { workers, pending, nextId: () => nextId++ };
}

async function runNodePostMessage(tasks: RenderTask[], workerCount: number, ctx: any): Promise<number> {
    const { workers, pending, nextId } = ctx;
    const promises = tasks.map((task, i) => {
        const w = workers[i % workerCount];
        const id = nextId();
        return new Promise<RenderResult>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            w.postMessage({ type: "render", id, task });
        });
    });
    const out = await Promise.all(promises);
    return mergeChecksums(out);
}

async function teardownNodePostMessage(ctx: any): Promise<void> {
    await Promise.all(ctx.workers.map((w: NodeWorker) => w.terminate()));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function writeJson(res: any, statusCode: number, value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", String(data.length));
    res.end(data);
}

async function setupNodeHttp(workerCount: number): Promise<any> {
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
    return { servers };
}

async function runNodeHttp(tasks: RenderTask[], workerCount: number, ctx: any): Promise<number> {
    const { servers } = ctx;
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
}

async function teardownNodeHttp(ctx: any): Promise<void> {
    await Promise.all(
        ctx.servers.map(
            ({ server }: any) =>
                new Promise<void>((resolve, reject) => {
                    server.close((err: any) => (err ? reject(err) : resolve()));
                }),
        ),
    );
}

export const nodeNodeScenarios: ScenarioDef[] = [
    {
        key: "node+node-fn",
        label: "Node | Fn Call | Node",
        main: "Node",
        ipc: "Fn Call",
        worker: "Node",
        run: runNodeFn,
    },
    {
        key: "node+node-async-fn",
        label: "Node | Async Fn Call | Node",
        main: "Node",
        ipc: "Async Fn Call",
        worker: "Node",
        run: runNodeAsyncFn,
    },
    {
        key: "node+node-postmessage",
        label: "Node | postMessage | Node",
        main: "Node",
        ipc: "postMessage",
        worker: "Node",
        setup: setupNodePostMessage,
        run: runNodePostMessage,
        teardown: teardownNodePostMessage,
    },
    {
        key: "node+node-http",
        label: "Node | HTTP | Node",
        main: "Node",
        ipc: "HTTP",
        worker: "Node",
        setup: setupNodeHttp,
        run: runNodeHttp,
        teardown: teardownNodeHttp,
    },
];
