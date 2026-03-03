import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        limits: {
            maxEvalMs: 50,
            maxMemoryBytes: 64 * 1024 * 1024,
        },
    });

    try {
        await worker.eval("1 + 1");

        try {
            await worker.eval("while (true) {}");
        } catch (err) {
            console.log("timed out as expected:", String(err));
        }

        const ok = await worker.eval("40 + 2");
        console.log("after timeout:", ok);
    } finally {
        await worker.close({ force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
