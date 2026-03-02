import { DenoDirector } from "../src/index";

async function main() {
    const director = new DenoDirector({
        template: {
            workerOptions: {
                maxMemoryBytes: 128 * 1024 * 1024,
                maxEvalMs: 500,
            },
        },
    });

    const runtimeA = await director.start({
        label: "tenant-a",
        tags: ["demo", "A"],
        globals: { TENANT: "A" },
    });

    const runtimeB = await director.start({
        label: "tenant-b",
        tags: ["demo", "B"],
        globals: { TENANT: "B" },
    });

    try {
        const a = await runtimeA.eval("`hello ${TENANT}`");
        const b = await runtimeB.eval("`hello ${TENANT}`");
        console.log(a, b);
        console.log("demo runtimes:", director.list({ tag: "demo" }).length);
    } finally {
        await director.stopAll();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
