import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        console: {
            log: (...args: unknown[]) => console.log("[worker log]", ...args),
            error: (...args: unknown[]) => console.error("[worker error]", ...args),
            warn: false,
        },
    });

    try {
        await worker.eval(`
            console.log("hello", { x: 1 });
            console.warn("this is dropped");
            console.error("something happened");
        `);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
