import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { Agent as HttpAgent, createServer, IncomingMessage, request as httpRequest } from "node:http";
import { Worker as NodeWorker } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { DenoWorker } from "../../src/index";
import { QuickJSWorker } from "quickjs-vm";

type ScenarioKey =
    | "node+node-postmessage"
    | "node+node-http"
    | "node+deno-postmessage"
    | "node+deno-eval"
    | "node+deno-handle"
    | "node+quickjs-eval"
    | "node+quickjs-handle"
    | "node+deno-stream"
    | "bun+bun-postmessage"
    | "bun+bun-http"
    | "deno+deno-postmessage"
    | "deno+deno-http";

type BenchConfig = {
    payloadBytesList: number[];
    messages: number;
    iterations: number;
    warmup: number;
    restarts: number;
    inflight: number;
    trimRatio: number;
    unsafeStreamMemory: boolean;
    scenarios: ScenarioKey[];
    transferModes: TransferMode[];
};

type Ack = { size: number; checksum: number };
type JsonPayload = { blob: string; salt: number };
type TransferPayload = Uint8Array | JsonPayload | string;
type TransferMode = "binary" | "json" | "string";

type ScenarioMeta = {
    key: ScenarioKey;
    label: string;
    main: "Node" | "Bun" | "Deno";
    ipc: string;
    worker: "Node" | "Deno" | "Bun" | "QuickJS";
};

type LocalScenarioDef = ScenarioMeta & {
    setup: (workerCount: number) => Promise<any>;
    run: (payload: TransferPayload, messages: number, workerCount: number, context: any) => Promise<number>;
    teardown: (context: any) => Promise<void>;
    reconnect?: (context: any) => Promise<void>;
};

const scenarioOrder: ScenarioKey[] = [
    "node+node-postmessage",
    "node+node-http",
    "node+deno-postmessage",
    "node+deno-eval",
    "node+deno-handle",
    "node+quickjs-eval",
    "node+quickjs-handle",
    "node+deno-stream",
    "bun+bun-postmessage",
    "bun+bun-http",
    "deno+deno-postmessage",
    "deno+deno-http",
];

const scenarioCatalog: ScenarioMeta[] = [
    { key: "node+node-postmessage", label: "Node | postMessage | Node", main: "Node", ipc: "postMessage", worker: "Node" },
    { key: "node+node-http", label: "Node | HTTP | Node", main: "Node", ipc: "HTTP", worker: "Node" },
    { key: "node+deno-postmessage", label: "Node | postMessage | Deno", main: "Node", ipc: "postMessage", worker: "Deno" },
    { key: "node+deno-eval", label: "Node | worker.eval | Deno", main: "Node", ipc: "worker.eval", worker: "Deno" },
    { key: "node+deno-handle", label: "Node | worker.handle | Deno", main: "Node", ipc: "worker.handle", worker: "Deno" },
    { key: "node+quickjs-eval", label: "Node | worker.eval | QuickJS", main: "Node", ipc: "worker.eval", worker: "QuickJS" },
    { key: "node+quickjs-handle", label: "Node | worker.handle | QuickJS", main: "Node", ipc: "worker.handle", worker: "QuickJS" },
    { key: "node+deno-stream", label: "Node | worker.stream.connect | Deno", main: "Node", ipc: "worker.stream.connect", worker: "Deno" },
    { key: "bun+bun-postmessage", label: "Bun | postMessage | Bun", main: "Bun", ipc: "postMessage", worker: "Bun" },
    { key: "bun+bun-http", label: "Bun | HTTP | Bun", main: "Bun", ipc: "HTTP", worker: "Bun" },
    { key: "deno+deno-postmessage", label: "Deno | postMessage | Deno", main: "Deno", ipc: "postMessage", worker: "Deno" },
    { key: "deno+deno-http", label: "Deno | HTTP | Deno", main: "Deno", ipc: "HTTP", worker: "Deno" },
];

let useUnsafeStreamMemory = false;
let runMaxInFlight = 64;
const ITERATION_SETTLE_MS = 25;

function createBenchDenoWorker(): DenoWorker {
    if (useUnsafeStreamMemory) {
        return new DenoWorker({ bridge: { enableUnsafeStreamMemory: true } });
    }
    return new DenoWorker();
}

function createBenchQuickJSWorker(): QuickJSWorker {
    return new QuickJSWorker();
}

function parseArgs(): BenchConfig {
    const args = process.argv.slice(2);
    const out: BenchConfig = {
        payloadBytesList: [1024 * 1024],
        messages: 128,
        iterations: 3,
        warmup: 1,
        restarts: 0,
        inflight: 8,
        trimRatio: 0.2,
        unsafeStreamMemory: false,
        scenarios: [...scenarioOrder],
        transferModes: ["binary", "json", "string"],
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--bytes") out.payloadBytesList = [Number(args[++i])];
        else if (arg === "--bytes-list") {
            out.payloadBytesList = args[++i]
                .split(",")
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v) && v > 0);
        } else if (arg === "--messages") out.messages = Number(args[++i]);
        else if (arg === "--iterations") out.iterations = Number(args[++i]);
        else if (arg === "--warmup") out.warmup = Number(args[++i]);
        else if (arg === "--restarts") out.restarts = Number(args[++i]);
        else if (arg === "--inflight") out.inflight = Number(args[++i]);
        else if (arg === "--trim-ratio") out.trimRatio = Number(args[++i]);
        else if (arg === "--unsafe-stream-memory") out.unsafeStreamMemory = true;
        else if (arg === "--transfer-mode") {
            const raw = String(args[++i] || "")
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean);
            const next: TransferMode[] = [];
            for (const mode of raw) {
                if (mode === "binary" || mode === "json" || mode === "string") next.push(mode);
                else if (mode === "all") next.push("binary", "json", "string");
            }
            out.transferModes = [...new Set(next)];
        }
        else if (arg === "--scenarios") {
            const wanted = new Set(args[++i].split(",").map((v) => v.trim()));
            out.scenarios = scenarioOrder.filter((k) => wanted.has(k));
        }
    }

    if (out.payloadBytesList.length === 0) throw new Error("No valid payload sizes");
    for (const bytes of out.payloadBytesList) {
        if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`Invalid payload size: ${bytes}`);
    }
    if (!Number.isFinite(out.messages) || out.messages <= 0) throw new Error("Invalid --messages");
    if (!Number.isFinite(out.iterations) || out.iterations <= 0) throw new Error("Invalid --iterations");
    if (!Number.isFinite(out.warmup) || out.warmup < 0) throw new Error("Invalid --warmup");
    if (!Number.isFinite(out.restarts) || out.restarts < 0) throw new Error("Invalid --restarts");
    if (!Number.isFinite(out.inflight) || out.inflight <= 0) throw new Error("Invalid --inflight");
    if (!Number.isFinite(out.trimRatio) || out.trimRatio < 0 || out.trimRatio >= 0.5) throw new Error("Invalid --trim-ratio");
    out.restarts = Math.trunc(out.restarts);
    out.inflight = Math.trunc(out.inflight);
    if (out.scenarios.length === 0) throw new Error("No scenarios selected");
    if (out.transferModes.length === 0) throw new Error("No transfer modes selected");
    return out;
}

