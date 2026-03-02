import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker();
    try {
        const asyncResult = await worker.eval("1 + 2 + 3");
        const syncResult = worker.evalSync("40 + 2");

        console.log("eval:", asyncResult);
        console.log("evalSync:", syncResult);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
