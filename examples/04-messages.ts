import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker();

    worker.on("message", (msg) => {
        console.log("host received:", msg);
    });

    try {
        await worker.eval(`
            on("message", (msg) => {
                hostPostMessage({ echo: msg, from: "worker" });
            });
        `);

        worker.postMessage({ hello: "from host" });

        await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