function isRuntimeOnPath(runtimeBin: string): boolean {
    try {
        const result = spawnSync(runtimeBin, ["--version"], { stdio: "ignore" });
        return result.status === 0;
    } catch {
        return false;
    }
}

function makePayload(size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let i = 0; i < out.length; i += 1) out[i] = (i * 131 + 17) & 0xff;
    return out;
}

function makeJsonPayload(size: number): JsonPayload {
    return { blob: "x".repeat(size), salt: ((size * 17) ^ 0x9e3779b1) >>> 0 };
}

function makeStringPayload(size: number): string {
    return "x".repeat(size);
}

function ackChecksum(payload: Uint8Array): number {
    const first = payload.length > 0 ? payload[0] : 0;
    const last = payload.length > 0 ? payload[payload.length - 1] : 0;
    return ((payload.length >>> 0) ^ first ^ (last << 8)) >>> 0;
}

function ackChecksumJson(payload: JsonPayload): number {
    const size = Buffer.byteLength(payload.blob, "utf8");
    const first = payload.blob.length > 0 ? payload.blob.charCodeAt(0) & 0xff : 0;
    const last = payload.blob.length > 0 ? payload.blob.charCodeAt(payload.blob.length - 1) & 0xff : 0;
    return ((size >>> 0) ^ first ^ (last << 8) ^ (payload.salt >>> 0)) >>> 0;
}

function ackChecksumString(payload: string): number {
    const size = Buffer.byteLength(payload, "utf8");
    const first = payload.length > 0 ? payload.charCodeAt(0) & 0xff : 0;
    const last = payload.length > 0 ? payload.charCodeAt(payload.length - 1) & 0xff : 0;
    return ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
}

function transferModeOf(payload: TransferPayload): TransferMode {
    if (payload instanceof Uint8Array) return "binary";
    if (typeof payload === "string") return "string";
    return "json";
}

function payloadSizeBytes(payload: TransferPayload): number {
    if (payload instanceof Uint8Array) return payload.length;
    if (typeof payload === "string") return Buffer.byteLength(payload, "utf8");
    return Buffer.byteLength(payload.blob, "utf8");
}

function mergeChecksums(values: number[]): number {
    let acc = 0x811c9dc5;
    for (const v of values) {
        acc ^= v >>> 0;
        acc = Math.imul(acc, 16777619) >>> 0;
    }
    return acc >>> 0;
}

function expectedFoldForCount(expectedAck: number, payloadBytes: number, count: number): number {
    const v = ((expectedAck ^ payloadBytes) >>> 0);
    let acc = 0x811c9dc5;
    for (let i = 0; i < count; i += 1) {
        acc ^= v;
        acc = Math.imul(acc, 16777619) >>> 0;
    }
    return acc >>> 0;
}

function splitCounts(total: number, parts: number): number[] {
    const out: number[] = [];
    const p = Math.max(1, parts | 0);
    const base = Math.floor(total / p);
    let rem = total % p;
    for (let i = 0; i < p; i += 1) {
        const n = base + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
        if (n > 0) out.push(n);
    }
    return out;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
}

function trimmedMedian(values: number[], trimRatio: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * Math.max(0, Math.min(0.49, trimRatio)));
    const start = trimCount;
    const end = sorted.length - trimCount;
    const kept = end > start ? sorted.slice(start, end) : sorted;
    return median(kept);
}

async function mapWithConcurrency<T>(count: number, concurrency: number, task: (index: number) => Promise<T>): Promise<T[]> {
    if (count <= 0) return [];
    const out = new Array<T>(count);
    let cursor = 0;
    const workers = Math.max(1, Math.min(count, concurrency));
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (true) {
                const i = cursor;
                cursor += 1;
                if (i >= count) return;
                out[i] = await task(i);
            }
        }),
    );
    return out;
}

function mbps(totalBytes: number, ms: number): number {
    return totalBytes / (ms / 1000) / (1024 * 1024);
}

async function settleAfterIteration(): Promise<void> {
    try {
        const gc = (globalThis as any).gc;
        if (typeof gc === "function") gc();
    } catch {
        // ignore
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ITERATION_SETTLE_MS));
}

function fmtMbps(v: number): string {
    return `${v.toFixed(1)} MB/s`;
}

function parseBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function postHttpAck(port: number, contentType: string, body: string | Uint8Array, agent: HttpAgent): Promise<Ack> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                hostname: "127.0.0.1",
                port,
                path: "/echo",
                method: "POST",
                headers: {
                    "content-type": contentType,
                    "content-length": String(typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength),
                    connection: "keep-alive",
                },
                agent,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () => {
                    const status = res.statusCode || 0;
                    if (status < 200 || status >= 300) {
                        reject(new Error(`HTTP echo failed (${status})`));
                        return;
                    }
                    try {
                        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Ack;
                        resolve({ size: raw.size >>> 0, checksum: raw.checksum >>> 0 });
                    } catch (err) {
                        reject(err);
                    }
                });
            },
        );
        req.on("error", reject);
        req.end(body);
    });
}

