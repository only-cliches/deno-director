import { DenoWorker } from "../src/index";

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
    uploadKey: string | undefined,
    downloadKey: string,
    uploadText: string,
    downloadText: string,
) {
    const worker = new DenoWorker();
    try {
        const upload = uploadKey ? worker.stream.create(uploadKey) : worker.stream.create();
        const finalUploadKey = upload.getKey();

        const workerTask = worker.eval(`
            async (uploadKey, downloadKey, downloadText) => {
                const inStream = await hostStreams.accept(uploadKey);
                const chunks = [];
                for await (const c of inStream) chunks.push(c);
                const total = chunks.reduce((n, c) => n + c.byteLength, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { out.set(c, off); off += c.byteLength; }
                const uploadText = new TextDecoder().decode(out);

                const outStream = hostStreams.create(downloadKey);
                await outStream.write(new TextEncoder().encode(downloadText));
                await outStream.close();
                return uploadText;
            }
        `, { args: [finalUploadKey, downloadKey, downloadText] });

        await upload.write(new TextEncoder().encode(uploadText));
        await upload.close();

        const reader = await worker.stream.accept(downloadKey);
        const chunks: Uint8Array[] = [];
        for await (const chunk of reader) chunks.push(chunk);
        const receivedOnWorker = String(await workerTask);

        const receivedOnHost = toText(chunks);

        console.log(`[${label}] upload key:`, finalUploadKey);
        console.log(`[${label}] worker received:`, receivedOnWorker);
        console.log(`[${label}] host received:`, receivedOnHost);
    } finally {
        await worker.close({ force: true });
    }
}

async function runGeneratedKeyExample() {
    const downloadKey = crypto.randomUUID();
    await runRoundTrip("generated", undefined, downloadKey, "ping", "pong");
}

async function runStaticKeyExample() {
    const uploadKey = "upload-static-key";
    const downloadKey = "download-static-key";
    await runRoundTrip("static", uploadKey, downloadKey, "ping-static", "pong-static");
}

async function main() {
    await runGeneratedKeyExample();
    await runStaticKeyExample();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
