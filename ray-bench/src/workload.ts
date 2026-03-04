import type { RenderResult, RenderTask } from "./types";

export function buildTasks(width: number, height: number, tileHeight: number): RenderTask[] {
    const tasks: RenderTask[] = [];
    let id = 0;
    for (let y0 = 0; y0 < height; y0 += tileHeight) {
        const h = Math.min(tileHeight, height - y0);
        tasks.push({ id, x0: 0, y0, width, height: h, imageWidth: width, imageHeight: height });
        id += 1;
    }
    return tasks;
}

export function computeTask(task: RenderTask): RenderResult {
    const spheres = [
        { x: -0.7, y: 0.1, z: 2.3, r: 0.65, cr: 1.0, cg: 0.4, cb: 0.2 },
        { x: 0.75, y: -0.2, z: 2.8, r: 0.8, cr: 0.2, cg: 0.8, cb: 0.95 },
        { x: 0.0, y: -1001.2, z: 3.0, r: 1000.0, cr: 0.75, cg: 0.74, cb: 0.72 },
    ];

    let checksum = 2166136261 >>> 0;
    const invW = 1 / task.imageWidth;
    const invH = 1 / task.imageHeight;
    const fov = Math.tan((55 * Math.PI) / 360);
    const aspect = task.imageWidth / task.imageHeight;
    const lightX = -0.6;
    const lightY = 0.75;
    const lightZ = -0.2;

    for (let py = task.y0; py < task.y0 + task.height; py += 1) {
        for (let px = task.x0; px < task.x0 + task.width; px += 1) {
            let r = 0;
            let g = 0;
            let b = 0;

            for (let sy = 0; sy < 2; sy += 1) {
                for (let sx = 0; sx < 2; sx += 1) {
                    const u = (((px + (sx + 0.5) * 0.5) * invW) * 2 - 1) * aspect * fov;
                    const v = (1 - ((py + (sy + 0.5) * 0.5) * invH) * 2) * fov;
                    const len = Math.hypot(u, v, 1);
                    const dx = u / len;
                    const dy = v / len;
                    const dz = 1 / len;

                    let tMin = Number.POSITIVE_INFINITY;
                    let hit = -1;

                    for (let i = 0; i < spheres.length; i += 1) {
                        const s = spheres[i];
                        const ox = -s.x;
                        const oy = -s.y;
                        const oz = -3 - s.z;
                        const bq = 2 * (dx * ox + dy * oy + dz * oz);
                        const cq = ox * ox + oy * oy + oz * oz - s.r * s.r;
                        const disc = bq * bq - 4 * cq;
                        if (disc <= 0) continue;
                        const root = Math.sqrt(disc);
                        const t0 = (-bq - root) * 0.5;
                        if (t0 > 1e-4 && t0 < tMin) {
                            tMin = t0;
                            hit = i;
                        }
                    }

                    if (hit >= 0) {
                        const s = spheres[hit];
                        const hx = dx * tMin;
                        const hy = dy * tMin;
                        const hz = -3 + dz * tMin;

                        let nx = (hx - s.x) / s.r;
                        let ny = (hy - s.y) / s.r;
                        let nz = (hz - s.z) / s.r;
                        const nLen = Math.hypot(nx, ny, nz);
                        nx /= nLen;
                        ny /= nLen;
                        nz /= nLen;

                        const ndl = Math.max(0, nx * lightX + ny * lightY + nz * lightZ);
                        const rim = Math.max(0, 1 - Math.max(0, nx * -dx + ny * -dy + nz * -dz));
                        const ambient = 0.18;
                        const shade = ambient + ndl * 0.9 + rim * 0.12;

                        r += Math.min(1, s.cr * shade);
                        g += Math.min(1, s.cg * shade);
                        b += Math.min(1, s.cb * shade);
                    } else {
                        const t = 0.5 * (dy + 1);
                        r += 0.15 * (1 - t) + 0.65 * t;
                        g += 0.22 * (1 - t) + 0.72 * t;
                        b += 0.35 * (1 - t) + 0.97 * t;
                    }
                }
            }

            const rr = Math.max(0, Math.min(255, (r * 0.25) * 255)) | 0;
            const gg = Math.max(0, Math.min(255, (g * 0.25) * 255)) | 0;
            const bb = Math.max(0, Math.min(255, (b * 0.25) * 255)) | 0;

            checksum ^= ((rr << 16) | (gg << 8) | bb) >>> 0;
            checksum = Math.imul(checksum, 16777619) >>> 0;
        }
    }

    return {
        id: task.id,
        checksum,
        pixels: task.width * task.height,
    };
}

export function mergeChecksums(results: RenderResult[]): number {
    let acc = 0x811c9dc5;
    for (const r of results) {
        acc ^= r.checksum >>> 0;
        acc = Math.imul(acc, 16777619) >>> 0;
        acc ^= r.pixels >>> 0;
        acc = Math.imul(acc, 16777619) >>> 0;
    }
    return acc >>> 0;
}

export function groupTasksByWorker(tasks: RenderTask[], workerCount: number): RenderTask[][] {
    const out = Array.from({ length: workerCount }, () => [] as RenderTask[]);
    for (let i = 0; i < tasks.length; i += 1) out[i % workerCount].push(tasks[i]);
    return out;
}

export function chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export const UINT32 = 4;
const TASK_WORDS = 7;
const RESULT_WORDS = 3;

export function encodeTaskBatch(tasks: RenderTask[]): Uint8Array {
    const bodyBytes = (1 + tasks.length * TASK_WORDS) * UINT32;
    const frameBytes = UINT32 + bodyBytes;
    const out = new Uint8Array(frameBytes);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let off = 0;
    dv.setUint32(off, bodyBytes, true);
    off += UINT32;
    dv.setUint32(off, tasks.length, true);
    off += UINT32;
    for (const t of tasks) {
        dv.setUint32(off, t.id >>> 0, true); off += UINT32;
        dv.setUint32(off, t.x0 >>> 0, true); off += UINT32;
        dv.setUint32(off, t.y0 >>> 0, true); off += UINT32;
        dv.setUint32(off, t.width >>> 0, true); off += UINT32;
        dv.setUint32(off, t.height >>> 0, true); off += UINT32;
        dv.setUint32(off, t.imageWidth >>> 0, true); off += UINT32;
        dv.setUint32(off, t.imageHeight >>> 0, true); off += UINT32;
    }
    return out;
}

export function decodeResultBatch(frame: Uint8Array): RenderResult[] {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let off = 0;
    const count = dv.getUint32(off, true);
    off += UINT32;
    const out: RenderResult[] = [];
    for (let i = 0; i < count; i += 1) {
        out.push({
            id: dv.getUint32(off, true),
            checksum: dv.getUint32(off + UINT32, true) >>> 0,
            pixels: dv.getUint32(off + UINT32 * 2, true),
        });
        off += RESULT_WORDS * UINT32;
    }
    return out;
}

export async function* decodeFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    let buffer = new Uint8Array(0);
    for await (const chunk of chunks) {
        if (chunk.byteLength === 0) continue;
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

export function packTask(task: RenderTask): Uint32Array {
    return new Uint32Array([
        task.id >>> 0,
        task.x0 >>> 0,
        task.y0 >>> 0,
        task.width >>> 0,
        task.height >>> 0,
        task.imageWidth >>> 0,
        task.imageHeight >>> 0,
    ]);
}

export function formatMs(ms: number): string {
    return `${ms.toFixed(1)} ms`;
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
}

export function denoBootstrapScript(): string {
    return `\nglobalThis.__computeTask = ${computeTask.toString()};\n`;
}