const nodeWorkerScript = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "echo") return;
  const p = msg.payload;
  if (p instanceof Uint8Array) {
    const first = p.length > 0 ? p[0] : 0;
    const last = p.length > 0 ? p[p.length - 1] : 0;
    const checksum = ((p.length >>> 0) ^ first ^ (last << 8)) >>> 0;
    parentPort.postMessage({ id: msg.id, size: p.length >>> 0, checksum });
    return;
  }
  if (typeof p === "string") {
    const size = Buffer.byteLength(p, "utf8");
    const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
    const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
    parentPort.postMessage({ id: msg.id, size: size >>> 0, checksum });
    return;
  }
  if (p && typeof p === "object" && typeof p.blob === "string") {
    const blob = p.blob;
    const size = Buffer.byteLength(blob, "utf8");
    const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
    const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
    const salt = Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0;
    parentPort.postMessage({ id: msg.id, size: size >>> 0, checksum });
  }
});
`;

const denoPostMessageScript = `
on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "echo") return;
  const p = msg.payload;
  if (p instanceof Uint8Array) {
    const first = p.length > 0 ? p[0] : 0;
    const last = p.length > 0 ? p[p.length - 1] : 0;
    const checksum = ((p.length >>> 0) ^ first ^ (last << 8)) >>> 0;
    hostPostMessage({ id: msg.id, size: p.length >>> 0, checksum });
    return;
  }
  if (typeof p === "string") {
    const size = new TextEncoder().encode(p).length;
    const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
    const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
    hostPostMessage({ id: msg.id, size: size >>> 0, checksum });
    return;
  }
  if (p && typeof p === "object" && typeof p.blob === "string") {
    const blob = p.blob;
    const size = blob.length >>> 0;
    const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
    const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
    const salt = Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
    const checksum = ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0;
    hostPostMessage({ id: msg.id, size: size >>> 0, checksum });
  }
});
`;

async function setupNodePostMessage(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => new NodeWorker(nodeWorkerScript, { eval: true }));
    const pending = new Map<number, { resolve: (ack: Ack) => void; reject: (err: unknown) => void }>();
    let nextId = 1;
    for (const w of workers) {
        w.on("message", (msg: any) => {
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            entry.resolve({ size: msg.size >>> 0, checksum: msg.checksum >>> 0 });
        });
    }
    return { workers, pending, nextId: () => nextId++ };
}

async function runNodePostMessage(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { workers, pending, nextId } = ctx;
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        const w = workers[i % workerCount];
        const id = nextId();
        return await new Promise<Ack>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            w.postMessage({ type: "echo", id, payload });
        });
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function teardownNodePostMessage(ctx: any): Promise<void> {
    await Promise.all(ctx.workers.map((w: NodeWorker) => w.terminate()));
}

async function setupNodeHttp(workerCount: number): Promise<any> {
    const servers = await Promise.all(
        Array.from({ length: workerCount }, async () => {
            const server = createServer(async (req, res) => {
                if (req.method !== "POST" || req.url !== "/echo") {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                const body = await parseBody(req);
                let size = body.length >>> 0;
                let checksum = 0;
                const ct = String(req.headers["content-type"] || "");
                if (ct.includes("application/json")) {
                    const parsed = JSON.parse(body.toString("utf8")) as JsonPayload;
                    size = Buffer.byteLength(parsed.blob || "", "utf8") >>> 0;
                    const first = parsed.blob && parsed.blob.length > 0 ? parsed.blob.charCodeAt(0) & 0xff : 0;
                    const last = parsed.blob && parsed.blob.length > 0 ? parsed.blob.charCodeAt(parsed.blob.length - 1) & 0xff : 0;
                    checksum = ((size >>> 0) ^ first ^ (last << 8) ^ ((parsed.salt || 0) >>> 0)) >>> 0;
                } else if (ct.includes("text/plain")) {
                    const text = body.toString("utf8");
                    size = Buffer.byteLength(text, "utf8") >>> 0;
                    const first = text.length > 0 ? text.charCodeAt(0) & 0xff : 0;
                    const last = text.length > 0 ? text.charCodeAt(text.length - 1) & 0xff : 0;
                    checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
                } else {
                    const first = body.length > 0 ? body[0] : 0;
                    const last = body.length > 0 ? body[body.length - 1] : 0;
                    checksum = ((body.length >>> 0) ^ first ^ (last << 8)) >>> 0;
                }
                const reply = Buffer.from(JSON.stringify({ size: size >>> 0, checksum }));
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.setHeader("content-length", String(reply.length));
                res.end(reply);
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Failed to bind HTTP server");
            return { server, port: address.port };
        }),
    );
    const makeAgent = () => new HttpAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    const agents = Array.from({ length: workerCount }, () => makeAgent());
    return { servers, agents, makeAgent };
}

async function runNodeHttp(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { servers, agents } = ctx;
    const mode = transferModeOf(payload);
    const body = mode === "binary" ? payload : mode === "json" ? JSON.stringify(payload) : payload;
    const contentType = mode === "binary" ? "application/octet-stream" : mode === "json" ? "application/json" : "text/plain";
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        const idx = i % workerCount;
        const port = servers[idx].port;
        return await postHttpAck(port, contentType, body, agents[idx]);
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function reconnectNodeHttp(ctx: any): Promise<void> {
    const old = Array.isArray(ctx.agents) ? ctx.agents : [];
    for (const a of old) {
        try {
            a.destroy();
        } catch {
            // ignore
        }
    }
    const workerCount = ctx.servers.length | 0;
    ctx.agents = Array.from({ length: workerCount }, () => ctx.makeAgent());
}

async function teardownNodeHttp(ctx: any): Promise<void> {
    if (Array.isArray(ctx.agents)) {
        for (const a of ctx.agents) {
            try {
                a.destroy();
            } catch {
                // ignore
            }
        }
    }
    await Promise.all(
        ctx.servers.map(
            ({ server }: any) =>
                new Promise<void>((resolve, reject) => {
                    server.close((err: any) => (err ? reject(err) : resolve()));
                }),
        ),
    );
}

async function setupDenoPostMessage(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchDenoWorker());
    const pending = new Map<number, { resolve: (ack: Ack) => void; reject: (err: unknown) => void }>();
    let nextId = 1;
    await Promise.all(workers.map((w) => w.eval(denoPostMessageScript)));
    workers.forEach((w) => {
        w.on("message", (msg: any) => {
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            entry.resolve({ size: (msg.size >>> 0) || 0, checksum: (msg.checksum >>> 0) || 0 });
        });
    });
    return { workers, pending, nextId: () => nextId++ };
}

async function runDenoPostMessage(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { workers, pending, nextId } = ctx;
    const messageIds = new Set<number>();
    let next = 0;
    let inFlight = 0;
    let done = 0;
    let acc = 0x811c9dc5 >>> 0;
    const op = new Promise<number>((resolve, reject) => {
        let failed = false;
        const fail = (error: unknown) => {
            if (failed) return;
            failed = true;
            reject(error);
        };
        const launch = (): void => {
            while (!failed && inFlight < runMaxInFlight && next < messages) {
                const idx = next++;
                const id = nextId();
                const w = workers[idx % workerCount];
                inFlight += 1;
                messageIds.add(id);
                pending.set(id, {
                    resolve: (ack: Ack) => {
                        if (failed) return;
                        messageIds.delete(id);
                        inFlight -= 1;
                        done += 1;
                        acc ^= (ack.checksum ^ ack.size) >>> 0;
                        acc = Math.imul(acc, 16777619) >>> 0;
                        if (done >= messages) {
                            resolve(acc >>> 0);
                            return;
                        }
                        launch();
                    },
                    reject: (err: unknown) => {
                        messageIds.delete(id);
                        inFlight = Math.max(0, inFlight - 1);
                        fail(err);
                    },
                });
                try {
                    w.postMessage({ type: "echo", id, payload });
                } catch (err) {
                    pending.delete(id);
                    messageIds.delete(id);
                    inFlight = Math.max(0, inFlight - 1);
                    fail(err);
                    return;
                }
            }
        };
        launch();
    });
    try {
        return await withTimeout(op, 30_000, `Deno postMessage batch (${messages} messages)`);
    } catch (error) {
        for (const id of messageIds) pending.delete(id);
        throw error;
    }
}

async function teardownDenoPostMessage(ctx: any): Promise<void> {
    ctx.pending.clear();
    await Promise.all(ctx.workers.map((w: DenoWorker) => w.close({ force: true })));
}

async function setupDenoEval(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchDenoWorker());
    const src = `
        globalThis.__benchEcho = (p) => {
            if (p instanceof Uint8Array) {
                const first = p.length > 0 ? p[0] : 0;
                const last = p.length > 0 ? p[p.length - 1] : 0;
                return { size: p.length >>> 0, checksum: ((p.length >>> 0) ^ first ^ (last << 8)) >>> 0 };
            }
            if (typeof p === "string") {
                const size = new TextEncoder().encode(p).length;
                const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
                const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
                return { size: size >>> 0, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
            }
            const blob = p && typeof p.blob === "string" ? p.blob : "";
            const size = blob.length >>> 0;
            const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
            const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
            const salt = p && Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
            return { size: size >>> 0, checksum: ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0 };
        };
        true;
    `;
    await Promise.all(workers.map((w) => w.eval(src)));
    return { workers };
}

async function runDenoEval(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { workers } = ctx;
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        return await (workers[i % workerCount].eval("(p) => globalThis.__benchEcho(p)", {
            args: [payload],
        }) as Promise<Ack>);
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function teardownDenoEval(ctx: any): Promise<void> {
    await Promise.all(ctx.workers.map((w: DenoWorker) => w.close({ force: true })));
}

async function setupQuickJSEval(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchQuickJSWorker());
    const src = `
        globalThis.__benchEcho = (p) => {
            if (p instanceof Uint8Array) {
                const first = p.length > 0 ? p[0] : 0;
                const last = p.length > 0 ? p[p.length - 1] : 0;
                return { size: p.length >>> 0, checksum: ((p.length >>> 0) ^ first ^ (last << 8)) >>> 0 };
            }
            if (typeof p === "string") {
                const size = p.length >>> 0;
                const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
                const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
                return { size, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
            }
            const blob = p && typeof p.blob === "string" ? p.blob : "";
            const size = blob.length >>> 0;
            const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
            const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
            const salt = p && Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
            return { size, checksum: ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0 };
        };
        true;
    `;
    await Promise.all(workers.map((w) => w.eval(src)));
    return { workers };
}

async function runQuickJSEval(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { workers } = ctx;
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        return await (workers[i % workerCount].eval("(p) => globalThis.__benchEcho(p)", {
            args: [payload],
        }) as Promise<Ack>);
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function teardownQuickJSEval(ctx: any): Promise<void> {
    await Promise.all(ctx.workers.map((w: QuickJSWorker) => w.close()));
}

async function setupDenoHandle(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchDenoWorker());
    const handles = await Promise.all(
        workers.map((w) =>
            w.handle.eval(`(p) => {
                if (p instanceof Uint8Array) {
                    const size = p.length >>> 0;
                    const first = p.length > 0 ? p[0] : 0;
                    const last = p.length > 0 ? p[p.length - 1] : 0;
                    return { size, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
                }
                if (typeof p === "string") {
                    const size = new TextEncoder().encode(p).length;
                    const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
                    const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
                    return { size, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
                }
                const blob = p && typeof p.blob === "string" ? p.blob : "";
                const size = blob.length >>> 0;
                const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
                const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
                const salt = p && Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
                return { size, checksum: ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0 };
            }`),
        ),
    );
    return { workers, handles };
}

async function runDenoHandle(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { handles } = ctx;
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        return await (handles[i % workerCount].call([payload]) as Promise<Ack>);
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

const denoStreamScript = `
(key, batchedAck = true) => {
  (async () => {
  const readU32 = (buf, off) =>
    ((buf[off] >>> 0) | ((buf[off + 1] << 8) >>> 0) | ((buf[off + 2] << 16) >>> 0) | ((buf[off + 3] << 24) >>> 0)) >>> 0;
  const reader = await hostStreams.accept(String(key) + "::h2w");
  let buf = new Uint8Array(0);
  for await (const chunk of reader) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
    const acks = [];
    while (buf.length >= 16) {
      const id = readU32(buf, 0);
      const count = readU32(buf, 4);
      const unitBytes = readU32(buf, 8);
      const mode = buf[12] >>> 0; // 0=binary, 1=json, 2=string
      const payloadBytes = Math.imul(count >>> 0, unitBytes >>> 0) >>> 0;
      const total = (16 + payloadBytes) >>> 0;
      if (total < 16 || buf.length < total) break;
      const payload = buf.subarray(16, total);

      let size = unitBytes >>> 0;
      let checksum = 0;
      if (unitBytes > 0) {
        if (mode === 1) {
          const text = new TextDecoder().decode(payload.subarray(0, unitBytes));
          const p = JSON.parse(text);
          const blob = p && typeof p.blob === "string" ? p.blob : "";
          size = blob.length >>> 0;
          const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
          const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
          const salt = p && Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
          checksum = ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0;
        } else if (mode === 2) {
          const text = new TextDecoder().decode(payload.subarray(0, unitBytes));
          size = new TextEncoder().encode(text).length;
          const first = text.length > 0 ? (text.charCodeAt(0) & 0xff) : 0;
          const last = text.length > 0 ? (text.charCodeAt(text.length - 1) & 0xff) : 0;
          checksum = ((size >>> 0) ^ first ^ (last << 8)) >>> 0;
        } else {
          const first = payload[0] ?? 0;
          const last = payload[unitBytes - 1] ?? 0;
          checksum = ((unitBytes >>> 0) ^ first ^ (last << 8)) >>> 0;
        }
      }

      if (batchedAck) {
        acks.push({ id: id >>> 0, size: size >>> 0, checksum: checksum >>> 0 });
      } else {
        hostPostMessage({ id: id >>> 0, size: size >>> 0, checksum: checksum >>> 0 });
      }

      buf = buf.subarray(total);
    }
    if (batchedAck && acks.length > 0) {
      hostPostMessage({ acks });
    }
  }
  })();
  return true;
}
`;

function writeDuplexChunk(duplex: any, chunk: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        duplex.write(chunk, (err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function endDuplex(duplex: any): Promise<void> {
    return new Promise((resolve, reject) => {
        duplex.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            },
        );
    });
}

async function setupDenoStream(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchDenoWorker());
    const pending = new Map<number, { resolve: (ack: Ack) => void; reject: (err: unknown) => void }>();
    const writers: any[] = [];
    const keys: string[] = [];
    let nextId = 1;
    for (let i = 0; i < workers.length; i += 1) {
        const key = `bench-stream-persistent-${i}-${Math.random().toString(36).slice(2)}`;
        keys.push(key);
        writers.push(await workers[i].stream.connect(key, useUnsafeStreamMemory ? { unsafeSharedMemory: true } : undefined));
    }
    await Promise.all(workers.map((w, i) => w.eval(denoStreamScript, { args: [keys[i], true] })));
    workers.forEach((w) => {
        w.on("message", (msg: any) => {
            if (Array.isArray(msg?.acks)) {
                for (const ack of msg.acks) {
                    const entry = pending.get(ack.id);
                    if (!entry) continue;
                    pending.delete(ack.id);
                    entry.resolve({ size: (ack.size >>> 0) || 0, checksum: (ack.checksum >>> 0) || 0 });
                }
                return;
            }
            const entry = pending.get(msg?.id);
            if (!entry) return;
            pending.delete(msg.id);
            entry.resolve({ size: (msg.size >>> 0) || 0, checksum: (msg.checksum >>> 0) || 0 });
        });
    });
    return { workers, writers, pending, nextId: () => nextId++ };
}

async function runDenoStream(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { writers, pending, nextId } = ctx;
    const mode = transferModeOf(payload);
    const bytes = mode === "binary" ? payload : Buffer.from(mode === "json" ? JSON.stringify(payload) : payload, "utf8");
    const messageIds: number[] = [];
    const allAcks: Ack[] = [];
    for (let base = 0; base < messages; base += runMaxInFlight) {
        const count = Math.min(runMaxInFlight, messages - base);
        const perWorkerFrames = Array.from({ length: workerCount }, () => [] as Uint8Array[]);
        const promises: Array<Promise<Ack>> = [];
        for (let j = 0; j < count; j += 1) {
            const i = base + j;
            const wi = i % workerCount;
            const id = nextId();
            messageIds.push(id);
            const ackPromise = new Promise<Ack>((resolve, reject) => {
                pending.set(id, { resolve, reject });
            });
            const frame = new Uint8Array(16 + bytes.length);
            frame[0] = id & 0xff;
            frame[1] = (id >>> 8) & 0xff;
            frame[2] = (id >>> 16) & 0xff;
            frame[3] = (id >>> 24) & 0xff;
            frame[4] = 1;
            frame[5] = 0;
            frame[6] = 0;
            frame[7] = 0;
            frame[8] = bytes.length & 0xff;
            frame[9] = (bytes.length >>> 8) & 0xff;
            frame[10] = (bytes.length >>> 16) & 0xff;
            frame[11] = (bytes.length >>> 24) & 0xff;
            frame[12] = mode === "binary" ? 0 : mode === "json" ? 1 : 2;
            frame[13] = 0;
            frame[14] = 0;
            frame[15] = 0;
            frame.set(bytes, 16);
            perWorkerFrames[wi].push(frame);
            promises.push(ackPromise);
        }
        await Promise.all(
            perWorkerFrames.map(async (frames, wi) => {
                if (frames.length === 0) return;
                const total = frames.reduce((n, f) => n + f.byteLength, 0);
                const merged = Buffer.allocUnsafe(total);
                let off = 0;
                for (const frame of frames) {
                    merged.set(frame, off);
                    off += frame.byteLength;
                }
                await writeDuplexChunk(writers[wi], merged);
            }),
        );
        try {
            const chunkAcks = await withTimeout(Promise.all(promises), 30_000, `Deno stream batch (${count} messages)`);
            allAcks.push(...chunkAcks);
        } catch (error) {
            for (const id of messageIds) pending.delete(id);
            throw error;
        }
    }
    return mergeChecksums(allAcks.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function teardownDenoStream(ctx: any): Promise<void> {
    for (const entry of ctx.pending.values()) {
        entry.reject(new Error("Bench teardown"));
    }
    ctx.pending.clear();
    await Promise.all(
        ctx.writers.map(async (w: any) => {
            try {
                await withTimeout(endDuplex(w), 5000, "stream duplex end");
            } catch {
                try {
                    if (w && !w.destroyed && typeof w.destroy === "function") {
                        w.destroy(new Error("stream teardown timeout"));
                    }
                } catch {
                    // ignore teardown fallback errors
                }
            }
        }),
    );
    await Promise.all(ctx.workers.map((w: DenoWorker) => w.close({ force: true })));
}

async function teardownDenoHandle(ctx: any): Promise<void> {
    await Promise.all(ctx.handles.map((h: any) => h.dispose()));
    await Promise.all(ctx.workers.map((w: DenoWorker) => w.close({ force: true })));
}

async function setupQuickJSHandle(workerCount: number): Promise<any> {
    const workers = Array.from({ length: workerCount }, () => createBenchQuickJSWorker());
    const handles = await Promise.all(
        workers.map((w) =>
            w.handle.eval(`(p) => {
                if (p instanceof Uint8Array || Array.isArray(p)) {
                    const size = p.length >>> 0;
                    const first = p.length > 0 ? p[0] : 0;
                    const last = p.length > 0 ? p[p.length - 1] : 0;
                    return { size, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
                }
                if (typeof p === "string") {
                    const size = p.length >>> 0;
                    const first = p.length > 0 ? (p.charCodeAt(0) & 0xff) : 0;
                    const last = p.length > 0 ? (p.charCodeAt(p.length - 1) & 0xff) : 0;
                    return { size, checksum: ((size >>> 0) ^ first ^ (last << 8)) >>> 0 };
                }
                const blob = p && typeof p.blob === "string" ? p.blob : "";
                const size = blob.length >>> 0;
                const first = blob.length > 0 ? (blob.charCodeAt(0) & 0xff) : 0;
                const last = blob.length > 0 ? (blob.charCodeAt(blob.length - 1) & 0xff) : 0;
                const salt = p && Number.isFinite(p.salt) ? (p.salt >>> 0) : 0;
                return { size, checksum: ((size >>> 0) ^ first ^ (last << 8) ^ salt) >>> 0 };
            }`),
        ),
    );
    return { workers, handles };
}

async function runQuickJSHandle(payload: TransferPayload, messages: number, workerCount: number, ctx: any): Promise<number> {
    const { handles } = ctx;
    const handlePayload = payload instanceof Uint8Array ? Array.from(payload) : payload;
    const out = await mapWithConcurrency(messages, runMaxInFlight, async (i) => {
        return await (handles[i % workerCount].call([handlePayload]) as Promise<Ack>);
    });
    return mergeChecksums(out.map((a) => ((a.checksum ^ a.size) >>> 0)));
}

async function teardownQuickJSHandle(ctx: any): Promise<void> {
    await Promise.all(ctx.handles.map((h: any) => h.dispose()));
    await Promise.all(ctx.workers.map((w: QuickJSWorker) => w.close()));
}

const localScenarios: LocalScenarioDef[] = [
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
        reconnect: reconnectNodeHttp,
    },
    {
        key: "node+deno-postmessage",
        label: "Node | postMessage | Deno",
        main: "Node",
        ipc: "postMessage",
        worker: "Deno",
        setup: setupDenoPostMessage,
        run: runDenoPostMessage,
        teardown: teardownDenoPostMessage,
    },
    {
        key: "node+deno-eval",
        label: "Node | worker.eval | Deno",
        main: "Node",
        ipc: "worker.eval",
        worker: "Deno",
        setup: setupDenoEval,
        run: runDenoEval,
        teardown: teardownDenoEval,
    },
    {
        key: "node+deno-handle",
        label: "Node | worker.handle | Deno",
        main: "Node",
        ipc: "worker.handle",
        worker: "Deno",
        setup: setupDenoHandle,
        run: runDenoHandle,
        teardown: teardownDenoHandle,
    },
    {
        key: "node+quickjs-eval",
        label: "Node | worker.eval | QuickJS",
        main: "Node",
        ipc: "worker.eval",
        worker: "QuickJS",
        setup: setupQuickJSEval,
        run: runQuickJSEval,
        teardown: teardownQuickJSEval,
    },
    {
        key: "node+quickjs-handle",
        label: "Node | worker.handle | QuickJS",
        main: "Node",
        ipc: "worker.handle",
        worker: "QuickJS",
        setup: setupQuickJSHandle,
        run: runQuickJSHandle,
        teardown: teardownQuickJSHandle,
    },
    {
        key: "node+deno-stream",
        label: "Node | worker.stream.connect | Deno",
        main: "Node",
        ipc: "worker.stream.connect",
        worker: "Deno",
        setup: setupDenoStream,
        run: runDenoStream,
        teardown: teardownDenoStream,
    },
];

function runJsonCommand(cmd: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => {
            stdout += String(d);
        });
        proc.stderr.on("data", (d) => {
            stderr += String(d);
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`${cmd} exited with ${code}: ${stderr || stdout}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                reject(new Error(`Failed to parse ${cmd} output as JSON: ${String(err)}\n${stdout}\n${stderr}`));
            }
        });
    });
}

