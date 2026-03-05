import { DenoWorker } from "../src/index";
import { randomUUID } from "node:crypto";

function toText(chunks: Uint8Array[]): string {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
}

async function runRoundTrip(
    label: string,
    key: string | undefined,
    requestText: string,
    responseText: string,
) {
    const worker = new DenoWorker();
    try {
        const finalKey = key ?? randomUUID();
        const duplex = await worker.stream.connect(finalKey);

        const workerTask = worker.eval(`
            async (key, responseText) => {
                const inStream = await hostStreams.accept(String(key) + "::h2w");
                const chunks = [];
                for await (const c of inStream) chunks.push(c);
                const total = chunks.reduce((n, c) => n + c.byteLength, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { out.set(c, off); off += c.byteLength; }
                const requestText = new TextDecoder().decode(out);

                const outStream = hostStreams.create(String(key) + "::w2h");
                await outStream.write(new TextEncoder().encode(responseText));
                await outStream.close();
                return requestText;
            }
        `, { args: [finalKey, responseText] });

        await new Promise<void>((resolve, reject) => {
            duplex.end(Buffer.from(requestText), (err?: Error | null) => (err ? reject(err) : resolve()));
        });

        const chunks: Uint8Array[] = [];
        for await (const chunk of duplex) chunks.push(chunk as Uint8Array);
        const receivedInWorker = String(await workerTask);

        const receivedOnHost = toText(chunks);

        console.log(`[${label}] stream key:`, finalKey);
        console.log(`[${label}] worker received:`, receivedInWorker);
        console.log(`[${label}] host received:`, receivedOnHost);
    } finally {
        await worker.close({ force: true });
    }
}

async function runGeneratedKeyExample() {
    await runRoundTrip("generated", undefined, "ping", "pong");
}

async function runStaticKeyExample() {
    await runRoundTrip("static", "stream-static-key", "ping-static", "pong-static");
}

async function main() {
    await runGeneratedKeyExample();
    await runStaticKeyExample();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
