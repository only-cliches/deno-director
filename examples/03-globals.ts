import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker();
    try {
        await worker.setGlobal("APP_NAME", "deno-director");
        await worker.setGlobal("double", (x: number) => x * 2);

        const out = await worker.eval(`
            ({
                name: APP_NAME,
                doubled: double(21)
            })
        `);

        console.log(out);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