async function runBunMain(
    payloadBytes: number,
    messages: number,
    warmup: number,
    iterations: number,
    transfer: TransferMode,
    restarts: number,
    unsafeStreamMemory: boolean,
): Promise<Record<string, number>> {
    const script = path.resolve(process.cwd(), "src/runtime-bench-bun.ts");
    const output = await runJsonCommand("bun", [
        script,
        "--bytes",
        String(payloadBytes),
        "--messages",
        String(messages),
        "--warmup",
        String(warmup),
        "--iterations",
        String(iterations),
        "--transfer",
        transfer,
        "--restarts",
        String(restarts),
        "--json",
        ...(unsafeStreamMemory ? ["--unsafe-stream-memory"] : []),
    ]);
    return (output && output.results) || {};
}

async function runDenoMain(
    payloadBytes: number,
    messages: number,
    warmup: number,
    iterations: number,
    transfer: TransferMode,
    restarts: number,
    unsafeStreamMemory: boolean,
): Promise<Record<string, number>> {
    const script = path.resolve(process.cwd(), "src/runtime-bench-deno.ts");
    const output = await runJsonCommand("deno", [
        "run",
        "-A",
        script,
        "--bytes",
        String(payloadBytes),
        "--messages",
        String(messages),
        "--warmup",
        String(warmup),
        "--iterations",
        String(iterations),
        "--transfer",
        transfer,
        "--restarts",
        String(restarts),
        "--json",
        ...(unsafeStreamMemory ? ["--unsafe-stream-memory"] : []),
    ]);
    return (output && output.results) || {};
}

function printTable(title: string, scenarios: ScenarioMeta[], results: Map<string, number>): void {
    let best = -Infinity;
    for (const scenario of scenarios) {
        const r = results.get(scenario.key);
        if (r != null && r > best) best = r;
    }

    const sortedScenarios = scenarios
        .map((scenario, idx) => ({ scenario, idx, bandwidth: results.get(scenario.key) }))
        .sort((a, b) => {
            const aHas = a.bandwidth != null;
            const bHas = b.bandwidth != null;
            if (aHas && bHas) return b.bandwidth! - a.bandwidth!;
            if (aHas) return -1;
            if (bHas) return 1;
            return a.idx - b.idx;
        })
        .map(({ scenario }) => scenario);

    const headers = ["Main", "IPC", "Worker", "Bandwidth"];
    const rows: string[][] = sortedScenarios.map((scenario) => {
        const row = [scenario.main, scenario.ipc, scenario.worker];
        const r = results.get(scenario.key);
        if (r == null) row.push("skip");
        else {
            const cell = fmtMbps(r);
            row.push(best > 0 && Math.abs(r - best) < 1e-9 ? `* ${cell}` : cell);
        }
        return row;
    });

    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] == null ? 0 : r[i].length))));
    const numericStart = 3;
    for (let i = numericStart; i < widths.length; i += 1) widths[i] = Math.max(widths[i], 22);
    const padCell = (text: string, idx: number) => (idx >= numericStart ? text.padStart(widths[idx]) : text.padEnd(widths[idx]));
    const joinRow = (cells: string[]) => `| ${cells.map((c, i) => padCell(c, i)).join(" | ")} |`;
    const sep = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;

    console.log(`\n${title}`);
    console.log(sep);
    console.log(joinRow(headers));
    console.log(sep);
    for (const row of rows) console.log(joinRow(row));
    console.log(sep);
    console.log("* marks highest MB/s");
}

async function main(): Promise<void> {
    const config = parseArgs();
    useUnsafeStreamMemory = config.unsafeStreamMemory;
    runMaxInFlight = config.inflight;
    const selectedScenarios = scenarioCatalog.filter((s) => config.scenarios.includes(s.key));
    const selectedNodeScenarios = localScenarios.filter((s) => config.scenarios.includes(s.key));
    const wantsBunMain = config.scenarios.some((k) => k.startsWith("bun+bun-"));
    const wantsDenoMain = config.scenarios.some((k) => k.startsWith("deno+deno-"));
    const hasBun = wantsBunMain && isRuntimeOnPath("bun");
    const hasDeno = wantsDenoMain && isRuntimeOnPath("deno");

    console.log("# IPC Bandwidth Bench");
    console.log(
        `config: payloadBytesList=${config.payloadBytesList.join(",")} messages=${config.messages} iterations=${config.iterations} warmup=${config.warmup} restarts=${config.restarts} inflight=${config.inflight} trimRatio=${config.trimRatio} transferModes=${config.transferModes.join(",")} unsafeStreamMemory=${config.unsafeStreamMemory}`,
    );
    if (wantsBunMain && !hasBun) console.log("runtime: bun not found in PATH (Bun main scenarios skipped)");
    if (wantsDenoMain && !hasDeno) console.log("runtime: deno not found in PATH (Deno main scenarios skipped)");

    for (const payloadBytes of config.payloadBytesList) {
        const payload = makePayload(payloadBytes);
        const jsonPayload = makeJsonPayload(payloadBytes);
        const stringPayload = makeStringPayload(payloadBytes);
        const expectedAck = ackChecksum(payload);
        const expectedAckJson = ackChecksumJson(jsonPayload);
        const expectedAckString = ackChecksumString(stringPayload);
        const totalBytes = payloadBytes * config.messages;
        const expectedFold = mergeChecksums(Array.from({ length: config.messages }, () => expectedAck ^ payloadBytes));
        const expectedFoldJson = mergeChecksums(Array.from({ length: config.messages }, () => expectedAckJson ^ payloadBytes));
        const expectedFoldString = mergeChecksums(Array.from({ length: config.messages }, () => expectedAckString ^ payloadBytes));
        const results = new Map<string, number>();
        const jsonResults = new Map<string, number>();
        const stringResults = new Map<string, number>();

        console.log(`\nPayload: ${payloadBytes} bytes (${(payloadBytes / 1024).toFixed(1)} KiB), bytesPerRun=${totalBytes}`);

        for (const scenario of selectedNodeScenarios) {
            const wc = 1;
            console.log(`running: ${scenario.label}`);
            const segmentCounts = splitCounts(config.messages, config.restarts + 1);
            const persistentCtx = await scenario.setup(wc);
            try {
                const runLocal = async (modePayload: TransferPayload, modeExpectedAck: number): Promise<number> => {
                    const modePayloadBytes = payloadSizeBytes(modePayload);
                    if (config.restarts <= 0) {
                        return await scenario.run(modePayload, config.messages, wc, persistentCtx);
                    }

                    for (let i = 0; i < segmentCounts.length; i += 1) {
                        if (i > 0 && scenario.reconnect) {
                            await scenario.reconnect(persistentCtx);
                        }
                        const count = segmentCounts[i];
                        const sum = await scenario.run(modePayload, count, wc, persistentCtx);
                        const expectedSegment = expectedFoldForCount(modeExpectedAck, modePayloadBytes, count);
                        if (sum !== expectedSegment) {
                            throw new Error(
                                `Checksum mismatch for ${scenario.key} segment(count=${count}): expected ${expectedSegment}, got ${sum}`,
                            );
                        }
                    }
                    return expectedFoldForCount(modeExpectedAck, modePayloadBytes, config.messages);
                };

                if (config.transferModes.includes("binary")) {
                    for (let i = 0; i < config.warmup; i += 1) {
                        await runLocal(payload, expectedAck);
                        await settleAfterIteration();
                    }

                    const dts: number[] = [];
                    let checksum: number | undefined;
                    for (let i = 0; i < config.iterations; i += 1) {
                        const t0 = performance.now();
                        const sum = await runLocal(payload, expectedAck);
                        const dt = performance.now() - t0;
                        dts.push(dt);
                        if (checksum == null) checksum = sum;
                        else if (checksum !== sum) throw new Error(`Inconsistent checksum in ${scenario.key}`);
                        await settleAfterIteration();
                    }

                    if (checksum == null) throw new Error("Missing checksum");
                    if (checksum !== expectedFold) {
                        throw new Error(`Checksum mismatch for ${scenario.key}: expected ${expectedFold}, got ${checksum}`);
                    }

                    const speed = mbps(totalBytes, trimmedMedian(dts, config.trimRatio));
                    results.set(scenario.key, speed);
                    console.log(`done: ${scenario.label} -> ${fmtMbps(speed)}`);
                }

                if (config.transferModes.includes("json")) {
                    for (let i = 0; i < config.warmup; i += 1) {
                        await runLocal(jsonPayload, expectedAckJson);
                        await settleAfterIteration();
                    }

                    const jsonDts: number[] = [];
                    let jsonChecksum: number | undefined;
                    for (let i = 0; i < config.iterations; i += 1) {
                        const t0 = performance.now();
                        const sum = await runLocal(jsonPayload, expectedAckJson);
                        const dt = performance.now() - t0;
                        jsonDts.push(dt);
                        if (jsonChecksum == null) jsonChecksum = sum;
                        else if (jsonChecksum !== sum) throw new Error(`Inconsistent JSON checksum in ${scenario.key}`);
                        await settleAfterIteration();
                    }

                    if (jsonChecksum == null) throw new Error("Missing JSON checksum");
                    if (jsonChecksum !== expectedFoldJson) {
                        throw new Error(`JSON checksum mismatch for ${scenario.key}: expected ${expectedFoldJson}, got ${jsonChecksum}`);
                    }
                    const jsonSpeed = mbps(totalBytes, trimmedMedian(jsonDts, config.trimRatio));
                    jsonResults.set(scenario.key, jsonSpeed);
                    console.log(`done: ${scenario.label} (json) -> ${fmtMbps(jsonSpeed)}`);
                }

                if (config.transferModes.includes("string")) {
                    for (let i = 0; i < config.warmup; i += 1) {
                        await runLocal(stringPayload, expectedAckString);
                        await settleAfterIteration();
                    }

                    const stringDts: number[] = [];
                    let stringChecksum: number | undefined;
                    for (let i = 0; i < config.iterations; i += 1) {
                        const t0 = performance.now();
                        const sum = await runLocal(stringPayload, expectedAckString);
                        const dt = performance.now() - t0;
                        stringDts.push(dt);
                        if (stringChecksum == null) stringChecksum = sum;
                        else if (stringChecksum !== sum) throw new Error(`Inconsistent string checksum in ${scenario.key}`);
                        await settleAfterIteration();
                    }

                    if (stringChecksum == null) throw new Error("Missing string checksum");
                    if (stringChecksum !== expectedFoldString) {
                        throw new Error(`String checksum mismatch for ${scenario.key}: expected ${expectedFoldString}, got ${stringChecksum}`);
                    }
                    const stringSpeed = mbps(totalBytes, trimmedMedian(stringDts, config.trimRatio));
                    stringResults.set(scenario.key, stringSpeed);
                    console.log(`done: ${scenario.label} (string) -> ${fmtMbps(stringSpeed)}`);
                }
            } finally {
                await scenario.teardown(persistentCtx);
            }
        }

        if (wantsBunMain) {
            if (!hasBun) {
                for (const s of selectedScenarios.filter((x) => x.main === "Bun")) {
                    console.log(`skip: ${s.label} (bun not found in PATH)`);
                }
            } else {
                const bunOut = config.transferModes.includes("binary")
                    ? await runBunMain(payloadBytes, config.messages, config.warmup, config.iterations, "binary", config.restarts, config.unsafeStreamMemory)
                    : {};
                const bunOutJson = config.transferModes.includes("json")
                    ? await runBunMain(payloadBytes, config.messages, config.warmup, config.iterations, "json", config.restarts, config.unsafeStreamMemory)
                    : {};
                const bunOutString = config.transferModes.includes("string")
                    ? await runBunMain(payloadBytes, config.messages, config.warmup, config.iterations, "string", config.restarts, config.unsafeStreamMemory)
                    : {};
                for (const s of selectedScenarios.filter((x) => x.main === "Bun")) {
                    if (config.transferModes.includes("binary")) {
                        const speed = (bunOut as Record<string, number>)[s.key];
                        if (speed == null) console.log(`skip: ${s.label} (missing result from bun runtime)`);
                        else {
                            results.set(s.key, speed);
                            console.log(`done: ${s.label} -> ${fmtMbps(speed)}`);
                        }
                    }
                    if (config.transferModes.includes("json")) {
                        const jsonSpeed = (bunOutJson as Record<string, number>)[s.key];
                        if (jsonSpeed == null) console.log(`skip: ${s.label} (json result missing from bun runtime)`);
                        else {
                            jsonResults.set(s.key, jsonSpeed);
                            console.log(`done: ${s.label} (json) -> ${fmtMbps(jsonSpeed)}`);
                        }
                    }
                    if (config.transferModes.includes("string")) {
                        const stringSpeed = (bunOutString as Record<string, number>)[s.key];
                        if (stringSpeed == null) console.log(`skip: ${s.label} (string result missing from bun runtime)`);
                        else {
                            stringResults.set(s.key, stringSpeed);
                            console.log(`done: ${s.label} (string) -> ${fmtMbps(stringSpeed)}`);
                        }
                    }
                }
            }
        }

        if (wantsDenoMain) {
            if (!hasDeno) {
                for (const s of selectedScenarios.filter((x) => x.main === "Deno")) {
                    console.log(`skip: ${s.label} (deno not found in PATH)`);
                }
            } else {
                const denoOut = config.transferModes.includes("binary")
                    ? await runDenoMain(payloadBytes, config.messages, config.warmup, config.iterations, "binary", config.restarts, config.unsafeStreamMemory)
                    : {};
                const denoOutJson = config.transferModes.includes("json")
                    ? await runDenoMain(payloadBytes, config.messages, config.warmup, config.iterations, "json", config.restarts, config.unsafeStreamMemory)
                    : {};
                const denoOutString = config.transferModes.includes("string")
                    ? await runDenoMain(payloadBytes, config.messages, config.warmup, config.iterations, "string", config.restarts, config.unsafeStreamMemory)
                    : {};
                for (const s of selectedScenarios.filter((x) => x.main === "Deno")) {
                    if (config.transferModes.includes("binary")) {
                        const speed = (denoOut as Record<string, number>)[s.key];
                        if (speed == null) console.log(`skip: ${s.label} (missing result from deno runtime)`);
                        else {
                            results.set(s.key, speed);
                            console.log(`done: ${s.label} -> ${fmtMbps(speed)}`);
                        }
                    }
                    if (config.transferModes.includes("json")) {
                        const jsonSpeed = (denoOutJson as Record<string, number>)[s.key];
                        if (jsonSpeed == null) console.log(`skip: ${s.label} (json result missing from deno runtime)`);
                        else {
                            jsonResults.set(s.key, jsonSpeed);
                            console.log(`done: ${s.label} (json) -> ${fmtMbps(jsonSpeed)}`);
                        }
                    }
                    if (config.transferModes.includes("string")) {
                        const stringSpeed = (denoOutString as Record<string, number>)[s.key];
                        if (stringSpeed == null) console.log(`skip: ${s.label} (string result missing from deno runtime)`);
                        else {
                            stringResults.set(s.key, stringSpeed);
                            console.log(`done: ${s.label} (string) -> ${fmtMbps(stringSpeed)}`);
                        }
                    }
                }
            }
        }

        if (config.transferModes.includes("binary")) printTable("Binary Transfer", selectedScenarios, results);
        if (config.transferModes.includes("json")) printTable("JSON Transfer", selectedScenarios, jsonResults);
        if (config.transferModes.includes("string")) printTable("String Transfer", selectedScenarios, stringResults);
    }
}

main().catch((err) => {
    console.error("ipc bandwidth bench failed:", err);
    process.exitCode = 1;
});
